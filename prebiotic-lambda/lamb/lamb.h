// ,---@>
//  W-W'
// LAMB - Lambda Calculus Interpreter Library
// Header file for lamb_lib.c, lamb_gas.c, lamb_grid.c
#ifndef LAMB_H
#define LAMB_H

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <stdarg.h>
#include <stdint.h>
#include <string.h>
#include <ctype.h>
#include <errno.h>
#include <signal.h>
#include <time.h>
#include <math.h>

#ifdef _WIN32
#    define WIN32_LEAN_AND_MEAN
#    define _WINUSER_
#    define _WINGDI_
#    define _IMM_
#    define _WINCON_
#    include <windows.h>
#else
#    include <unistd.h>
#    include <sys/wait.h>
#    include <sys/stat.h>
#endif // _WIN32

#if defined(__GNUC__) || defined(__clang__)
#    ifdef __MINGW_PRINTF_FORMAT
#        define PRINTF_FORMAT(STRING_INDEX, FIRST_TO_CHECK) __attribute__ ((format (__MINGW_PRINTF_FORMAT, STRING_INDEX, FIRST_TO_CHECK)))
#    else
#        define PRINTF_FORMAT(STRING_INDEX, FIRST_TO_CHECK) __attribute__ ((format (printf, STRING_INDEX, FIRST_TO_CHECK)))
#    endif // __MINGW_PRINTF_FORMAT
#else
#    define PRINTF_FORMAT(STRING_INDEX, FIRST_TO_CHECK)
#endif

// ============================================================================
// MACROS
// ============================================================================

#define UNUSED(value) (void)(value)
#define TODO(message) do { fprintf(stderr, "%s:%d: TODO: %s\n", __FILE__, __LINE__, message); abort(); } while(0)
#define UNREACHABLE(message) do { fprintf(stderr, "%s:%d: UNREACHABLE: %s\n", __FILE__, __LINE__, message); abort(); } while(0)

#define DA_INIT_CAP 256
#define da_reserve(da, expected_capacity)                                                  \
    do {                                                                                   \
        if ((expected_capacity) > (da)->capacity) {                                        \
            if ((da)->capacity == 0) {                                                     \
                (da)->capacity = DA_INIT_CAP;                                              \
            }                                                                              \
            while ((expected_capacity) > (da)->capacity) {                                 \
                (da)->capacity *= 2;                                                       \
            }                                                                              \
            (da)->items = realloc((da)->items, (da)->capacity * sizeof(*(da)->items));     \
            assert((da)->items != NULL && "Buy more RAM lol");                             \
        }                                                                                  \
    } while (0)

#define da_append(da, item)                  \
    do {                                     \
        da_reserve((da), (da)->count + 1);   \
        (da)->items[(da)->count++] = (item); \
    } while (0)

#define da_delete_at(da, i) \
    do { \
       size_t index = (i); \
       assert(index < (da)->count); \
       memmove(&(da)->items[index], &(da)->items[index + 1], ((da)->count - index - 1)*sizeof(*(da)->items)); \
       (da)->count -= 1; \
    } while(0)

#define sb_append_null(sb) da_append(sb, 0)

// ============================================================================
// TYPES AND STRUCTS
// ============================================================================

typedef struct {
    const char **items;
    size_t count;
    size_t capacity;
} Cmd;

typedef struct {
    char *items;
    size_t count;
    size_t capacity;
} String_Builder;

typedef struct {
    // Displayed name of the symbol.
    const char *label;
    // Internal tag that makes two symbols with the same label different if needed.
    // Usually used to obtain a fresh symbol for capture avoiding substitution.
    size_t tag;
} Symbol;

typedef enum {
    EXPR_VAR,
    EXPR_FUN,
    EXPR_APP,
    EXPR_MAG,
} Expr_Kind;

typedef struct {
    size_t unwrap;
} Expr_Index;

typedef struct {
    Expr_Kind kind;
    bool visited;
    bool live;
    union {
        Symbol var;
        const char *mag;
        struct {
            Symbol param;
            Expr_Index body;
        } fun;
        struct {
            Expr_Index lhs;
            Expr_Index rhs;
        } app;
    } as;
} Expr;

typedef enum {
    TOKEN_INVALID,
    TOKEN_END,
    TOKEN_OPAREN,
    TOKEN_CPAREN,
    TOKEN_LAMBDA,
    TOKEN_DOT,
    TOKEN_COLON,
    TOKEN_SEMICOLON,
    TOKEN_EQUALS,
    TOKEN_NAME,
    TOKEN_MAGIC,
} Token_Kind;

typedef struct {
    size_t pos, bol, row;
} Cur;

typedef struct {
    const char *content;
    size_t count;
    const char *file_path;

    Cur cur;

    Token_Kind token;
    String_Builder string;
    size_t row, col;
} Lexer;

typedef struct {
    const char *name;
    const char *signature;
    const char *description;
} Command;

typedef struct {
    Command *items;
    size_t count;
    size_t capacity;
} Commands;

typedef struct {
    Symbol name;
    Expr_Index body;
} Binding;

typedef struct {
    Binding *items;
    size_t count;
    size_t capacity;
} Bindings;

typedef enum { EVAL_DONE, EVAL_LIMIT, EVAL_ERROR } Eval_Result;

// ============================================================================
// GRID / SPATIAL SIMULATION TYPES
// ============================================================================

// Metabolic Model Constants
#define MAX_AGE 50
// Cosmic ray rate: probability = COSMIC_RAY_RATE / 100000 per empty cell per step
// For 120x80 grid (~5000 empty cells at 50% density): rate 10 → ~0.5 spawns/step
#define COSMIC_RAY_RATE 1  // 0.01% per cell → ~0.5 spawns/step on typical grid

typedef struct {
    Expr_Index atom;
    bool occupied;
    int age;          // Steps survived
    int generation;   // How many ancestors
    // Cached values for visualization (avoids per-frame recomputation)
    uint32_t cached_hash;   // Structural hash of expression
    size_t cached_mass;     // AST node count
    bool cache_valid;       // True if cache is up-to-date
} Cell;

typedef struct {
    int width;
    int height;
    Cell *cells;
    long steps;
    int population;       // Cached population count (maintained incrementally)
    // Statistics
    long reactions_success;
    long reactions_diverged;
    long movements;
    long deaths_age;      // Deaths from old age
    long cosmic_spawns;   // Spontaneous generations
    // Phenotypic behavior statistics (brain-based decision making)
    long attacks;         // Aggressive: A(B) -> True, A eats B
    long evasions;        // Evasive: A(B) -> False, A moves away
} Grid;

// ============================================================================
// GC CONTEXT (Named struct for external access)
// ============================================================================

typedef struct {
    struct {
        Expr *items;
        size_t count;
        size_t capacity;
    } slots;

    struct {
        Expr_Index *items;
        size_t count;
        size_t capacity;
    } dead;

    struct {
        Expr_Index *items;
        size_t count;
        size_t capacity;
    } gens[2];

    size_t gen_cur;
} GC_Context;

extern GC_Context GC;

// ============================================================================
// MACROS FOR EXPR ACCESS
// ============================================================================

#define expr_slot(index) (                            \
    GC.slots.items[                                   \
        (assert((index).unwrap < GC.slots.count),     \
         assert(GC.slots.items[(index).unwrap].live), \
         (index).unwrap)])

#define expr_slot_unsafe(index) GC.slots.items[(index).unwrap]

// ============================================================================
// GLOBAL VARIABLE DECLARATIONS
// ============================================================================

extern volatile sig_atomic_t ctrl_c;

// ============================================================================
// FUNCTION PROTOTYPES - Utilities
// ============================================================================

bool cmd_run(Cmd *cmd);
char *copy_string(const char *s);
char *copy_string_sized(const char *s, size_t n);
int sb_appendf(String_Builder *sb, const char *fmt, ...) PRINTF_FORMAT(2, 3);
int file_exists(const char *file_path);
bool read_entire_file(const char *path, String_Builder *sb);
bool write_entire_file(const char *path, const void *data, size_t size);

// ============================================================================
// FUNCTION PROTOTYPES - Symbols
// ============================================================================

const char *intern_label(const char *label);
Symbol symbol(const char *label);
bool symbol_eq(Symbol a, Symbol b);
Symbol symbol_fresh(Symbol s);

// ============================================================================
// FUNCTION PROTOTYPES - Expression Management
// ============================================================================

Expr_Index alloc_expr(void);
void free_expr(Expr_Index expr);
Expr_Index var(Symbol name);
Expr_Index magic(const char *label);
Expr_Index fun(Symbol param, Expr_Index body);
Expr_Index app(Expr_Index lhs, Expr_Index rhs);

// ============================================================================
// FUNCTION PROTOTYPES - Expression Display
// ============================================================================

void expr_display(Expr_Index expr, String_Builder *sb);
void expr_display_no_tags(Expr_Index expr, String_Builder *sb);
void dump_expr_ast(Expr_Index expr);
void trace_expr(Expr_Index expr);
char *expr_to_string(Expr_Index expr);
size_t expr_mass(Expr_Index expr);

// ============================================================================
// FUNCTION PROTOTYPES - Evaluation
// ============================================================================

bool is_var_free_there(Symbol name, Expr_Index there);
Expr_Index replace(Symbol param, Expr_Index body, Expr_Index arg);
bool eval1(Expr_Index expr, Expr_Index *expr1);
Eval_Result eval_bounded(Expr_Index start, Expr_Index *out, size_t limit, size_t max_mass);

// ============================================================================
// FUNCTION PROTOTYPES - Lexer/Parser
// ============================================================================

const char *token_kind_display(Token_Kind kind);
void lexer_init(Lexer *l, const char *content, size_t count, const char *file_path);
void lexer_print_loc(Lexer *l, FILE *stream);
char lexer_curr_char(Lexer *l);
char lexer_next_char(Lexer *l);
void lexer_trim_left(Lexer *l);
bool lexer_starts_with(Lexer *l, const char *prefix);
void lexer_drop_line(Lexer *l);
bool issymbol(int x);
bool lexer_next(Lexer *l);
bool lexer_peek(Lexer *l);
void report_unexpected(Lexer *l, Token_Kind expected);
bool lexer_expect(Lexer *l, Token_Kind expected);
bool parse_expr(Lexer *l, Expr_Index *expr);
bool parse_fun(Lexer *l, Expr_Index *expr);
bool parse_primary(Lexer *l, Expr_Index *expr);

// ============================================================================
// FUNCTION PROTOTYPES - REPL Helpers
// ============================================================================

bool command(Commands *commands, const char *input, const char *name, const char *signature, const char *description);
void print_available_commands(Commands *commands);
void create_binding(Bindings *bindings, Symbol name, Expr_Index body);
bool create_bindings_from_file(const char *file_path, Bindings *bindings);
void ctrl_c_handler(int signum);
void replace_active_file_path_from_lexer_if_not_empty(Lexer l, char **active_file_path);

// ============================================================================
// FUNCTION PROTOTYPES - GC
// ============================================================================

void gc_mark(Expr_Index root);
void gc(Expr_Index root, Bindings bindings);
void gc_compact(Bindings *bindings);  // Compact GC slots to reclaim memory
size_t gc_slot_count(void);           // Get current slot count for diagnostics
size_t gc_dead_count(void);           // Get dead slot count for diagnostics

// ============================================================================
// FUNCTION PROTOTYPES - Combinator Generation
// ============================================================================

Expr_Index generate_rich_combinator(int current_depth, int max_depth, const char **env, int env_count);
Expr_Index generate_ski_combinator(int depth);  // Generate random SKI combinator tree
bool is_identity(Expr_Index expr);

// Church boolean detection (for phenotypic behavior)
// True  = λx.λy.x (selects first argument)
// False = λx.λy.y (selects second argument)
bool is_church_true(Expr_Index expr);
bool is_church_false(Expr_Index expr);

// ============================================================================
// FUNCTION PROTOTYPES - Shared Helpers
// ============================================================================

int compare_strings(const void *a, const void *b);

// ============================================================================
// FUNCTION PROTOTYPES - Grid / Spatial Simulation
// ============================================================================

void grid_init(Grid *g, int w, int h);
void grid_free(Grid *g);
void grid_seed(Grid *g, int count, int depth);
int grid_population(Grid *g);
void grid_step(Grid *g, Bindings bindings, size_t eval_steps, size_t max_mass);
size_t grid_analyze(Grid *g, bool verbose);
void grid_render(Grid *g, bool clear_screen);
bool grid_export_log(Grid *g, const char *filename, bool append);
bool grid_save_soup(Grid *g, const char *filename);

#endif // LAMB_H

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
