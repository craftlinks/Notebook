// ,---@>
//  W-W'
// LAMB GAS - Turing Gas / Combinator Soup Simulation
// cc -o lamb_gas lamb_gas.c lamb_lib.c -lm
#include "lamb.h"

// ============================================================================
// TURING GAS / COMBINATOR SOUP
// ============================================================================

// Gas Pool: A dynamic array of expressions that serves as the "primordial soup"
static struct {
    Expr_Index *items;
    size_t count;
    size_t capacity;
} gas_pool = {0};

// Track total simulation steps for soup dump metadata
static long gas_total_steps = 0;

// ============================================================================
// GC FUNCTION (with gas_pool marking)
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
    
    // Mark all expressions in the gas pool to prevent GC from sweeping them away
    for (size_t i = 0; i < gas_pool.count; ++i) {
        gc_mark(gas_pool.items[i]);
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

// ============================================================================
// GAS-SPECIFIC FUNCTIONS
// ============================================================================

// Save the gas pool to a .lamb file for later resumption
bool save_soup_to_file(const char *filename, long step_count) {
    FILE *f = fopen(filename, "w");
    if (!f) {
        fprintf(stderr, "ERROR: Could not open file %s for writing: %s\n", filename, strerror(errno));
        return false;
    }

    fprintf(f, "// LAMB_SOUP_V1\n");
    fprintf(f, "// step=%ld\n", step_count);
    fprintf(f, "// count=%zu\n\n", gas_pool.count);

    String_Builder sb = {0};

    for (size_t i = 0; i < gas_pool.count; ++i) {
        sb.count = 0; // Reset builder
        expr_display_no_tags(gas_pool.items[i], &sb);
        sb_append_null(&sb);
        
        fprintf(f, "soup_%zu = %s;\n", i, sb.items);
    }
    
    free(sb.items);
    fclose(f);
    return true;
}

// --- Graph Export Helpers ---

typedef struct {
    char *label;
    Expr_Index expr;
    size_t count;
    int id; 
} Species;

int compare_species_count_desc(const void *a, const void *b) {
    const Species *sa = (const Species *)a;
    const Species *sb = (const Species *)b;
    if (sb->count > sa->count) return 1;
    if (sb->count < sa->count) return -1;
    return 0;
}

// Find a species index by label (exact string match)
int find_species_index(Species *species, size_t count, const char *label) {
    for (size_t i = 0; i < count; ++i) {
        if (strcmp(species[i].label, label) == 0) return (int)i;
    }
    return -1;
}

void escape_json_string(const char *input, FILE *f) {
    while (*input) {
        if (*input == '\\') fprintf(f, "\\\\");
        else if (*input == '"') fprintf(f, "\\\"");
        else if (*input == '\n') fprintf(f, "\\n");
        else fputc(*input, f);
        input++;
    }
}

void analyze_pool(const char *stage_name) {
    if (gas_pool.count == 0) return;

    // 1. Snapshot: Convert all expressions to strings
    char **snapshots = malloc(gas_pool.count * sizeof(char*));
    for (size_t i = 0; i < gas_pool.count; ++i) {
        snapshots[i] = expr_to_string(gas_pool.items[i]);
    }

    // 2. Sort to group identical species
    qsort(snapshots, gas_pool.count, sizeof(char*), compare_strings);

    // 3. Count unique species
    size_t unique_count = 0;
    size_t max_freq = 0;
    char *most_common = NULL;

    if (gas_pool.count > 0) {
        unique_count = 1;
        size_t current_freq = 1;
        
        for (size_t i = 1; i < gas_pool.count; ++i) {
            if (strcmp(snapshots[i], snapshots[i-1]) != 0) {
                // New species found
                unique_count++;
                
                // Check if previous was the most common
                if (current_freq > max_freq) {
                    max_freq = current_freq;
                    most_common = snapshots[i-1];
                }
                current_freq = 1;
            } else {
                current_freq++;
            }
        }
        // Check the last run
        if (current_freq > max_freq) {
            max_freq = current_freq;
            most_common = snapshots[gas_pool.count-1];
        }
    }

    // 4. Report
    printf("--- %s ---\n", stage_name);
    printf("Population:   %zu\n", gas_pool.count);
    printf("Unique Spec:  %zu (%.2f%% diversity)\n", unique_count, ((float)unique_count / gas_pool.count) * 100.0f);
    if (most_common) {
        printf("Dominant:     %s (Count: %zu, %.2f%%)\n", most_common, max_freq, ((float)max_freq / gas_pool.count) * 100.0f);
    }
    printf("----------------------------------\n");

    // 5. Cleanup
    for (size_t i = 0; i < gas_pool.count; ++i) {
        free(snapshots[i]);
    }
    free(snapshots);
}

// ============================================================================
// MAIN
// ============================================================================

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
    printf(" W-W' [GAS MODE]\n");
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
            if (command(&commands, l.string.items, "dump_soup", "<filename>", "Save the gas pool soup to a .lamb file")) {
                // Get filename - skip whitespace after command name, take rest of line
                while (l.cur.pos < l.count && isspace(l.content[l.cur.pos])) {
                    l.cur.pos++;
                }
                
                // Now extract the filename (rest of line, trimming trailing whitespace)
                const char *path_start = &l.content[l.cur.pos];
                size_t path_len = l.count - l.cur.pos;
                
                // Trim trailing whitespace (including newline from fgets)
                while (path_len > 0 && isspace(path_start[path_len - 1])) {
                    path_len--;
                }
                
                if (path_len == 0) {
                    fprintf(stderr, "ERROR: :dump_soup requires a filename\n");
                    goto again;
                }
                
                char *soup_filename = copy_string_sized(path_start, path_len);
                
                if (gas_pool.count == 0) {
                    fprintf(stderr, "ERROR: Gas pool is empty. Run :gas first.\n");
                    free(soup_filename);
                    goto again;
                }
                
                if (save_soup_to_file(soup_filename, gas_total_steps)) {
                    printf("Saved %zu soup items to %s\n", gas_pool.count, soup_filename);
                }
                
                free(soup_filename);
                goto again;
            }
            if (command(&commands, l.string.items, "export_graph", "<filename>", "Export soup reaction network to JSON")) {
                 // 1. Parse filename
                while (l.cur.pos < l.count && isspace(l.content[l.cur.pos])) l.cur.pos++;
                const char *path_start = &l.content[l.cur.pos];
                size_t path_len = l.count - l.cur.pos;
                while (path_len > 0 && isspace(path_start[path_len - 1])) path_len--;
                
                if (path_len == 0) {
                    fprintf(stderr, "ERROR: :export_graph requires a filename\n");
                    goto again;
                }
                char *json_filename = copy_string_sized(path_start, path_len);

                // 2. Load Soup from bindings (if gas_pool is empty, try to populate from bindings)
                if (gas_pool.count == 0) {
                    for (size_t i = 0; i < bindings.count; ++i) {
                        if (strncmp(bindings.items[i].name.label, "soup_", 5) == 0) {
                            da_append(&gas_pool, bindings.items[i].body);
                        }
                    }
                }

                if (gas_pool.count == 0) {
                    fprintf(stderr, "ERROR: No soup found. Load a file with soup_ bindings or run :gas.\n");
                    free(json_filename);
                    goto again;
                }

                printf("Analyzing %zu expressions...\n", gas_pool.count);

                // 3. Identify Unique Species
                Species *species_list = malloc(gas_pool.count * sizeof(Species));
                size_t species_count = 0;

                for (size_t i = 0; i < gas_pool.count; ++i) {
                    char *lbl = expr_to_string(gas_pool.items[i]);
                    int existing = find_species_index(species_list, species_count, lbl);
                    
                    if (existing >= 0) {
                        species_list[existing].count++;
                        free(lbl);
                    } else {
                        species_list[species_count].label = lbl;
                        species_list[species_count].expr = gas_pool.items[i];
                        species_list[species_count].count = 1;
                        species_list[species_count].id = (int)species_count;
                        species_count++;
                    }
                }

                // Sort by abundance (optional, but looks nice in visualization)
                qsort(species_list, species_count, sizeof(Species), compare_species_count_desc);
                // Re-assign IDs after sort
                for(size_t i=0; i<species_count; ++i) species_list[i].id = (int)i;

                printf("Found %zu unique species.\nComputing reaction matrix...\n", species_count);

                // 4. Compute Reactions & Export
                FILE *f = fopen(json_filename, "w");
                if (!f) {
                    fprintf(stderr, "ERROR: Could not open %s\n", json_filename);
                    // cleanup
                    for(size_t i=0; i<species_count; ++i) free(species_list[i].label);
                    free(species_list);
                    free(json_filename);
                    goto again;
                }

                fprintf(f, "{\n  \"nodes\": [\n");
                for (size_t i = 0; i < species_count; ++i) {
                    fprintf(f, "    {\"id\": %d, \"label\": \"", species_list[i].id);
                    escape_json_string(species_list[i].label, f);
                    fprintf(f, "\", \"count\": %zu}%s\n", 
                            species_list[i].count, 
                            (i == species_count - 1) ? "" : ",");
                }
                fprintf(f, "  ],\n  \"links\": [\n");

                bool first_link = true;
                // Interaction Matrix: A + B -> C
                for (size_t i = 0; i < species_count; ++i) {
                    for (size_t j = 0; j < species_count; ++j) {
                        Expr_Index reaction = app(species_list[i].expr, species_list[j].expr);
                        Expr_Index result;
                        
                        // Use standard evaluation limits
                        Eval_Result res = eval_bounded(reaction, &result, 1000, 5000); 

                        int result_id = -1; // -1 implies "Waste" or "External"

                        if (res == EVAL_DONE) {
                            char *res_lbl = expr_to_string(result);
                            int found = find_species_index(species_list, species_count, res_lbl);
                            if (found >= 0) {
                                result_id = species_list[found].id;
                            }
                            free(res_lbl);
                        }

                        // We export the link. 
                        // If result_id is -1, it means the network is NOT closed (produces novel output).
                        // Visualizers can filter these out to see the "closed" core.
                        
                        if (!first_link) fprintf(f, ",\n");
                        fprintf(f, "    {\"source\": %d, \"target\": %d, \"result\": %d}", 
                                species_list[i].id, species_list[j].id, result_id);
                        first_link = false;
                    }
                }

                fprintf(f, "\n  ]\n}\n");
                fclose(f);
                printf("Network data exported to %s\n", json_filename);

                // Cleanup
                for(size_t i=0; i<species_count; ++i) free(species_list[i].label);
                free(species_list);
                free(json_filename);
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
            if (command(&commands, l.string.items, "gas", "<pool_size> <iterations> [depth] [steps] [logfile]", "Run Turing Gas simulation")) {
                long pool_size = 0;
                long iterations = 0;
                long depth = 3;
                long max_steps = 100;
                char log_filename[256] = "simulation_log.csv";
                
                // Parse pool_size
                if (!lexer_expect(&l, TOKEN_NAME)) goto again;
                pool_size = strtol(l.string.items, NULL, 10);
                if (pool_size <= 0) {
                    fprintf(stderr, "ERROR: pool_size must be positive\n");
                    goto again;
                }
                
                // Parse iterations
                if (!lexer_expect(&l, TOKEN_NAME)) goto again;
                iterations = strtol(l.string.items, NULL, 10);
                if (iterations <= 0) {
                    fprintf(stderr, "ERROR: iterations must be positive\n");
                    goto again;
                }
                
                // Optional: depth, max_steps, and log_filename
                if (!lexer_next(&l)) goto again;
                if (l.token == TOKEN_NAME) {
                    depth = strtol(l.string.items, NULL, 10);
                    if (depth <= 0) depth = 3;
                    
                    if (!lexer_next(&l)) goto again;
                    if (l.token == TOKEN_NAME) {
                        max_steps = strtol(l.string.items, NULL, 10);
                        if (max_steps <= 0) max_steps = 100;
                        
                        // Optional: log filename (5th parameter) - auto-appends .csv if needed
                        if (!lexer_next(&l)) goto again;
                        if (l.token == TOKEN_NAME) {
                            size_t len = l.string.count < 251 ? l.string.count : 251;
                            memcpy(log_filename, l.string.items, len);
                            log_filename[len] = '\0';
                            // Auto-append .csv if not present
                            if (len < 4 || strcmp(&log_filename[len-4], ".csv") != 0) {
                                strcat(log_filename, ".csv");
                            }
                            if (!lexer_expect(&l, TOKEN_END)) goto again;
                        } else if (l.token != TOKEN_END) {
                            report_unexpected(&l, TOKEN_END);
                            goto again;
                        }
                    }
                } else if (l.token != TOKEN_END) {
                    report_unexpected(&l, TOKEN_END);
                    goto again;
                }
                
                // Initialize the gas pool with random expressions
                printf("=== TURING GAS SIMULATION ===\n");
                printf("Pool Size: %ld\n", pool_size);
                printf("Iterations: %ld\n", iterations);
                printf("Expression Depth: %ld\n", depth);
                printf("Max Reduction Steps: %ld\n\n", max_steps);
                fflush(stdout);
                
                gas_pool.count = 0;
                
                // Check if we can resume from soup_* bindings
                bool soup_loaded = false;
                for (size_t i = 0; i < bindings.count; ++i) {
                    if (strncmp(bindings.items[i].name.label, "soup_", 5) == 0) {
                        da_append(&gas_pool, bindings.items[i].body);
                        soup_loaded = true;
                    }
                }
                
                if (soup_loaded) {
                    printf("Resumed simulation from loaded soup (%zu items).\n", gas_pool.count);
                    fflush(stdout);
                    // Use the loaded soup size as the effective pool size
                    pool_size = (long)gas_pool.count;
                } else {
                    // Seed atoms for generating expressions (kept for reference/fallback)
                    const char *atoms[] = {"s", "k", "i", "x", "y", "z", "f", "g"};
                    size_t atom_count = sizeof(atoms) / sizeof(atoms[0]);
                    UNUSED(atoms);
                    UNUSED(atom_count);
                    
                    printf("Seeding primordial soup with RICH combinators...\n");
                    fflush(stdout);
                    for (long i = 0; i < pool_size; ++i) {
                        Expr_Index expr;
                        
                        // Keep generating until we get something that isn't \x.x
                        // and isn't too simple.
                        int attempts = 0;
                        do {
                            // Pass current_depth=0, max_depth=depth
                            expr = generate_rich_combinator(0, (int)depth, NULL, 0);
                            attempts++;
                        } while (is_identity(expr) && attempts < 10);
                        
                        da_append(&gas_pool, expr);
                    }
                }
                
                analyze_pool("INITIAL SOUP");
                
                printf("Starting simulation...\n");
                fflush(stdout);
                size_t converged = 0;
                size_t diverged = 0;
                size_t errors = 0;
                
                // Open CSV log file for time-series data
                FILE *log_csv = fopen(log_filename, "w");
                if (log_csv) {
                    fprintf(log_csv, "step,unique_count,entropy,top_freq\n");
                } else {
                    fprintf(stderr, "WARNING: Could not open %s for writing\n", log_filename);
                }
                
                for (long it = 0; it < iterations; ++it) {
                    if (ctrl_c) {
                        printf("\nSimulation interrupted by user.\n");
                        break;
                    }
                    
                    // Pick two random molecules
                    size_t idx_a = rand() % gas_pool.count;
                    size_t idx_b = rand() % gas_pool.count;
                    
                    Expr_Index A = gas_pool.items[idx_a];
                    Expr_Index B = gas_pool.items[idx_b];
                    
                    // Reaction: A applied to B
                    Expr_Index reaction = app(A, B);
                    
                    // Reduce with limits
                    Expr_Index result;
                    Eval_Result res = eval_bounded(reaction, &result, (size_t)max_steps, 5000);
                    
                    if (res == EVAL_DONE) {
                        // Success: Overwrite a random slot
                        size_t target_idx = rand() % gas_pool.count;
                        gas_pool.items[target_idx] = result;
                        converged++;
                    } else if (res == EVAL_LIMIT) {
                        // Divergence: Kill one reactant, replace with fresh combinator
                        gas_pool.items[idx_a] = generate_rich_combinator(0, (int)depth, NULL, 0);
                        diverged++;
                    } else {
                        // Error: Replace both with fresh combinators
                        gas_pool.items[idx_a] = generate_rich_combinator(0, (int)depth, NULL, 0);
                        gas_pool.items[idx_b] = generate_rich_combinator(0, (int)depth, NULL, 0);
                        errors++;
                    }
                    
                    // Periodic logging every 1000 steps
                    if (log_csv && it % 1000 == 0 && gas_pool.count > 0) {
                        // Snapshot all expressions as strings
                        char **snapshots = malloc(gas_pool.count * sizeof(char*));
                        for (size_t i = 0; i < gas_pool.count; ++i) {
                            snapshots[i] = expr_to_string(gas_pool.items[i]);
                        }
                        
                        // Sort to group identical species
                        qsort(snapshots, gas_pool.count, sizeof(char*), compare_strings);
                        
                        // Calculate metrics: unique count, entropy, max frequency
                        size_t unique = 1;
                        double entropy = 0.0;
                        size_t cur_freq = 1;
                        size_t max_freq = 0;
                        
                        for (size_t i = 1; i < gas_pool.count; ++i) {
                            if (strcmp(snapshots[i], snapshots[i-1]) != 0) {
                                unique++;
                                double p = (double)cur_freq / gas_pool.count;
                                if (p > 0) entropy -= p * log(p);
                                if (cur_freq > max_freq) max_freq = cur_freq;
                                cur_freq = 1;
                            } else {
                                cur_freq++;
                            }
                        }
                        // Handle the last run
                        double p = (double)cur_freq / gas_pool.count;
                        if (p > 0) entropy -= p * log(p);
                        if (cur_freq > max_freq) max_freq = cur_freq;
                        
                        // Write to CSV
                        fprintf(log_csv, "%ld,%zu,%.4f,%zu\n", it, unique, entropy, max_freq);
                        fflush(log_csv);
                        
                        // Cleanup
                        for (size_t i = 0; i < gas_pool.count; ++i) free(snapshots[i]);
                        free(snapshots);
                    }
                    
                    // Progress indicator
                    if ((it + 1) % 100 == 0) {
                        printf(".");
                        fflush(stdout);
                    }
                    
                    // Periodic GC to prevent OOM
                    if (it % 50 == 0) {
                        gc(var(symbol("_dummy")), bindings);
                    }
                }
                
                // Close CSV log file
                if (log_csv) {
                    fclose(log_csv);
                    printf("\nTime-series data saved to %s\n", log_filename);
                }
                
                // Update total step counter for dump_soup metadata
                gas_total_steps += iterations;
                
                printf("\n=== SIMULATION COMPLETE ===\n");
                printf("Converged reactions: %zu\n", converged);
                printf("Diverged reactions: %zu\n", diverged);
                printf("Error reactions: %zu\n\n", errors);
                
                analyze_pool("FINAL SOUP");
                
                fflush(stdout);
                
                // Export gas pool to bindings for inspection
                printf("Exporting %zu specimens to bindings...\n", gas_pool.count);
                fflush(stdout);
                
                // Clear old specimen bindings
                for (size_t i = bindings.count; i > 0; --i) {
                    const char *name_str = bindings.items[i-1].name.label;
                    if (strncmp(name_str, "specimen_", 9) == 0) {
                        da_delete_at(&bindings, i-1);
                    }
                }
                
                // Add gas pool to bindings
                for (size_t i = 0; i < gas_pool.count; ++i) {
                    char buf[64];
                    snprintf(buf, sizeof(buf), "specimen_%zu", i);
                    create_binding(&bindings, symbol(buf), gas_pool.items[i]);
                }
                
                printf("Use ':list specimen_0 specimen_1 ...' to inspect results.\n");
                printf("Or ':list' to see all bindings including specimens.\n");
                fflush(stdout);
                
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
