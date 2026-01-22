// ,---@>
//  W-W'
// LAMB GRID - Spatial Grid / Cellular Automata Simulation
// cc -o lamb_grid lamb_grid.c lamb_lib.c -lm
#include "lamb.h"

// ============================================================================
// SPATIAL GRID SYSTEM (Cellular Automata + Lambda Calculus)
// ============================================================================

// Global active grid (shared with lamb_view.c when in library mode)
#ifdef LAMB_LIBRARY_MODE
Grid active_grid = {0};  // Non-static so lamb_view.c can use it
#else
static Grid active_grid = {0};
#endif

// ============================================================================
// GC FUNCTION (with grid marking)
// ============================================================================

void gc(Expr_Index root, Bindings bindings)
{
    for (size_t i = 0; i < GC.gens[GC.gen_cur].count; ++i) {
        Expr_Index expr = GC.gens[GC.gen_cur].items[i];
        expr_slot(expr).visited = false;
    }

    gc_mark(root);
    for (size_t i = 0; i < bindings.count; ++i) {
        gc_mark(bindings.items[i].body);
    }
    
    // Mark all expressions in the active grid to prevent GC from sweeping them
    if (active_grid.cells) {
        int total = active_grid.width * active_grid.height;
        for (int i = 0; i < total; ++i) {
            if (active_grid.cells[i].occupied) {
                gc_mark(active_grid.cells[i].atom);
            }
        }
    }

    size_t next = 1 - GC.gen_cur;
    GC.gens[next].count = 0;
    for (size_t i = 0; i < GC.gens[GC.gen_cur].count; ++i) {
        Expr_Index expr = GC.gens[GC.gen_cur].items[i];
        if (expr_slot(expr).visited) {
            da_append(&GC.gens[next], expr);
        } else {
            free_expr(expr);
        }
    }
    GC.gen_cur = next;
}

// Compact GC slots to reclaim memory and improve cache locality
// Call this periodically when slot fragmentation is high
void gc_compact(Bindings *bindings) {
    if (GC.slots.count == 0) return;
    
    // Only compact if fragmentation is significant (>50% dead space)
    size_t live_count = GC.slots.count - GC.dead.count;
    if (GC.dead.count < GC.slots.count / 2) return;
    
    // Build remapping table: old_index -> new_index
    size_t *remap = malloc(GC.slots.count * sizeof(size_t));
    for (size_t i = 0; i < GC.slots.count; ++i) {
        remap[i] = (size_t)-1;  // Mark as unmapped
    }
    
    // Allocate new compact slots array
    Expr *new_slots = malloc(live_count * sizeof(Expr));
    size_t new_idx = 0;
    
    // Copy live expressions and build remap
    for (size_t i = 0; i < GC.slots.count; ++i) {
        if (GC.slots.items[i].live) {
            new_slots[new_idx] = GC.slots.items[i];
            remap[i] = new_idx;
            new_idx++;
        }
    }
    
    // Update all internal expression references
    for (size_t i = 0; i < new_idx; ++i) {
        Expr *e = &new_slots[i];
        switch (e->kind) {
        case EXPR_FUN:
            if (remap[e->as.fun.body.unwrap] != (size_t)-1) {
                e->as.fun.body.unwrap = remap[e->as.fun.body.unwrap];
            }
            break;
        case EXPR_APP:
            if (remap[e->as.app.lhs.unwrap] != (size_t)-1) {
                e->as.app.lhs.unwrap = remap[e->as.app.lhs.unwrap];
            }
            if (remap[e->as.app.rhs.unwrap] != (size_t)-1) {
                e->as.app.rhs.unwrap = remap[e->as.app.rhs.unwrap];
            }
            break;
        default:
            break;
        }
    }
    
    // Update grid cell references
    if (active_grid.cells) {
        int total = active_grid.width * active_grid.height;
        for (int i = 0; i < total; ++i) {
            if (active_grid.cells[i].occupied) {
                size_t old_idx = active_grid.cells[i].atom.unwrap;
                if (remap[old_idx] != (size_t)-1) {
                    active_grid.cells[i].atom.unwrap = remap[old_idx];
                }
            }
        }
    }
    
    // Update bindings references
    if (bindings) {
        for (size_t i = 0; i < bindings->count; ++i) {
            size_t old_idx = bindings->items[i].body.unwrap;
            if (remap[old_idx] != (size_t)-1) {
                bindings->items[i].body.unwrap = remap[old_idx];
            }
        }
    }
    
    // Update GC generation arrays
    for (int g = 0; g < 2; ++g) {
        size_t write_idx = 0;
        for (size_t i = 0; i < GC.gens[g].count; ++i) {
            size_t old_idx = GC.gens[g].items[i].unwrap;
            if (remap[old_idx] != (size_t)-1) {
                GC.gens[g].items[write_idx].unwrap = remap[old_idx];
                write_idx++;
            }
        }
        GC.gens[g].count = write_idx;
    }
    
    // Swap in new slots array
    free(GC.slots.items);
    GC.slots.items = new_slots;
    GC.slots.count = new_idx;
    GC.slots.capacity = live_count;
    
    // Clear dead list (all slots are now live and compact)
    GC.dead.count = 0;
    
    free(remap);
}

// ============================================================================
// GRID FUNCTIONS
// ============================================================================

void grid_init(Grid *g, int w, int h) {
    if (g->cells) free(g->cells);
    g->width = w;
    g->height = h;
    g->steps = 0;
    g->reactions_success = 0;
    g->reactions_diverged = 0;
    g->movements = 0;
    g->deaths_age = 0;
    g->cosmic_spawns = 0;
    g->cells = calloc((size_t)(w * h), sizeof(Cell));
    assert(g->cells != NULL);
}

void grid_free(Grid *g) {
    if (g->cells) {
        free(g->cells);
        g->cells = NULL;
    }
    g->width = 0;
    g->height = 0;
    g->steps = 0;
}

// Toroidal coordinate mapping
int grid_idx(Grid *g, int x, int y) {
    // Wrap x
    int wx = x % g->width;
    if (wx < 0) wx += g->width;
    // Wrap y
    int wy = y % g->height;
    if (wy < 0) wy += g->height;
    return wy * g->width + wx;
}

// Populate grid randomly with rich combinators
void grid_seed(Grid *g, int count, int depth) {
    int placed = 0;
    int attempts = 0;
    int max_attempts = count * 10;
    
    while (placed < count && attempts < max_attempts) {
        int x = rand() % g->width;
        int y = rand() % g->height;
        int idx = grid_idx(g, x, y);
        
        if (!g->cells[idx].occupied) {
            // Generate a rich combinator, retry if identity
            Expr_Index e;
            int sub_attempts = 0;
            do {
                e = generate_rich_combinator(0, depth, NULL, 0);
                sub_attempts++;
            } while (is_identity(e) && sub_attempts < 5);

            g->cells[idx].atom = e;
            g->cells[idx].occupied = true;
            g->cells[idx].age = 0;
            g->cells[idx].generation = 0;
            g->cells[idx].cache_valid = false;  // Invalidate cache for new cell
            placed++;
        }
        attempts++;
    }
}

// Count occupied cells
int grid_population(Grid *g) {
    int count = 0;
    int total = g->width * g->height;
    for (int i = 0; i < total; ++i) {
        if (g->cells[i].occupied) count++;
    }
    return count;
}

// The heart of the spatial simulation - METABOLIC MODEL
// 1. Catalytic: A applies to B -> C. A survives, B becomes C.
// 2. Aging: Every cell has age, dies at MAX_AGE.
// 3. Cosmic Rays: Spontaneous generation in empty slots.
void grid_step(Grid *g, Bindings bindings, size_t eval_steps, size_t max_mass) {
    int total = g->width * g->height;
    
    // 1. Create a shuffled list of indices (Fisher-Yates) - Asynchronous Cellular Automata
    int *indices = malloc((size_t)total * sizeof(int));
    for (int i = 0; i < total; ++i) indices[i] = i;
    
    // Fisher-Yates shuffle
    for (int i = total - 1; i > 0; i--) {
        int j = rand() % (i + 1);
        int temp = indices[i];
        indices[i] = indices[j];
        indices[j] = temp;
    }

    // 2. Process cells in shuffled order
    for (int i = 0; i < total; ++i) {
        int curr_idx = indices[i];
        
        // --- ENTROPY & DEATH (Aging) ---
        if (g->cells[curr_idx].occupied) {
            g->cells[curr_idx].age++;
            
            // Death from old age
            if (g->cells[curr_idx].age > MAX_AGE) {
                g->cells[curr_idx].occupied = false;
                g->cells[curr_idx].cache_valid = false;  // Invalidate cache
                g->deaths_age++;
                continue; // Slot is now empty, skip to next
            }
        }
        
        // --- COSMIC RAYS (Spontaneous Generation) ---
        if (!g->cells[curr_idx].occupied) {
            if ((rand() % 100000) < COSMIC_RAY_RATE) {
                g->cells[curr_idx].atom = generate_rich_combinator(0, 3, NULL, 0);
                g->cells[curr_idx].occupied = true;
                g->cells[curr_idx].age = 0;
                g->cells[curr_idx].generation = 0;
                g->cells[curr_idx].cache_valid = false;  // Invalidate cache
                g->cosmic_spawns++;
            }
            continue; // Empty cell processed, move on
        }

        // --- PHYSICS (Movement or Interaction) ---
        
        // Calculate 2D coords from linear index
        int cx = curr_idx % g->width;
        int cy = curr_idx / g->width;

        // Pick a random direction: 0:N, 1:E, 2:S, 3:W
        int dir = rand() % 4;
        int tx = cx, ty = cy;
        
        switch(dir) {
            case 0: ty--; break; // N
            case 1: tx++; break; // E
            case 2: ty++; break; // S
            case 3: tx--; break; // W
        }
        
        int target_idx = grid_idx(g, tx, ty);

        // RULE 1: MOVEMENT - if target is empty, random walk
        if (!g->cells[target_idx].occupied) {
            g->cells[target_idx] = g->cells[curr_idx];
            g->cells[curr_idx].occupied = false;
            g->cells[curr_idx].cache_valid = false;  // Source cell is now empty
            // Target inherits cache from source (no recomputation needed)
            g->movements++;
        } 
        // RULE 2: CATALYTIC INTERACTION - A applies to B, A survives, B becomes result
        else {
            Expr_Index A = g->cells[curr_idx].atom;
            Expr_Index B = g->cells[target_idx].atom;
            Expr_Index result;

            // Run bounded evaluation
            Eval_Result res = eval_bounded(app(A, B), &result, eval_steps, max_mass);

            if (res == EVAL_DONE) {
                // Successful catalysis: A survives, B transforms into result
                // A stays where it is (catalytic) - rejuvenated by successful reaction
                // B becomes the result (mutation)
                g->cells[curr_idx].age = 0;  // Catalyst rejuvenated by successful work
                g->cells[curr_idx].cache_valid = false;  // Age changed, invalidate
                g->cells[target_idx].atom = result;
                g->cells[target_idx].age = 0;  // Rejuvenate: it's a new creature
                g->cells[target_idx].generation++;
                g->cells[target_idx].cache_valid = false;  // Invalidate cache - new expression
                g->reactions_success++;
            } else {
                // Divergence/Explosion: The victim B dies from instability
                // A survives (it was the catalyst)
                g->cells[target_idx].occupied = false;
                g->cells[target_idx].cache_valid = false;  // Invalidate cache
                g->reactions_diverged++;
            }
        }
    }

    free(indices);
    g->steps++;
    
    // Periodic GC
    if (g->steps % 10 == 0) {
        gc(var(symbol("_dummy")), bindings);
        
        // Compact memory if slot count gets too high (>10K slots with >50% dead)
        if (g->steps % 100 == 0 && gc_slot_count() > 10000) {
            gc_compact(NULL);  // bindings are empty in view mode
        }
    }
}

// Analyze unique species in the grid (returns unique count)
size_t grid_analyze(Grid *g, bool verbose) {
    int total = g->width * g->height;
    int pop = grid_population(g);
    
    if (pop == 0) {
        if (verbose) printf("Grid is empty.\n");
        return 0;
    }
    
    // Snapshot all expressions as strings
    char **snapshots = malloc((size_t)pop * sizeof(char*));
    int snap_idx = 0;
    for (int i = 0; i < total && snap_idx < pop; ++i) {
        if (g->cells[i].occupied) {
            snapshots[snap_idx++] = expr_to_string(g->cells[i].atom);
        }
    }
    
    // Sort to group identical species
    qsort(snapshots, (size_t)pop, sizeof(char*), compare_strings);
    
    // Count unique
    size_t unique = 1;
    size_t max_freq = 1;
    size_t cur_freq = 1;
    char *most_common = snapshots[0];
    
    for (int i = 1; i < pop; ++i) {
        if (strcmp(snapshots[i], snapshots[i-1]) != 0) {
            if (cur_freq > max_freq) {
                max_freq = cur_freq;
                most_common = snapshots[i-1];
            }
            unique++;
            cur_freq = 1;
        } else {
            cur_freq++;
        }
    }
    if (cur_freq > max_freq) {
        max_freq = cur_freq;
        most_common = snapshots[pop-1];
    }
    
    if (verbose) {
        printf("Population:  %d\n", pop);
        printf("Unique:      %zu (%.2f%% diversity)\n", unique, ((float)unique / pop) * 100.0f);
        printf("Dominant:    %s (%zu, %.2f%%)\n", most_common, max_freq, ((float)max_freq / pop) * 100.0f);
    }
    
    // Cleanup
    for (int i = 0; i < pop; ++i) free(snapshots[i]);
    free(snapshots);
    
    return unique;
}

// ASCII renderer for the grid - Mass-based visualization
void grid_render(Grid *g, bool clear_screen) {
    if (clear_screen) {
        printf("\033[H\033[J"); // ANSI clear screen
    }
    printf("--- STEP %ld | Pop: %d | React: %ld | Div: %ld | Deaths: %ld | Spawns: %ld ---\n", 
           g->steps, grid_population(g), g->reactions_success, g->reactions_diverged, 
           g->deaths_age, g->cosmic_spawns);
    
    for (int y = 0; y < g->height; ++y) {
        for (int x = 0; x < g->width; ++x) {
            int idx = y * g->width + x;
            if (!g->cells[idx].occupied) {
                printf(". ");
            } else {
                size_t mass = expr_mass(g->cells[idx].atom);
                char c = '?';
                
                // Visualization based on complexity (mass)
                if (mass < 5)       c = 'o';  // Simple atom
                else if (mass < 15) c = '8';  // Complex molecule
                else if (mass < 50) c = '#';  // Large structure
                else                c = '@';  // Massive (potentially unstable)
                
                // If very old (>80% of MAX_AGE), show as dim/dying
                if (g->cells[idx].age > (MAX_AGE * 8 / 10)) {
                    c = ',';  // Dying cell
                }
                
                printf("%c ", c);
            }
        }
        printf("\n");
    }
}

// Export grid state to a CSV file for logging
bool grid_export_log(Grid *g, const char *filename, bool append) {
    FILE *f = fopen(filename, append ? "a" : "w");
    if (!f) return false;
    
    if (!append) {
        fprintf(f, "step,population,unique_species,reactions_success,reactions_diverged,movements,deaths_age,cosmic_spawns\n");
    }
    
    size_t unique = grid_analyze(g, false);
    fprintf(f, "%ld,%d,%zu,%ld,%ld,%ld,%ld,%ld\n", 
            g->steps, grid_population(g), unique, 
            g->reactions_success, g->reactions_diverged, g->movements,
            g->deaths_age, g->cosmic_spawns);
    
    fclose(f);
    return true;
}

// Save grid soup to a .lamb file
bool grid_save_soup(Grid *g, const char *filename) {
    FILE *f = fopen(filename, "w");
    if (!f) return false;
    
    fprintf(f, "// LAMB_GRID_SOUP_V1\n");
    fprintf(f, "// step=%ld\n", g->steps);
    fprintf(f, "// width=%d height=%d\n", g->width, g->height);
    
    String_Builder sb = {0};
    int soup_idx = 0;
    int total = g->width * g->height;
    
    for (int i = 0; i < total; ++i) {
        if (g->cells[i].occupied) {
            sb.count = 0;
            expr_display_no_tags(g->cells[i].atom, &sb);
            sb_append_null(&sb);
            fprintf(f, "soup_%d = %s;\n", soup_idx++, sb.items);
        }
    }
    
    free(sb.items);
    fclose(f);
    return true;
}

// ============================================================================
// MAIN
// ============================================================================

#ifndef LAMB_LIBRARY_MODE
int main(int argc, char **argv)
{
    static char buffer[1024];
    static Commands commands = {0};
    static Bindings bindings = {0};
    static Lexer l = {0};

#ifndef _WIN32
    struct sigaction act = {0};
    act.sa_handler = ctrl_c_handler;
    sigaction(SIGINT, &act, NULL);
#endif // _WIN32

    srand((unsigned)time(NULL));

    const char *editor  = getenv("LAMB_EDITOR");
    if (!editor) editor = getenv("EDITOR");
    if (!editor) editor = "vi";

    char *active_file_path = NULL;

    if (argc == 2) {
        active_file_path = copy_string(argv[1]);
    } else if (argc > 2) {
        fprintf(stderr, "ERROR: only a single active file is support right now\n");
        return 1;
    }

    if (active_file_path) {
        create_bindings_from_file(active_file_path, &bindings);
    }

    printf(",---@>\n");
    printf(" W-W' [GRID MODE]\n");
    printf("Enter :help for more info\n");
    for (;;) {
again:
        printf("@> ");
        fflush(stdout);
        if (!fgets(buffer, sizeof(buffer), stdin)) {
            if (feof(stdin)) goto quit;
            printf("\n");
            goto again;
        }
        const char *source = buffer;

        lexer_init(&l, source, strlen(source), NULL);

        if (!lexer_peek(&l)) goto again;
        if (l.token == TOKEN_END) goto again;
        if (l.token == TOKEN_COLON) {
            if (!lexer_next(&l)) goto again;
            if (!lexer_expect(&l, TOKEN_NAME)) goto again;
            commands.count = 0;
            if (command(&commands, l.string.items, "load", "[path]", "Load/reload bindings from a file.")) {
                replace_active_file_path_from_lexer_if_not_empty(l, &active_file_path);
                if (active_file_path == NULL) {
                    fprintf(stderr, "ERROR: No active file to reload from. Do `:load <path>`.\n");
                    goto again;
                }

                bindings.count = 0;
                create_bindings_from_file(active_file_path, &bindings);
                goto again;
            }
            if (command(&commands, l.string.items, "save", "[path]", "Save current bindings to a file.")) {
                replace_active_file_path_from_lexer_if_not_empty(l, &active_file_path);
                if (active_file_path == NULL) {
                    fprintf(stderr, "ERROR: No active file to save to. Do `:save <path>`.\n");
                    goto again;
                }

                static String_Builder sb = {0};
                sb.count = 0;
                for (size_t i = 0; i < bindings.count; ++i) {
                    assert(bindings.items[i].name.tag == 0);
                    sb_appendf(&sb, "%s = ", bindings.items[i].name.label);
                    expr_display(bindings.items[i].body, &sb);
                    sb_appendf(&sb, ";\n");
                }

                int exists = file_exists(active_file_path);
                if (exists < 0) goto again;
                if (exists) {
                    printf("WARNING! This command will override the formatting of %s. Really save? [N/y] ", active_file_path);
                    fflush(stdout);
                    if (!fgets(buffer, sizeof(buffer), stdin)) {
                        if (feof(stdin)) goto quit;
                        printf("\n");
                        goto again;
                    }
                    if (*buffer != 'y' && *buffer != 'Y') goto again;
                }

                if (!write_entire_file(active_file_path, sb.items, sb.count)) goto again;
                printf("Saved all the bindings to %s\n", active_file_path);
                goto again;
            }
            if (command(&commands, l.string.items, "edit", "[path]", "Edit current active file. Reload it on exit.")) {
#ifdef _WIN32
                fprintf(stderr, "TODO: editing files is not implemented on Windows yet! Sorry!\n");
#else
                replace_active_file_path_from_lexer_if_not_empty(l, &active_file_path);
                if (active_file_path == NULL) {
                    fprintf(stderr, "ERROR: No active file to edit. Do `:edit <path>`.\n");
                    goto again;
                }

                static Cmd cmd = {0};
                cmd.count = 0;
                da_append(&cmd, editor);
                da_append(&cmd, active_file_path);
                if (cmd_run(&cmd)) {
                    bindings.count = 0;
                    create_bindings_from_file(active_file_path, &bindings);
                }
#endif // _WIN32
                goto again;
            }
            if (command(&commands, l.string.items, "list", "[names...]", "list the bindings")) {
                static String_Builder sb = {0};
                static struct {
                    const char **items;
                    size_t count;
                    size_t capacity;
                } args = {0};

                args.count = 0;
                if (!lexer_next(&l)) goto again;
                while (l.token == TOKEN_NAME) {
                    da_append(&args, intern_label(l.string.items));
                    if (!lexer_next(&l)) goto again;
                }
                if (l.token != TOKEN_END) {
                    report_unexpected(&l, TOKEN_NAME);
                    goto again;
                }

                if (args.count == 0) {
                    for (size_t i = 0; i < bindings.count; ++i) {
                        assert(bindings.items[i].name.tag == 0);
                        sb.count = 0;
                        sb_appendf(&sb, "%s = ", bindings.items[i].name.label);
                        expr_display(bindings.items[i].body, &sb);
                        sb_appendf(&sb, ";");
                        sb_append_null(&sb);
                        printf("%s\n", sb.items);
                    }
                    goto again;
                }

                for (size_t j = 0; j < args.count; ++j) {
                    const char *label = args.items[j];
                    bool found = false;
                    for (size_t i = 0; !found && i < bindings.count; ++i) {
                        assert(bindings.items[i].name.tag == 0);
                        if (bindings.items[i].name.label == label) {
                            sb.count = 0;
                            sb_appendf(&sb, "%s = ", bindings.items[i].name.label);
                            expr_display(bindings.items[i].body, &sb);
                            sb_appendf(&sb, ";");
                            sb_append_null(&sb);
                            printf("%s\n", sb.items);
                            found = true;
                        }
                    }
                    if (!found) {
                        fprintf(stderr, "ERROR: binding %s does not exist\n", label);
                        goto again;
                    }
                }

                goto again;
            }
            if (command(&commands, l.string.items, "delete", "<name>", "delete a binding by name")) {
                if (!lexer_expect(&l, TOKEN_NAME)) goto again;
                Symbol name = symbol(l.string.items);
                for (size_t i = 0; i < bindings.count; ++i) {
                    if (symbol_eq(bindings.items[i].name, name)) {
                        da_delete_at(&bindings, i);
                        printf("Deleted binding %s\n", name.label);
                        goto again;
                    }
                }
                printf("ERROR: binding %s was not found\n", name.label);
                goto again;
            }
            if (command(&commands, l.string.items, "debug", "<expr>", "Step debug the evaluation of an expression")) {
                Expr_Index expr;
                if (!parse_expr(&l, &expr)) goto again;
                if (!lexer_expect(&l, TOKEN_END)) goto again;
                for (size_t i = bindings.count; i > 0; --i) {
                    expr = replace(bindings.items[i-1].name, expr, bindings.items[i-1].body);
                }

                ctrl_c = 0;
                for (;;) {
                    if (ctrl_c) goto again;

                    printf("DEBUG: ");
                    trace_expr(expr);
                    printf("\n");

                    printf("-> ");
                    fflush(stdin);

                    if (!fgets(buffer, sizeof(buffer), stdin)) {
                        if (feof(stdin)) goto quit;
                        printf("\n");
                        goto again;
                    }

                    lexer_init(&l, buffer, strlen(buffer), NULL);
                    if (!lexer_next(&l)) goto again;
                    if (l.token == TOKEN_NAME) {
                        if (strcmp(l.string.items, "quit") == 0) goto again;
                    }

                    gc(expr, bindings);

                    Expr_Index expr1;
                    if (!eval1(expr, &expr1)) goto again;
                    if (expr.unwrap == expr1.unwrap) break;
                    expr = expr1;
                }

                goto again;
            }
            if (command(&commands, l.string.items, "grid", "<w> <h> <density%> <iterations> [depth] [steps] [logfile]", "Run 2D spatial simulation")) {
                int w = 30, h = 20;
                int density = 30;
                long iterations = 10000;
                int depth = 5;
                long max_steps = 100;
                long log_interval = 100;
                char log_filename[256] = "grid_log.csv";
                char soup_filename[256] = "grid_soup.lamb";
                
                // Parse width
                if (lexer_next(&l) && l.token == TOKEN_NAME) {
                    w = atoi(l.string.items);
                    if (w <= 0) w = 30;
                    
                    // Parse height
                    if (lexer_next(&l) && l.token == TOKEN_NAME) {
                        h = atoi(l.string.items);
                        if (h <= 0) h = 20;
                        
                        // Parse density
                        if (lexer_next(&l) && l.token == TOKEN_NAME) {
                            density = atoi(l.string.items);
                            if (density <= 0 || density > 100) density = 30;
                            
                            // Parse iterations
                            if (lexer_next(&l) && l.token == TOKEN_NAME) {
                                iterations = strtol(l.string.items, NULL, 10);
                                if (iterations <= 0) iterations = 10000;
                                
                                // Optional: depth
                                if (lexer_next(&l) && l.token == TOKEN_NAME) {
                                    depth = atoi(l.string.items);
                                    if (depth <= 0) depth = 5;
                                    
                                    // Optional: max_steps
                                    if (lexer_next(&l) && l.token == TOKEN_NAME) {
                                        max_steps = strtol(l.string.items, NULL, 10);
                                        if (max_steps <= 0) max_steps = 100;
                                        
                                        // Optional: log filename
                                        if (lexer_next(&l) && l.token == TOKEN_NAME) {
                                            size_t len = l.string.count < 240 ? l.string.count : 240;
                                            memcpy(log_filename, l.string.items, len);
                                            log_filename[len] = '\0';
                                            // Auto-append .csv if not present
                                            if (len < 4 || strcmp(&log_filename[len-4], ".csv") != 0) {
                                                strcat(log_filename, ".csv");
                                            }
                                            // Create soup filename from log filename
                                            strncpy(soup_filename, log_filename, 240);
                                            char *dot = strrchr(soup_filename, '.');
                                            if (dot) *dot = '\0';
                                            strcat(soup_filename, ".lamb");
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                
                // Silence unused variable warning
                UNUSED(log_interval);
                
                // Initialize the grid
                grid_init(&active_grid, w, h);
                int count = (w * h * density) / 100;
                
                printf("=== 2D SPATIAL SIMULATION ===\n");
                printf("Grid:        %dx%d (toroidal)\n", w, h);
                printf("Population:  %d cells (%d%% density)\n", count, density);
                printf("Iterations:  %ld\n", iterations);
                printf("Depth:       %d\n", depth);
                printf("Max Steps:   %ld\n", max_steps);
                printf("Log file:    %s\n", log_filename);
                printf("=============================\n\n");
                fflush(stdout);
                
                printf("Seeding grid with rich combinators...\n");
                grid_seed(&active_grid, count, depth);
                
                // Initial analysis
                printf("--- INITIAL STATE ---\n");
                grid_analyze(&active_grid, true);
                printf("---------------------\n\n");
                fflush(stdout);
                
                // Initialize log file
                grid_export_log(&active_grid, log_filename, false);
                
                printf("Running simulation (Ctrl+C to stop)...\n");
                fflush(stdout);
                
                ctrl_c = 0;
                for (long it = 0; it < iterations && !ctrl_c; ++it) {
                    grid_step(&active_grid, bindings, (size_t)max_steps, 2000);
                    
                    // Periodic logging
                    if ((it + 1) % 100 == 0) {
                        grid_export_log(&active_grid, log_filename, true);
                        printf(".");
                        fflush(stdout);
                    }
                    
                    // Check if grid is empty
                    if (grid_population(&active_grid) == 0) {
                        printf("\nGrid is empty! Simulation terminated.\n");
                        break;
                    }
                }
                
                if (ctrl_c) {
                    printf("\nSimulation interrupted by user.\n");
                }
                
                printf("\n=== SIMULATION COMPLETE ===\n");
                printf("Total steps: %ld\n", active_grid.steps);
                printf("Reactions:   %ld successful, %ld diverged\n", 
                       active_grid.reactions_success, active_grid.reactions_diverged);
                printf("Movements:   %ld\n", active_grid.movements);
                printf("Age deaths:  %ld\n", active_grid.deaths_age);
                printf("Cosmic rays: %ld spawns\n", active_grid.cosmic_spawns);
                printf("\n--- FINAL STATE ---\n");
                grid_analyze(&active_grid, true);
                printf("-------------------\n");
                
                // Save final soup
                if (grid_save_soup(&active_grid, soup_filename)) {
                    printf("Soup saved to: %s\n", soup_filename);
                }
                
                printf("Log saved to: %s\n", log_filename);
                fflush(stdout);
                
                goto again;
            }
            if (command(&commands, l.string.items, "grid_view", "[steps]", "Continue grid animation (ASCII)")) {
                long steps = 100;
                
                if (lexer_next(&l) && l.token == TOKEN_NAME) {
                    steps = strtol(l.string.items, NULL, 10);
                    if (steps <= 0) steps = 100;
                }
                
                if (!active_grid.cells || grid_population(&active_grid) == 0) {
                    printf("ERROR: No active grid. Run :grid or :gridv first.\n");
                    goto again;
                }
                
                printf("Running %ld steps with visual output (Ctrl+C to stop)...\n", steps);
                fflush(stdout);
                
                ctrl_c = 0;
                for (long i = 0; i < steps && !ctrl_c; ++i) {
                    grid_step(&active_grid, bindings, 100, 2000);
                    grid_render(&active_grid, true);
                    
                    #ifdef _WIN32
                    Sleep(100);
                    #else
                    usleep(100000);
                    #endif
                    
                    if (grid_population(&active_grid) == 0) {
                        printf("\nGrid is empty!\n");
                        break;
                    }
                }
                
                goto again;
            }
            if (command(&commands, l.string.items, "gridv", "<w> <h> <density%> <iterations> [delay_ms] [depth]", "Run visual 2D simulation")) {
                int w = 30, h = 20;
                int density = 30;
                long iterations = 10000;
                int delay_ms = 50;  // Render delay in milliseconds
                int depth = 5;
                long max_steps = 100;
                
                // Parse width
                if (lexer_next(&l) && l.token == TOKEN_NAME) {
                    w = atoi(l.string.items);
                    if (w <= 0) w = 30;
                    
                    // Parse height
                    if (lexer_next(&l) && l.token == TOKEN_NAME) {
                        h = atoi(l.string.items);
                        if (h <= 0) h = 20;
                        
                        // Parse density
                        if (lexer_next(&l) && l.token == TOKEN_NAME) {
                            density = atoi(l.string.items);
                            if (density <= 0 || density > 100) density = 30;
                            
                            // Parse iterations
                            if (lexer_next(&l) && l.token == TOKEN_NAME) {
                                iterations = strtol(l.string.items, NULL, 10);
                                if (iterations <= 0) iterations = 10000;
                                
                                // Optional: delay_ms
                                if (lexer_next(&l) && l.token == TOKEN_NAME) {
                                    delay_ms = atoi(l.string.items);
                                    if (delay_ms < 0) delay_ms = 50;
                                    
                                    // Optional: depth
                                    if (lexer_next(&l) && l.token == TOKEN_NAME) {
                                        depth = atoi(l.string.items);
                                        if (depth <= 0) depth = 5;
                                    }
                                }
                            }
                        }
                    }
                }
                
                // Initialize the grid
                grid_init(&active_grid, w, h);
                int count = (w * h * density) / 100;
                
                printf("=== 2D VISUAL SIMULATION ===\n");
                printf("Grid:        %dx%d (toroidal)\n", w, h);
                printf("Population:  %d cells (%d%% density)\n", count, density);
                printf("Iterations:  %ld\n", iterations);
                printf("Delay:       %d ms\n", delay_ms);
                printf("Depth:       %d\n", depth);
                printf("============================\n\n");
                printf("Seeding grid with rich combinators...\n");
                fflush(stdout);
                
                grid_seed(&active_grid, count, depth);
                
                printf("Press Ctrl+C to stop...\n");
                fflush(stdout);
                
                #ifndef _WIN32
                usleep(1000000);  // 1 second pause before starting
                #else
                Sleep(1000);
                #endif
                
                ctrl_c = 0;
                for (long it = 0; it < iterations && !ctrl_c; ++it) {
                    grid_step(&active_grid, bindings, (size_t)max_steps, 2000);
                    grid_render(&active_grid, true);
                    
                    if (delay_ms > 0) {
                        #ifdef _WIN32
                        Sleep(delay_ms);
                        #else
                        usleep((useconds_t)(delay_ms * 1000));
                        #endif
                    }
                    
                    // Check if grid is empty
                    if (grid_population(&active_grid) == 0) {
                        printf("\nGrid is empty! Simulation terminated at step %ld.\n", it + 1);
                        break;
                    }
                }
                
                if (ctrl_c) {
                    printf("\n\nSimulation paused by user at step %ld.\n", active_grid.steps);
                    printf("Use :grid_view to continue, or :grid_save <file> to save state.\n");
                }
                
                printf("\n--- FINAL STATE ---\n");
                printf("Reactions: %ld ok, %ld div | Deaths: %ld | Spawns: %ld\n",
                       active_grid.reactions_success, active_grid.reactions_diverged,
                       active_grid.deaths_age, active_grid.cosmic_spawns);
                grid_analyze(&active_grid, true);
                printf("-------------------\n");
                fflush(stdout);
                
                goto again;
            }
            if (command(&commands, l.string.items, "grid_save", "<filename>", "Save current grid to .lamb file")) {
                // Get filename
                while (l.cur.pos < l.count && isspace(l.content[l.cur.pos])) l.cur.pos++;
                const char *path_start = &l.content[l.cur.pos];
                size_t path_len = l.count - l.cur.pos;
                while (path_len > 0 && isspace(path_start[path_len - 1])) path_len--;
                
                if (path_len == 0) {
                    fprintf(stderr, "ERROR: :grid_save requires a filename\n");
                    goto again;
                }
                
                char *save_filename = copy_string_sized(path_start, path_len);
                
                if (!active_grid.cells || grid_population(&active_grid) == 0) {
                    printf("ERROR: No active grid to save.\n");
                    free(save_filename);
                    goto again;
                }
                
                if (grid_save_soup(&active_grid, save_filename)) {
                    printf("Grid saved to: %s (%d creatures)\n", save_filename, grid_population(&active_grid));
                } else {
                    printf("ERROR: Failed to save grid to %s\n", save_filename);
                }
                
                free(save_filename);
                goto again;
            }
            if (command(&commands, l.string.items, "ast", "<expr>", "print the AST of the expression")) {
                Expr_Index expr;
                if (!parse_expr(&l, &expr)) goto again;
                if (!lexer_expect(&l, TOKEN_END)) goto again;
                dump_expr_ast(expr);
                goto again;
            }
            if (command(&commands, l.string.items, "quit", "", "quit the REPL")) goto quit;
            if (command(&commands, l.string.items, "help", "", "print this help message")) {
                print_available_commands(&commands);
                goto again;
            }
            print_available_commands(&commands);
            printf("ERROR: unknown command `%s`\n", l.string.items);
            goto again;
        }

        Token_Kind a, b;
        Cur cur = l.cur; {
            if (!lexer_next(&l)) goto again;
            a = l.token;
            if (!lexer_next(&l)) goto again;
            b = l.token;
        } l.cur = cur;

        if (a == TOKEN_NAME && b == TOKEN_EQUALS) {
            if (!lexer_expect(&l, TOKEN_NAME)) goto again;
            Symbol name = symbol(l.string.items);
            if (!lexer_expect(&l, TOKEN_EQUALS)) goto again;
            Expr_Index body;
            if (!parse_expr(&l, &body)) goto again;
            if (!lexer_expect(&l, TOKEN_END)) goto again;
            create_binding(&bindings, name, body);
            goto again;
        }

        Expr_Index expr;
        if (!parse_expr(&l, &expr)) goto again;
        if (!lexer_expect(&l, TOKEN_END)) goto again;
        for (size_t i = bindings.count; i > 0; --i) {
            expr = replace(bindings.items[i-1].name, expr, bindings.items[i-1].body);
        }

        ctrl_c = 0;
        for (;;) {
            if (ctrl_c) {
                printf("Evaluation canceled by user.\n");
                goto again;
            }

            gc(expr, bindings);

            Expr_Index expr1;
            if (!eval1(expr, &expr1)) goto again;
            if (expr.unwrap == expr1.unwrap) break;
            expr = expr1;
        }

        printf("RESULT: ");
        trace_expr(expr);
        printf("\n");
    }
quit:

    return 0;
}
#endif // LAMB_LIBRARY_MODE

// Copyright 2025 Alexey Kutepov <reximkut@gmail.com>
//
// Permission is hereby granted, free of charge, to any person obtaining
// a copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to
// the following conditions:
//
// The above copyright notice and this permission notice shall be
// included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
// EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
// OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
