A "Turing Gas" in the context of Lambda Calculus is essentially an artificial chemistry where molecules are lambda expressions, and reactions are function applications ($A \ B \to C$).

Given the current architecture of `lamb.c` (AST-based, explicit memory management with a custom GC, normal order reduction), here are several strategies to implement a Turing Gas, ranging from simple to complex.

### 1. The "Combinator Soup" Strategy (Global Mixing)

This is the most standard approach to algorithmic chemistry. The "Gas" is a dynamic array of expressions.

**The Rules:**
1.  **Init:** Populate an array (the "Pool") with $N$ random expressions (or specific primitives like S, K, I, Combinators).
2.  **Collision:** Randomly select two indices, $i$ and $j$.
3.  **Reaction:** Create a new expression $R = (Pool[i] \ Pool[j])$.
4.  **Reduction:** Attempt to reduce $R$ to normal form.
5.  **Outcome:**
    *   If reduction **converges** within $L$ steps: Overwrite a random slot in the pool (or the oldest slot, or slot $i$) with the result.
    *   If reduction **diverges** (runs out of gas): The reaction releases "heat" (waste). The result is discarded, or perhaps one of the reactants is destroyed (replaced with a random primitive).

**Implementation Extensions needed for `lamb.c`:**

You need a bounded evaluator. The current loop in `main` runs until `ctrl_c` or convergence. You need a function that returns "Out of Fuel" if it takes too long.

```c
typedef enum { EVAL_DONE, EVAL_LIMIT, EVAL_ERROR } Eval_Result;

Eval_Result eval_bounded(Expr_Index start, Expr_Index *out, size_t limit) {
    Expr_Index curr = start;
    for (size_t i = 0; i < limit; ++i) {
        Expr_Index next;
        if (!eval1(curr, &next)) return EVAL_ERROR;
        if (curr.unwrap == next.unwrap) {
            *out = curr;
            return EVAL_DONE;
        }
        curr = next;
    }
    return EVAL_LIMIT; // "Heat" / Divergence
}
```

### 2. The "Constructive" Strategy (Random AST Generation)

To initialize the gas or replenish dead cells, you need a way to generate syntactically valid lambda terms randomly.

**The Rules:**
Define a "Depth" and a set of available free variables/primitives.

```c
Expr_Index generate_random_expr(int depth, const char **atoms, size_t atom_count) {
    if (depth <= 0 || (rand() % 10 < 3)) { 
        // Base case: Return a variable or primitive
        const char *name = atoms[rand() % atom_count];
        return var(symbol(name)); 
    }
    
    int choice = rand() % 3;
    if (choice == 0) {
        // App
        return app(generate_random_expr(depth - 1, atoms, atom_count),
                   generate_random_expr(depth - 1, atoms, atom_count));
    } else {
        // Fun (Lambda abstraction)
        // We need a parameter name. For simplicity, pick from a small pool like x, y, z
        const char *param_name = atoms[rand() % atom_count];
        return fun(symbol(param_name), generate_random_expr(depth - 1, atoms, atom_count));
    }
}
```

*Note:* In `lamb.c`, you must handle the GC carefully. Every time you generate or reduce in the gas loop, you consume slots. You must treat the **entire Gas Array** as roots during Garbage Collection.

### 3. Energy and Conservation Strategy

Pure lambda calculus grows indefinitely. In a Turing Gas, you usually want conservation of mass or energy to prevent the system from filling RAM with one giant expression.

**The Rules:**
1.  Assign a `size` or `energy` value to every expression (e.g., number of AST nodes).
2.  **System Energy Limit:** The total number of AST nodes in the gas cannot exceed $M$.
3.  **Reaction Cost:**
    *   When $A$ applies to $B$, the potential result $C$ costs computational steps.
    *   Subtract "energy" from the system for every reduction step.
4.  **Death:** If an expression becomes too large (mass > threshold), it becomes unstable and splits or vanishes (is deleted from the pool).

### 4. Spatial Strategy (The Grid)

Instead of a random soup, place expressions on a 2D grid (toroidal/wrap-around).

**The Rules:**
1.  An expression at $(x, y)$ interacts only with its neighbors (N, S, E, W).
2.  **Interaction:** $(x,y)$ applies itself to $(x+1, y)$. The result is placed in $(x-1, y)$ or overwrites the neighbor.
3.  **Movement:** Expressions can move to empty adjacent slots.

This creates "creatures" or "gliders"—clusters of functions that move across the grid by consuming free variables or identity functions in their path.

### 5. Intrinsic Chemistry (Magic Functions)

Your code already supports "Magic" (`EXPR_MAG`). You can add chemistry-specific intrinsics that the gas can utilize.

**New Magics:**
*   `#split`: Takes an argument. If it's an Application, returns the Left side.
*   `#merge`: Takes two arguments. Returns an Application of them.
*   `#energy`: Returns the current complexity of its argument (Church numeral).

This allows the Lambda expressions to eventually evolve the ability to inspect and modify themselves, rather than just relying on the blind physics of beta-reduction.

---

### Proposed Implementation Plan

Here is how I would modify your `lamb.c` to add a basic **Strategy 1 (Soup)** command called `:gas`.

#### 1. Add Gas State and Helper

Add this structure to hold the gas:

```c
// In the global state area
struct {
    Expr_Index *items;
    size_t count;
    size_t capacity;
} gas_pool = {0};

// Helper to count nodes (Mass)
size_t expr_mass(Expr_Index expr) {
    if (!expr_slot(expr).live) return 0;
    switch (expr_slot(expr).kind) {
        case EXPR_VAR: return 1;
        case EXPR_MAG: return 1;
        case EXPR_FUN: return 1 + expr_mass(expr_slot(expr).as.fun.body);
        case EXPR_APP: return 1 + expr_mass(expr_slot(expr).as.app.lhs) + 
                                  expr_mass(expr_slot(expr).as.app.rhs);
        default: return 0;
    }
}
```

#### 2. Modified GC for Gas

You need to update `gc` to mark the gas pool as well, otherwise `gc()` will sweep your gas away if it's not bound to named variables.

```c
// Modify signature or create wrapper
void gc_all(Expr_Index root, Bindings bindings, struct GasPool *pool) {
    // ... clear visited flags ...
    
    // Mark standard root
    gc_mark(root);
    
    // Mark bindings
    for (size_t i = 0; i < bindings.count; ++i) {
        gc_mark(bindings.items[i].body);
    }
    
    // Mark Gas Pool
    if (pool) {
        for(size_t i = 0; i < pool->count; ++i) {
            gc_mark(pool->items[i]);
        }
    }

    // ... sweep phase ...
}
```

#### 3. The `:gas` Command

Add this logic inside `main`'s command parsing section.

```c
if (command(&commands, l.string.items, "gas", "<size> <steps>", "Run Turing Gas simulation")) {
    long pool_size = 0;
    long iterations = 0;
    
    // 1. Parse args (simple parsing for brevity)
    lexer_next(&l); pool_size = strtol(l.string.items, NULL, 10);
    lexer_next(&l); iterations = strtol(l.string.items, NULL, 10);
    
    // 2. Init Pool with random primitives if empty
    if (gas_pool.count == 0) {
        printf("Seeding primordial soup...\n");
        const char *atoms[] = {"s", "k", "i", "x", "y"}; // Assuming these are defined in bindings or are free
        for (int i = 0; i < pool_size; ++i) {
             da_append(&gas_pool, generate_random_expr(3, atoms, 5));
        }
    }

    // 3. Simulation Loop
    printf("Running simulation for %ld interactions...\n", iterations);
    
    for (int it = 0; it < iterations; ++it) {
        if (ctrl_c) break;
        
        // Pick two random molecules
        int idx_a = rand() % gas_pool.count;
        int idx_b = rand() % gas_pool.count;
        
        Expr_Index A = gas_pool.items[idx_a];
        Expr_Index B = gas_pool.items[idx_b];
        
        // Reaction: A applied to B
        Expr_Index reaction = app(A, B);
        
        // Reduce with limits (e.g., 100 steps max)
        Expr_Index result;
        Eval_Result res = eval_bounded(reaction, &result, 100);
        
        if (res == EVAL_DONE) {
            // Success: Overwrite a random slot (or idx_a)
            // Evolution logic: prefer keeping smaller, functional results?
            gas_pool.items[idx_a] = result;
            if (it % 100 == 0) printf("."); 
        } else {
            // Divergence/Heat: Maybe kill one of them?
            // gas_pool.items[idx_a] = generate_random_expr(...);
        }
        
        // Periodic GC is mandatory to prevent OOM
        if (it % 50 == 0) {
            // We pass a dummy root because we are only interested in keeping the pool
            // and bindings alive.
            gc_all(var(symbol("dummy")), bindings, &gas_pool); 
        }
    }
    printf("\nSimulation done. Use :list to see if anything survived.\n");
    
    // Dump pool to bindings so we can inspect them with :list
    bindings.count = 0; // Clear old bindings for clarity? Or append?
    for (size_t i = 0; i < gas_pool.count; ++i) {
         char buf[32];
         sprintf(buf, "specimen_%zu", i);
         create_binding(&bindings, symbol(buf), gas_pool.items[i]);
    }
    
    goto again;
}
```