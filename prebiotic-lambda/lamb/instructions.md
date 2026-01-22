"who is winning the evolutionary war?".

Here is the breakdown of the visual logic:

1.  **Identity (Hue):** We need a **Deterministic Hash** of the expression's structure. If an expression is `\x.x`, it should always be the exact same shade of Teal, for example. We shouldn't rely on string generation every frame (too slow/memory heavy), so we will implement a recursive AST hasher.
2.  **Complexity (Saturation):**
    *   **Small (Mass < 5):** Low saturation (pastel/washed out). These are simple "particles."
    *   **Large (Mass > 20):** High saturation (neon/vibrant). These are complex "organisms."
3.  **Dominance (Alpha/Opacity):**
    *   **Rare:** Transparent/Ghostly. They are evolutionary dead-ends or background noise.
    *   **Frequent:** Solid/Opaque. They are the dominant species taking over the grid.

### Implementation Plan

To do this efficiently in C without bringing in a heavy Hash Map library, we will use a **"Sort and Count"** approach every frame.
1.  **Hash** every cell's expression into an array.
2.  **Sort** the array of hashes.
3.  **Count** run-lengths to determine the frequency of each hash.
4.  **Render** using the pre-calculated frequency for the Alpha channel.

---

### Step 1: Add Hashing to `lamb_view.c`

We need a way to turn an AST into a unique number `uint32_t`. Add this to the top of `lamb_view.c`.

```c
// --- Hashing Utility ---
// DJB2 Hash function variant
uint32_t hash_string(const char *str) {
    uint32_t hash = 5381;
    int c;
    while ((c = *str++)) hash = ((hash << 5) + hash) + c;
    return hash;
}

// Recursive AST Hasher (No allocation)
// Walks the GC slots directly to compute a structural ID
uint32_t hash_expr(Expr_Index expr) {
    // Basic structural hashing
    uint32_t h = 0;
    
    switch (expr_slot(expr).kind) {
    case EXPR_VAR:
        h = hash_string(expr_slot(expr).as.var.label);
        h = h ^ (expr_slot(expr).as.var.tag * 33);
        return h;
    case EXPR_MAG:
        return hash_string(expr_slot(expr).as.mag) ^ 0xAAAA;
    case EXPR_FUN:
        h = hash_string(expr_slot(expr).as.fun.param.label);
        // Combine with body hash
        return (h << 3) ^ hash_expr(expr_slot(expr).as.fun.body);
    case EXPR_APP:
        // Combine LHS and RHS
        return (hash_expr(expr_slot(expr).as.app.lhs) * 33) ^ 
               hash_expr(expr_slot(expr).as.app.rhs);
    default: return 0;
    }
}
```

### Step 2: Implement the Frame Statistics

We need to analyze the population before we draw it. Add this struct and function to `lamb_view.c`.

```c
typedef struct {
    uint32_t hash;
    int count;
} SpeciesInfo;

// Simple comparator for qsort
int compare_species(const void *a, const void *b) {
    uint32_t h1 = *(const uint32_t*)a;
    uint32_t h2 = *(const uint32_t*)b;
    if (h1 < h2) return -1;
    if (h1 > h2) return 1;
    return 0;
}

// We will use a flat array to look up frequencies. 
// Since 120x80 is small (9600), we can just re-scan or sort. 
// For O(1) lookup during render, a hash map is best, but a linear scan 
// over "Unique Species" is fine if diversity is low (< 500 species).
// Let's use a simpler approach: 
// 1. Calculate Hash for every cell. Store in Cell struct (we can add a temp field or just array).
// 2. We actually need to modify the Main Loop to do a "Analysis Pass".

#define MAX_SPECIES_TRACKED 1024
SpeciesInfo species_stats[MAX_SPECIES_TRACKED];
int species_count = 0;
int max_frequency = 0;

void analyze_frame(Grid *g, uint32_t *cell_hashes) {
    // 1. Compute Hashes & Reset Stats
    species_count = 0;
    max_frequency = 1;
    
    // We will use a temporary array to sort and count
    // This avoids writing a hash map implementation
    int total_cells = g->width * g->height;
    uint32_t *sort_buf = malloc(total_cells * sizeof(uint32_t));
    int occupied_count = 0;

    for(int i=0; i<total_cells; ++i) {
        if(g->cells[i].occupied) {
            uint32_t h = hash_expr(g->cells[i].atom);
            cell_hashes[i] = h; // Store for rendering lookup
            sort_buf[occupied_count++] = h;
        } else {
            cell_hashes[i] = 0;
        }
    }

    if (occupied_count == 0) {
        free(sort_buf);
        return;
    }

    // 2. Sort to group identical hashes
    qsort(sort_buf, occupied_count, sizeof(uint32_t), compare_species);

    // 3. Run Length Encoding to get counts
    uint32_t current_hash = sort_buf[0];
    int current_count = 1;

    for(int i=1; i<occupied_count; ++i) {
        if (sort_buf[i] == current_hash) {
            current_count++;
        } else {
            // Commit previous
            if (species_count < MAX_SPECIES_TRACKED) {
                species_stats[species_count++] = (SpeciesInfo){current_hash, current_count};
                if (current_count > max_frequency) max_frequency = current_count;
            }
            // Reset
            current_hash = sort_buf[i];
            current_count = 1;
        }
    }
    // Commit last
    if (species_count < MAX_SPECIES_TRACKED) {
        species_stats[species_count++] = (SpeciesInfo){current_hash, current_count};
        if (current_count > max_frequency) max_frequency = current_count;
    }

    free(sort_buf);
}

// Helper to look up frequency (Linear search is okay for low diversity, but can be slow if chaotic)
// Optimization: For this visualizer, linear scan of ~100-200 species is negligible compared to Grid step.
int get_species_freq(uint32_t hash) {
    for(int i=0; i<species_count; ++i) {
        if (species_stats[i].hash == hash) return species_stats[i].count;
    }
    return 1;
}
```

### Step 3: Update the Coloring Logic

Replace the old `get_cell_color` with this Hue/Sat/Val logic.

```c
Color get_cell_color_dynamic(Cell *c, uint32_t hash, int freq, int max_freq) {
    if (!c->occupied) return BLACK;

    size_t mass = expr_mass(c->atom);
    
    // 1. HUE: Identity (Deterministic based on structure)
    // We map hash to 0..360
    float hue = (float)(hash % 360);

    // 2. SATURATION: Complexity
    // Simple atoms (mass 1-5) are washed out (0.2 - 0.5)
    // Complex atoms (mass > 20) are neon (1.0)
    float saturation = (float)mass / 20.0f; 
    if (saturation < 0.3f) saturation = 0.3f;
    if (saturation > 1.0f) saturation = 1.0f;

    // 3. VALUE: Brightness
    // Generally keep it high, but maybe dim extremely old dying cells
    float value = 1.0f;
    if (c->age > MAX_AGE * 0.9) value = 0.5f;

    // 4. ALPHA: Dominance / Frequency
    // Rare (1) -> Transparent (50)
    // Frequent (max) -> Opaque (255)
    float freq_ratio = (float)freq / (float)max_freq;
    // Logarithmic curve so even moderately common things become visible
    // freq_ratio = sqrtf(freq_ratio); 
    
    // Min alpha 40, Max 255
    float alpha_f = 40.0f + (freq_ratio * 215.0f);
    unsigned char alpha = (unsigned char)alpha_f;

    Color color = ColorFromHSV(hue, saturation, value);
    color.a = alpha;
    
    return color;
}
```

### Step 4: The Updated Main Loop

Modify `main` in `lamb_view.c` to wire it all together.

```c
// Inside main...

    // Pre-allocate hash buffer
    uint32_t *frame_hashes = malloc(GRID_W * GRID_H * sizeof(uint32_t));

    while (!WindowShouldClose()) {
        // ... Input and Grid Stepping ...

        // ANALYZE FRAME BEFORE DRAWING
        analyze_frame(&active_grid, frame_hashes);

        BeginDrawing();
        ClearBackground(BLACK); // Or ColorFromHSV(0, 0, 0.05) for dark grey

        for (int y = 0; y < active_grid.height; y++) {
            for (int x = 0; x < active_grid.width; x++) {
                int idx = y * active_grid.width + x;
                Cell *c = &active_grid.cells[idx];
                
                if (c->occupied) {
                    uint32_t h = frame_hashes[idx];
                    int freq = get_species_freq(h);

                    DrawRectangle(
                        x * CELL_SIZE, 
                        y * CELL_SIZE, 
                        CELL_SIZE - 1, 
                        CELL_SIZE - 1, 
                        get_cell_color_dynamic(c, h, freq, max_frequency)
                    );
                }
            }
        }
        
        // ... UI drawing ...
        EndDrawing();
    }
    
    free(frame_hashes);
    // ... cleanup ...
```

### Summary of Result
With this code, when you run the grid:
1.  **Noise Phase:** At the start, the grid will look like faint, washed-out RGB static (low frequency, low mass).
2.  **Emergence:** As specific combinators start winning, they will become solid and opaque.
3.  **Complexity:** If a winner evolves into a larger structure (higher mass), it will become vibrant and neon.
4.  **Extinction:** If a dominant species starts dying out, it will fade into transparency before disappearing.