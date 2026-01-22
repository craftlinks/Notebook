// ,---@>
//  W-W'
// LAMB VIEW - Graphical Visualizer for Lambda Calculus Grid Simulation
// Build: make view (requires raylib)
// 
// Visual encoding:
//   HUE:        Identity (structural hash of expression)
//   SATURATION: Complexity (mass of AST)
//   ALPHA:      Dominance (frequency in population)
//
// Usage: ./lamb_view [options]
//   --width, -W <n>     Grid width (default: 120)
//   --height, -H <n>    Grid height (default: 80)
//   --cell-size, -c <n> Cell size in pixels (default: 10)
//   --density, -d <n>   Seed density percentage (default: 25)
//   --depth <n>         Max expression depth for seeding (default: 5)
//   --eval-steps, -e <n> Max evaluation steps per reaction (default: 100)
//   --max-mass, -m <n>  Max allowed AST mass (default: 2000)
//   --help, -h          Show this help message

#include "lamb.h"
#include "raylib.h"
#include <stdint.h>
#include <getopt.h>

// ============================================================================
// VISUALIZATION DEFAULTS (can be overridden via CLI)
// ============================================================================

#define DEFAULT_GRID_W 120
#define DEFAULT_GRID_H 80
#define DEFAULT_CELL_SIZE 10
#define DEFAULT_SEED_DENSITY 25
#define DEFAULT_DEPTH 5
#define DEFAULT_EVAL_STEPS 100
#define DEFAULT_MAX_MASS 2000

#define MAX_SPECIES_TRACKED 2048

// Runtime configuration (set from CLI or defaults)
static int config_grid_w = DEFAULT_GRID_W;
static int config_grid_h = DEFAULT_GRID_H;
static int config_cell_size = DEFAULT_CELL_SIZE;
static int config_density = DEFAULT_SEED_DENSITY;
static int config_depth = DEFAULT_DEPTH;
static int config_eval_steps = DEFAULT_EVAL_STEPS;
static int config_max_mass = DEFAULT_MAX_MASS;

// ============================================================================
// HASHING UTILITIES
// ============================================================================

// DJB2 Hash function variant
static uint32_t hash_string(const char *str) {
    uint32_t hash = 5381;
    int c;
    while ((c = *str++)) {
        hash = ((hash << 5) + hash) + (uint32_t)c;
    }
    return hash;
}

// Recursive AST Hasher (No allocation)
// Walks the GC slots directly to compute a structural ID
// Uses expr_slot_unsafe to avoid assertions on potentially dead slots
static uint32_t hash_expr(Expr_Index expr) {
    // Safety check: ensure index is valid and expression is live
    if (expr.unwrap >= GC.slots.count) return 0;
    Expr *e = &expr_slot_unsafe(expr);
    if (!e->live) return 0;
    
    uint32_t h = 0;
    
    switch (e->kind) {
    case EXPR_VAR:
        h = hash_string(e->as.var.label);
        h = h ^ ((uint32_t)e->as.var.tag * 33);
        return h;
    case EXPR_MAG:
        return hash_string(e->as.mag) ^ 0xAAAAAAAA;
    case EXPR_FUN:
        h = hash_string(e->as.fun.param.label);
        // Combine with body hash
        return (h << 3) ^ hash_expr(e->as.fun.body);
    case EXPR_APP:
        // Combine LHS and RHS
        return (hash_expr(e->as.app.lhs) * 33) ^ 
               hash_expr(e->as.app.rhs);
    default: 
        return 0;
    }
}

// ============================================================================
// SPECIES STATISTICS
// ============================================================================

typedef struct {
    uint32_t hash;
    int count;
} SpeciesInfo;

static SpeciesInfo species_stats[MAX_SPECIES_TRACKED];
static int species_count = 0;
static int max_frequency = 1;

// Pre-allocated sort buffer to avoid per-frame malloc/free
static uint32_t *sort_buf = NULL;
static size_t sort_buf_capacity = 0;

// Comparator for qsort
static int compare_hashes(const void *a, const void *b) {
    uint32_t h1 = *(const uint32_t*)a;
    uint32_t h2 = *(const uint32_t*)b;
    if (h1 < h2) return -1;
    if (h1 > h2) return 1;
    return 0;
}

// Analyze frame: compute hashes and species frequencies (with caching)
static void analyze_frame(Grid *g, uint32_t *cell_hashes) {
    species_count = 0;
    max_frequency = 1;
    
    int total_cells = g->width * g->height;
    
    // Ensure sort buffer is large enough (reuse allocation)
    if (sort_buf_capacity < (size_t)total_cells) {
        free(sort_buf);
        sort_buf_capacity = (size_t)total_cells;
        sort_buf = malloc(sort_buf_capacity * sizeof(uint32_t));
    }
    
    int occupied_count = 0;

    // 1. Compute hashes for occupied cells (use cache when valid)
    for (int i = 0; i < total_cells; ++i) {
        if (g->cells[i].occupied) {
            // Use cached hash if valid, otherwise compute and cache
            if (!g->cells[i].cache_valid) {
                g->cells[i].cached_hash = hash_expr(g->cells[i].atom);
                g->cells[i].cached_mass = expr_mass(g->cells[i].atom);
                g->cells[i].cache_valid = true;
            }
            uint32_t h = g->cells[i].cached_hash;
            cell_hashes[i] = h;
            sort_buf[occupied_count++] = h;
        } else {
            cell_hashes[i] = 0;
        }
    }

    if (occupied_count == 0) {
        return;
    }

    // 2. Sort to group identical hashes
    qsort(sort_buf, (size_t)occupied_count, sizeof(uint32_t), compare_hashes);

    // 3. Run Length Encoding to get counts
    uint32_t current_hash = sort_buf[0];
    int current_count = 1;

    for (int i = 1; i < occupied_count; ++i) {
        if (sort_buf[i] == current_hash) {
            current_count++;
        } else {
            // Commit previous species
            if (species_count < MAX_SPECIES_TRACKED) {
                species_stats[species_count].hash = current_hash;
                species_stats[species_count].count = current_count;
                species_count++;
                if (current_count > max_frequency) {
                    max_frequency = current_count;
                }
            }
            // Reset for next species
            current_hash = sort_buf[i];
            current_count = 1;
        }
    }
    
    // Commit last species
    if (species_count < MAX_SPECIES_TRACKED) {
        species_stats[species_count].hash = current_hash;
        species_stats[species_count].count = current_count;
        species_count++;
        if (current_count > max_frequency) {
            max_frequency = current_count;
        }
    }
}

// Look up frequency for a given hash (linear scan - acceptable for <2K species)
static int get_species_freq(uint32_t hash) {
    for (int i = 0; i < species_count; ++i) {
        if (species_stats[i].hash == hash) {
            return species_stats[i].count;
        }
    }
    return 1;
}

// ============================================================================
// COLORING LOGIC
// ============================================================================

static Color get_cell_color_dynamic(Cell *c, uint32_t hash, int freq, int max_freq) {
    if (!c->occupied) return BLACK;

    // Use cached mass (computed during analyze_frame)
    size_t mass = c->cached_mass;
    
    // 1. HUE: Identity (Deterministic based on structure)
    // Map hash to 0..360 degrees
    float hue = (float)(hash % 360);

    // 2. SATURATION: Complexity
    // Simple atoms (mass 1-5) are washed out (0.3)
    // Complex atoms (mass > 20) are neon (1.0)
    float saturation = (float)mass / 20.0f; 
    if (saturation < 0.3f) saturation = 0.3f;
    if (saturation > 1.0f) saturation = 1.0f;

    // 3. VALUE: Brightness
    // Generally keep it high, but dim extremely old dying cells
    float value = 1.0f;
    if (c->age > (MAX_AGE * 9 / 10)) {
        value = 0.5f;
    }

    // 4. ALPHA: Dominance / Frequency
    // Rare (1) -> Transparent (40)
    // Frequent (max) -> Opaque (255)
    float freq_ratio = (float)freq / (float)max_freq;
    // Use sqrt for smoother curve - moderately common things become more visible
    freq_ratio = sqrtf(freq_ratio);
    
    // Min alpha 40, Max 255
    float alpha_f = 40.0f + (freq_ratio * 215.0f);
    unsigned char alpha = (unsigned char)alpha_f;

    Color color = ColorFromHSV(hue, saturation, value);
    color.a = alpha;
    
    return color;
}

// ============================================================================
// SIMULATION STATE
// ============================================================================

typedef enum {
    STATE_RUNNING,
    STATE_PAUSED,
    STATE_STEP
} SimState;

// Use the shared active_grid from lamb_grid.c (non-static when LAMB_LIBRARY_MODE)
extern Grid active_grid;
static Bindings bindings = {0};
static uint32_t *frame_hashes = NULL;

static SimState sim_state = STATE_PAUSED;
static int sim_speed = 1;  // Steps per frame
static bool show_help = true;

// ============================================================================
// CLI ARGUMENT PARSING
// ============================================================================

static void print_usage(const char *program_name) {
    printf("Usage: %s [options]\n", program_name);
    printf("\nOptions:\n");
    printf("  --width, -W <n>      Grid width (default: %d)\n", DEFAULT_GRID_W);
    printf("  --height, -H <n>     Grid height (default: %d)\n", DEFAULT_GRID_H);
    printf("  --cell-size, -c <n>  Cell size in pixels (default: %d)\n", DEFAULT_CELL_SIZE);
    printf("  --density, -d <n>    Seed density percentage (default: %d)\n", DEFAULT_SEED_DENSITY);
    printf("  --depth <n>          Max expression depth for seeding (default: %d)\n", DEFAULT_DEPTH);
    printf("  --eval-steps, -e <n> Max evaluation steps per reaction (default: %d)\n", DEFAULT_EVAL_STEPS);
    printf("  --max-mass, -m <n>   Max allowed AST mass (default: %d)\n", DEFAULT_MAX_MASS);
    printf("  --help, -h           Show this help message\n");
    printf("\nControls:\n");
    printf("  SPACE     Start/Pause simulation\n");
    printf("  S         Single step (when paused)\n");
    printf("  UP/+      Increase speed\n");
    printf("  DOWN/-    Decrease speed\n");
    printf("  R         Reset simulation\n");
    printf("  H         Toggle help overlay\n");
    printf("  ESC       Quit\n");
}

static void parse_args(int argc, char **argv) {
    static struct option long_options[] = {
        {"width",      required_argument, 0, 'W'},
        {"height",     required_argument, 0, 'H'},
        {"cell-size",  required_argument, 0, 'c'},
        {"density",    required_argument, 0, 'd'},
        {"depth",      required_argument, 0, 'D'},
        {"eval-steps", required_argument, 0, 'e'},
        {"max-mass",   required_argument, 0, 'm'},
        {"help",       no_argument,       0, 'h'},
        {0, 0, 0, 0}
    };
    
    int opt;
    int option_index = 0;
    
    while ((opt = getopt_long(argc, argv, "W:H:c:d:D:e:m:h", long_options, &option_index)) != -1) {
        switch (opt) {
            case 'W':
                config_grid_w = atoi(optarg);
                if (config_grid_w <= 0) config_grid_w = DEFAULT_GRID_W;
                break;
            case 'H':
                config_grid_h = atoi(optarg);
                if (config_grid_h <= 0) config_grid_h = DEFAULT_GRID_H;
                break;
            case 'c':
                config_cell_size = atoi(optarg);
                if (config_cell_size <= 0) config_cell_size = DEFAULT_CELL_SIZE;
                break;
            case 'd':
                config_density = atoi(optarg);
                if (config_density <= 0 || config_density > 100) config_density = DEFAULT_SEED_DENSITY;
                break;
            case 'D':
                config_depth = atoi(optarg);
                if (config_depth <= 0) config_depth = DEFAULT_DEPTH;
                break;
            case 'e':
                config_eval_steps = atoi(optarg);
                if (config_eval_steps <= 0) config_eval_steps = DEFAULT_EVAL_STEPS;
                break;
            case 'm':
                config_max_mass = atoi(optarg);
                if (config_max_mass <= 0) config_max_mass = DEFAULT_MAX_MASS;
                break;
            case 'h':
                print_usage(argv[0]);
                exit(0);
            default:
                print_usage(argv[0]);
                exit(1);
        }
    }
}

// ============================================================================
// MAIN
// ============================================================================

int main(int argc, char **argv) {
    // Parse command-line arguments
    parse_args(argc, argv);
    
    // Initialize random seed
    srand((unsigned)time(NULL));
    
    // Calculate initial window dimensions from config
    int init_window_w = config_grid_w * config_cell_size;
    int init_window_h = config_grid_h * config_cell_size + 60;  // Extra space for UI
    
    // Initialize raylib window with resize support
    SetConfigFlags(FLAG_WINDOW_RESIZABLE | FLAG_VSYNC_HINT);
    InitWindow(init_window_w, init_window_h, "LAMB VIEW - Lambda Calculus Grid Visualizer");
    SetWindowMinSize(200, 160);  // Minimum size for tiling WMs
    SetTargetFPS(60);
    
    // Initialize grid
    grid_init(&active_grid, config_grid_w, config_grid_h);
    
    // Seed with combinators
    int count = (config_grid_w * config_grid_h * config_density) / 100;
    grid_seed(&active_grid, count, config_depth);
    
    // Allocate hash buffer
    frame_hashes = malloc((size_t)(config_grid_w * config_grid_h) * sizeof(uint32_t));
    
    printf("LAMB VIEW starting with:\n");
    printf("  Grid:       %dx%d (%d cells)\n", config_grid_w, config_grid_h, config_grid_w * config_grid_h);
    printf("  Cell size:  %d px\n", config_cell_size);
    printf("  Density:    %d%% (%d creatures)\n", config_density, count);
    printf("  Depth:      %d\n", config_depth);
    printf("  Eval steps: %d\n", config_eval_steps);
    printf("  Max mass:   %d\n", config_max_mass);
    
    // Colors for UI
    Color bg_color = (Color){ 10, 10, 15, 255 };       // Near-black with slight blue
    Color text_color = (Color){ 200, 200, 220, 255 };  // Light gray-blue
    Color help_bg = (Color){ 20, 20, 30, 200 };        // Semi-transparent dark
    
    while (!WindowShouldClose()) {
        // ==================== INPUT ====================
        
        // Toggle pause with SPACE
        if (IsKeyPressed(KEY_SPACE)) {
            sim_state = (sim_state == STATE_RUNNING) ? STATE_PAUSED : STATE_RUNNING;
        }
        
        // Single step with S
        if (IsKeyPressed(KEY_S) && sim_state == STATE_PAUSED) {
            sim_state = STATE_STEP;
        }
        
        // Speed controls
        if (IsKeyPressed(KEY_UP) || IsKeyPressed(KEY_EQUAL)) {
            sim_speed = (sim_speed < 100) ? sim_speed + 1 : sim_speed;
        }
        if (IsKeyPressed(KEY_DOWN) || IsKeyPressed(KEY_MINUS)) {
            sim_speed = (sim_speed > 1) ? sim_speed - 1 : 1;
        }
        
        // Reset with R
        if (IsKeyPressed(KEY_R)) {
            grid_free(&active_grid);
            grid_init(&active_grid, config_grid_w, config_grid_h);
            grid_seed(&active_grid, count, config_depth);
            sim_state = STATE_PAUSED;
        }
        
        // Toggle help with H
        if (IsKeyPressed(KEY_H)) {
            show_help = !show_help;
        }
        
        // ==================== SIMULATION ====================
        
        if (sim_state == STATE_RUNNING) {
            for (int i = 0; i < sim_speed; ++i) {
                grid_step(&active_grid, bindings, (size_t)config_eval_steps, (size_t)config_max_mass);
            }
        } else if (sim_state == STATE_STEP) {
            grid_step(&active_grid, bindings, (size_t)config_eval_steps, (size_t)config_max_mass);
            sim_state = STATE_PAUSED;
        }
        
        // Analyze frame for species frequencies
        analyze_frame(&active_grid, frame_hashes);
        
        // ==================== RENDERING ====================
        
        // Get current window dimensions (handles resize/tiling WM)
        int current_w = GetScreenWidth();
        int current_h = GetScreenHeight();
        
        // Calculate dynamic cell size to fill window
        // Reserve 60px for UI bar at bottom
        int grid_area_h = current_h - 60;
        if (grid_area_h < 100) grid_area_h = 100;
        
        // Calculate cell size that fits the window
        int cell_w = current_w / config_grid_w;
        int cell_h = grid_area_h / config_grid_h;
        int dynamic_cell_size = (cell_w < cell_h) ? cell_w : cell_h;
        if (dynamic_cell_size < 2) dynamic_cell_size = 2;
        
        // Calculate offset to center the grid
        int grid_render_w = dynamic_cell_size * config_grid_w;
        int grid_render_h = dynamic_cell_size * config_grid_h;
        int offset_x = (current_w - grid_render_w) / 2;
        int offset_y = (grid_area_h - grid_render_h) / 2;
        if (offset_x < 0) offset_x = 0;
        if (offset_y < 0) offset_y = 0;
        
        BeginDrawing();
        ClearBackground(bg_color);
        
        // Draw grid cells
        for (int y = 0; y < active_grid.height; y++) {
            for (int x = 0; x < active_grid.width; x++) {
                int idx = y * active_grid.width + x;
                Cell *c = &active_grid.cells[idx];
                
                if (c->occupied) {
                    uint32_t h = frame_hashes[idx];
                    int freq = get_species_freq(h);
                    
                    Color cell_color = get_cell_color_dynamic(c, h, freq, max_frequency);
                    
                    DrawRectangle(
                        offset_x + x * dynamic_cell_size, 
                        offset_y + y * dynamic_cell_size, 
                        dynamic_cell_size - 1, 
                        dynamic_cell_size - 1, 
                        cell_color
                    );
                }
            }
        }
        
        // Draw UI bar at bottom
        int ui_y = current_h - 60;
        DrawRectangle(0, ui_y, current_w, 60, (Color){ 15, 15, 20, 255 });
        
        // Status text
        const char *state_str = (sim_state == STATE_RUNNING) ? "RUNNING" : "PAUSED";
        int pop = grid_population(&active_grid);
        
        DrawText(TextFormat("Step: %ld | Pop: %d | Species: %d | %s | Speed: %dx", 
                           active_grid.steps, pop, species_count, state_str, sim_speed),
                 10, ui_y + 8, 18, text_color);
        
        DrawText(TextFormat("React: %ld OK / %ld Div | Deaths: %ld | Moves: %ld",
                           active_grid.reactions_success, active_grid.reactions_diverged,
                           active_grid.deaths_age, active_grid.movements),
                 10, ui_y + 30, 16, (Color){ 150, 150, 170, 255 });
        
        // Mini help
        DrawText("[H]elp", current_w - 70, ui_y + 20, 16, (Color){ 100, 100, 120, 255 });
        
        // Help overlay
        if (show_help) {
            int help_w = 340;
            int help_h = 200;
            int help_x = (current_w - help_w) / 2;
            int help_y = (grid_area_h - help_h) / 2;
            
            DrawRectangle(help_x, help_y, help_w, help_h, help_bg);
            DrawRectangleLines(help_x, help_y, help_w, help_h, (Color){ 60, 60, 80, 255 });
            
            int ty = help_y + 15;
            int tx = help_x + 20;
            
            DrawText("LAMB VIEW - Controls", tx, ty, 20, text_color);
            ty += 35;
            
            DrawText("[SPACE]    Start/Pause simulation", tx, ty, 16, text_color); ty += 22;
            DrawText("[S]        Single step (when paused)", tx, ty, 16, text_color); ty += 22;
            DrawText("[UP/+]     Increase speed", tx, ty, 16, text_color); ty += 22;
            DrawText("[DOWN/-]   Decrease speed", tx, ty, 16, text_color); ty += 22;
            DrawText("[R]        Reset simulation", tx, ty, 16, text_color); ty += 22;
            DrawText("[H]        Toggle this help", tx, ty, 16, text_color); ty += 22;
            DrawText("[ESC]      Quit", tx, ty, 16, text_color);
        }
        
        EndDrawing();
        
        // Check for extinction
        if (grid_population(&active_grid) == 0 && sim_state == STATE_RUNNING) {
            sim_state = STATE_PAUSED;
        }
    }
    
    // Cleanup
    free(frame_hashes);
    free(sort_buf);
    sort_buf = NULL;
    sort_buf_capacity = 0;
    grid_free(&active_grid);
    CloseWindow();
    
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
