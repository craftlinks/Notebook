#define LAMB_TEST
#include "lamb.c"

// -----------------------------------------------------------------------------
// TEST UTILITIES
// -----------------------------------------------------------------------------

int tests_run = 0;
int tests_passed = 0;

#define ASSERT_STR_EQ(actual, expected) \
    do { \
        if (strcmp((actual), (expected)) != 0) { \
            fprintf(stderr, "[FAIL] %s:%d:\n  Expected: '%s'\n  Actual:   '%s'\n", \
                    __FILE__, __LINE__, (expected), (actual)); \
            return false; \
        } \
    } while(0)

#define ASSERT_TRUE(condition) \
    do { \
        if (!(condition)) { \
            fprintf(stderr, "[FAIL] %s:%d: Assertion failed: %s\n", \
                    __FILE__, __LINE__, #condition); \
            return false; \
        } \
    } while(0)

void reset_env() {
    // Reset GC for a clean slate between tests
    GC.slots.count = 0;
    GC.dead.count = 0;
    GC.gens[0].count = 0;
    GC.gens[1].count = 0;
    GC.gen_cur = 0;
    // Reset interned labels to ensure tag counters (like :1) start deterministic
    // Note: In a real scenario, we might leak memory here if we don't free 
    // the previous labels, but for a short-lived test suite, it's acceptable.
    // Ideally, we would free labels.items, but labels.items[i] are const char*.
    labels.count = 0; 
}

// Helper to run a raw string through the parser and evaluator, 
// then return the stringified result.
char* run_eval(const char* input) {
    static char buffer[1024];
    String_Builder sb = {0};
    Lexer l = {0};
    Expr_Index expr;

    lexer_init(&l, input, strlen(input), "test");
    if (!parse_expr(&l, &expr)) return NULL;

    // Run eval loop until convergence (like main loop)
    for (;;) {
        Expr_Index expr1;
        if (!eval1(expr, &expr1)) break;
        if (expr.unwrap == expr1.unwrap) break;
        expr = expr1;
    }

    // Print result to buffer
    expr_display(expr, &sb);
    sb_append_null(&sb);
    
    // Copy to static buffer to return (simple test lifetime management)
    snprintf(buffer, 1024, "%s", sb.items);
    free(sb.items);
    return buffer;
}

// -----------------------------------------------------------------------------
// CORE LAMBDA TESTS
// -----------------------------------------------------------------------------

bool test_identity() {
    reset_env();
    char* res = run_eval("(\\x. x) y");
    ASSERT_STR_EQ(res, "y");
    return true;
}

bool test_boolean_true() {
    // True is \x. \y. x. It selects the first argument.
    reset_env();
    char* res = run_eval("(\\x. \\y. x) a b");
    ASSERT_STR_EQ(res, "a");
    return true;
}

bool test_boolean_false() {
    // False is \x. \y. y. It selects the second argument.
    reset_env();
    char* res = run_eval("(\\x. \\y. y) a b");
    ASSERT_STR_EQ(res, "b");
    return true;
}

// Test Alpha Conversion (Capture Avoidance)
// Expression: (\x. \y. x) y
// Without alpha conversion: \y. y  (Wrong! x was captured by inner y)
// With alpha conversion:    \y:1. y (Inner y renamed to avoid capture)
bool test_alpha_conversion_capture() {
    reset_env();
    char* res = run_eval("(\\x. \\y. x) y");
    // lamb.c implementation adds :tag when renaming
    ASSERT_STR_EQ(res, "\\y:1.y"); 
    return true;
}

// Test Nested substitution
// (\x. \y. \z. x z (y z)) a b c  -> a c (b c)
bool test_s_combinator() {
    reset_env();
    char* res = run_eval("(\\x. \\y. \\z. x z (y z)) a b c");
    ASSERT_STR_EQ(res, "a c (b c)");
    return true;
}

// Test Magic: #void
// #void anything -> #void
bool test_magic_void() {
    reset_env();
    char* res = run_eval("#void (\\x. x)");
    ASSERT_STR_EQ(res, "#void");
    return true;
}

// Test Magic: #trace
// #trace x -> x (with side effect printing to stdout, which we won't capture here, just logic)
bool test_magic_trace() {
    reset_env();
    char* res = run_eval("#trace (\\z. z)");
    ASSERT_STR_EQ(res, "\\z.z");
    return true;
}

// Test Arithmetic encoding (Church Numerals)
// 1 = \f. \x. f x
// succ = \n. \f. \x. f (n f x)
// succ 1 -> \f. \x. f (f x) (which is 2)
bool test_church_numerals() {
    reset_env();
    const char* succ = "(\\n. \\f. \\x. f (n f x))";
    const char* one  = "(\\f. \\x. f x)";
    char input[256];
    snprintf(input, 256, "%s %s", succ, one);
    
    char* res = run_eval(input);
    ASSERT_STR_EQ(res, "\\f.x.f (f x)");
    return true;
}

// Test parsing precedence
// a b c should be (a b) c, not a (b c)
bool test_associativity() {
    reset_env();
    Lexer l = {0};
    Expr_Index expr;
    String_Builder sb = {0};
    
    // We only parse, don't eval
    lexer_init(&l, "a b c", 5, "test");
    ASSERT_TRUE(parse_expr(&l, &expr));
    
    expr_display(expr, &sb);
    sb_append_null(&sb);
    
    // Logic: 
    // a b c 
    // -> App(App(a, b), c)
    // Display: a b c (implied left associativity)
    // If we force AST dump structure verification:
    // Outer app lhs should be (a b)
    
    Expr_Index lhs = expr_slot(expr).as.app.lhs; // (a b)
    Expr_Index rhs = expr_slot(expr).as.app.rhs; // c
    
    ASSERT_TRUE(expr_slot(rhs).kind == EXPR_VAR);
    ASSERT_STR_EQ(expr_slot(rhs).as.var.label, "c");
    
    ASSERT_TRUE(expr_slot(lhs).kind == EXPR_APP);
    Expr_Index lhs_inner = expr_slot(lhs).as.app.lhs; // a
    ASSERT_STR_EQ(expr_slot(lhs_inner).as.var.label, "a");
    
    free(sb.items);
    return true;
}

// -----------------------------------------------------------------------------
// LOW LEVEL UNIT TESTS (Internal Logic)
// -----------------------------------------------------------------------------

bool test_replace_logic() {
    reset_env();
    // Verify direct replacement mechanics
    Symbol x = symbol("x");
    Symbol y = symbol("y");
    
    Expr_Index body = var(x);
    Expr_Index arg  = var(y);
    
    // replace x in 'x' with 'y' -> 'y'
    Expr_Index res = replace(x, body, arg);
    ASSERT_TRUE(expr_slot(res).kind == EXPR_VAR);
    ASSERT_STR_EQ(expr_slot(res).as.var.label, "y");
    
    // replace x in 'y' with 'y' -> 'y' (no change)
    Expr_Index body2 = var(y);
    Expr_Index res2 = replace(x, body2, arg);
    ASSERT_TRUE(res2.unwrap == body2.unwrap); // Should return same index
    
    return true;
}

bool test_symbol_interning() {
    reset_env();
    const char* s1 = intern_label("hello");
    const char* s2 = intern_label("hello");
    const char* s3 = intern_label("world");
    
    // Pointers should be identical for same string
    ASSERT_TRUE(s1 == s2);
    ASSERT_TRUE(s1 != s3);
    return true;
}

// -----------------------------------------------------------------------------
// RUNNER
// -----------------------------------------------------------------------------

void run_test(bool (*func)(), const char* name) {
    tests_run++;
    printf("Running %-30s ... ", name);
    if (func()) {
        printf("PASS\n");
        tests_passed++;
    } else {
        // FAIL is printed inside macro
    }
}

int main(void) {
    printf("=== Lamb Core Unit Tests ===\n");
    
    run_test(test_symbol_interning, "Symbol Interning");
    run_test(test_identity, "Identity Function");
    run_test(test_replace_logic, "Low-level Substitution");
    run_test(test_boolean_true, "Church Boolean True");
    run_test(test_boolean_false, "Church Boolean False");
    run_test(test_associativity, "Parser Associativity");
    run_test(test_alpha_conversion_capture, "Alpha Conversion (Capture)");
    run_test(test_s_combinator, "S-Combinator (Complex)");
    run_test(test_magic_void, "Magic #void");
    run_test(test_magic_trace, "Magic #trace");
    run_test(test_church_numerals, "Church Numerals (Succ)");

    printf("\nResults: %d/%d passed.\n", tests_passed, tests_run);
    
    if (tests_passed == tests_run) return 0;
    return 1;
}