// ,---@>
//  W-W'
// cc -o lamb lamb.c
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <stdarg.h>
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
//   https://gcc.gnu.org/onlinedocs/gcc-4.7.2/gcc/Function-Attributes.html
#    ifdef __MINGW_PRINTF_FORMAT
#        define PRINTF_FORMAT(STRING_INDEX, FIRST_TO_CHECK) __attribute__ ((format (__MINGW_PRINTF_FORMAT, STRING_INDEX, FIRST_TO_CHECK)))
#    else
#        define PRINTF_FORMAT(STRING_INDEX, FIRST_TO_CHECK) __attribute__ ((format (printf, STRING_INDEX, FIRST_TO_CHECK)))
#    endif // __MINGW_PRINTF_FORMAT
#else
//   TODO: implement PRINTF_FORMAT for MSVC
#    define PRINTF_FORMAT(STRING_INDEX, FIRST_TO_CHECK)
#endif

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

typedef struct {
    const char **items;
    size_t count;
    size_t capacity;
} Cmd;

bool cmd_run(Cmd *cmd)
{
    if (cmd->count < 1) {
        fprintf(stderr, "ERROR: Could not run empty command");
        return false;
    }

#ifdef _WIN32
    TODO("cmd_run is not implemented for windows");
#else
    pid_t cpid = fork();
    if (cpid < 0) {
        fprintf(stderr, "ERROR: Could not fork child process: %s", strerror(errno));
        return false;
    }

    if (cpid == 0) {
        // NOTE: This leaks a bit of memory in the child process.
        // But do we actually care? It's a one off leak anyway...
        da_append(cmd, NULL);

        if (execvp(cmd->items[0], (char * const*) cmd->items) < 0) {
            fprintf(stderr, "ERROR: Could not exec child process for %s: %s", cmd->items[0], strerror(errno));
            exit(1);
        }
        UNREACHABLE("cmd_run");
    }

    for (;;) {
        int wstatus = 0;
        if (waitpid(cpid, &wstatus, 0) < 0) {
            fprintf(stderr, "ERROR: Could not wait on command (pid %d): %s", cpid, strerror(errno));
            return false;
        }

        if (WIFEXITED(wstatus)) {
            int exit_status = WEXITSTATUS(wstatus);
            if (exit_status != 0) {
                fprintf(stderr, "ERROR: Command exited with exit code %d", exit_status);
                return false;
            }

            break;
        }

        if (WIFSIGNALED(wstatus)) {
            fprintf(stderr, "ERROR: Command process was terminated by signal %d", WTERMSIG(wstatus));
            return false;
        }
    }

    return cpid;
#endif
}

char *copy_string_sized(const char *s, size_t n)
{
    char *ds = malloc(n + 1);
    assert(ds);
    memcpy(ds, s, n);
    ds[n] = '\0';
    return ds;
}

char *copy_string(const char *s)
{
    return copy_string_sized(s, strlen(s));
}

typedef struct {
    char *items;
    size_t count;
    size_t capacity;
} String_Builder;

int sb_appendf(String_Builder *sb, const char *fmt, ...) PRINTF_FORMAT(2, 3);
int sb_appendf(String_Builder *sb, const char *fmt, ...)
{
    va_list args;

    va_start(args, fmt);
    int n = vsnprintf(NULL, 0, fmt, args);
    va_end(args);

    // NOTE: the new_capacity needs to be +1 because of the null terminator.
    // However, further below we increase sb->count by n, not n + 1.
    // This is because we don't want the sb to include the null terminator. The user can always sb_append_null() if they want it
    da_reserve(sb, sb->count + n + 1);
    char *dest = sb->items + sb->count;
    va_start(args, fmt);
    vsnprintf(dest, n+1, fmt, args);
    va_end(args);

    sb->count += n;

    return n;
}

// RETURNS:
//  0 - file does not exists
//  1 - file exists
// -1 - error while checking if file exists. The error is logged
int file_exists(const char *file_path)
{
#if _WIN32
    // TODO: distinguish between "does not exists" and other errors
    DWORD dwAttrib = GetFileAttributesA(file_path);
    return dwAttrib != INVALID_FILE_ATTRIBUTES;
#else
    struct stat statbuf;
    if (stat(file_path, &statbuf) < 0) {
        if (errno == ENOENT) return 0;
        fprintf(stderr, "ERROR: Could not check if file %s exists: %s", file_path, strerror(errno));
        return -1;
    }
    return 1;
#endif
}

bool read_entire_file(const char *path, String_Builder *sb)
{
    FILE *f = fopen(path, "rb");
    size_t new_count = 0;
    long long m = 0;
    if (f == NULL)                 goto fail;
    if (fseek(f, 0, SEEK_END) < 0) goto fail;
#ifndef _WIN32
    m = ftell(f);
#else
    m = _ftelli64(f);
#endif
    if (m < 0)                     goto fail;
    if (fseek(f, 0, SEEK_SET) < 0) goto fail;

    new_count = sb->count + m;
    if (new_count > sb->capacity) {
        sb->items = realloc(sb->items, new_count);
        assert(sb->items != NULL && "Buy more RAM lool!!");
        sb->capacity = new_count;
    }

    fread(sb->items + sb->count, m, 1, f);
    if (ferror(f)) {
        // TODO: Afaik, ferror does not set errno. So the error reporting in fail is not correct in this case.
        goto fail;
    }
    sb->count = new_count;

    fclose(f);
    return true;
fail:
    fprintf(stderr, "ERROR: Could not read file %s: %s\n", path, strerror(errno));
    if (f) fclose(f);
    return false;
}

bool write_entire_file(const char *path, const void *data, size_t size)
{
    const char *buf = NULL;
    FILE *f = fopen(path, "wb");
    if (f == NULL) {
        fprintf(stderr, "ERROR: Could not open file %s for writing: %s\n", path, strerror(errno));
        goto fail;
    }

    //           len
    //           v
    // aaaaaaaaaa
    //     ^
    //     data

    buf = (const char*)data;
    while (size > 0) {
        size_t n = fwrite(buf, 1, size, f);
        if (ferror(f)) {
            fprintf(stderr, "ERROR: Could not write into file %s: %s\n", path, strerror(errno));
            goto fail;
        }
        size -= n;
        buf  += n;
    }

    fclose(f);
    return true;
fail:
    if (f) fclose(f);
    return false;
}

struct {
    const char **items;
    size_t count;
    size_t capacity;
} labels = {0};

const char *intern_label(const char *label)
{
    for (size_t i = 0; i < labels.count; ++i) {
        if (strcmp(labels.items[i], label) == 0) {
            return labels.items[i];
        }
    }
    char *result = copy_string(label);
    da_append(&labels, result);
    return result;
}

typedef struct {
    // Displayed name of the symbol.
    const char *label;
    // Internal tag that makes two symbols with the same label different if needed.
    // Usually used to obtain a fresh symbol for capture avoiding substitution.
    size_t tag;
} Symbol;

bool symbol_eq(Symbol a, Symbol b)
{
    // NOTE: We compare addresses of the labels because they are expected to be interned with intern_label()
    return a.label == b.label && a.tag == b.tag;
}

Symbol symbol(const char *label)
{
    Symbol s = { .label = intern_label(label), .tag = 0 };
    return s;
}

Symbol symbol_fresh(Symbol s)
{
    static size_t global_counter = 0;
    s.tag = ++global_counter;
    return s;
}

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

static struct {
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
} GC = {0};

#define expr_slot(index) (                            \
    GC.slots.items[                                   \
        (assert((index).unwrap < GC.slots.count),     \
         assert(GC.slots.items[(index).unwrap].live), \
         (index).unwrap)])

#define expr_slot_unsafe(index) GC.slots.items[(index).unwrap]


Expr_Index alloc_expr(void)
{
    Expr_Index result;
    if (GC.dead.count > 0) {
        result = GC.dead.items[--GC.dead.count];
    } else {
        result.unwrap = GC.slots.count;
        Expr expr = {0};
        da_append(&GC.slots, expr);
    }
    assert(!expr_slot_unsafe(result).live);
    expr_slot_unsafe(result).live = true;
    da_append(&GC.gens[GC.gen_cur], result);
    return result;
}

void free_expr(Expr_Index expr)
{
    expr_slot(expr).live = false;
    da_append(&GC.dead, expr);
}

Expr_Index var(Symbol name)
{
    Expr_Index expr = alloc_expr();
    expr_slot(expr).kind = EXPR_VAR;
    expr_slot(expr).as.var = name;
    return expr;
}

Expr_Index magic(const char *label)
{
    Expr_Index expr = alloc_expr();
    expr_slot(expr).kind = EXPR_MAG;
    expr_slot(expr).as.mag = intern_label(label);
    return expr;
}

Expr_Index fun(Symbol param, Expr_Index body)
{
    Expr_Index expr = alloc_expr();
    expr_slot(expr).kind = EXPR_FUN;
    expr_slot(expr).as.fun.param = param;
    expr_slot(expr).as.fun.body = body;
    return expr;
}

Expr_Index app(Expr_Index lhs, Expr_Index rhs)
{
    Expr_Index expr = alloc_expr();
    expr_slot(expr).kind = EXPR_APP;
    expr_slot(expr).as.app.lhs = lhs;
    expr_slot(expr).as.app.rhs = rhs;
    return expr;
}

void expr_display(Expr_Index expr, String_Builder *sb)
{
    switch (expr_slot(expr).kind) {
    case EXPR_VAR:
        sb_appendf(sb, "%s", expr_slot(expr).as.var.label);
        if (expr_slot(expr).as.var.tag) {
            sb_appendf(sb, ":%zu", expr_slot(expr).as.var.tag);
        }
        break;
    case EXPR_FUN:
        sb_appendf(sb, "\\");
        while (expr_slot(expr).kind == EXPR_FUN) {
            if (expr_slot(expr).as.fun.param.tag) {
                sb_appendf(sb, "%s:%zu.", expr_slot(expr).as.fun.param.label, expr_slot(expr).as.fun.param.tag);
            } else {
                sb_appendf(sb, "%s.", expr_slot(expr).as.fun.param.label);
            }
            expr = expr_slot(expr).as.fun.body;
        }
        expr_display(expr, sb);
        break;
    case EXPR_APP: {
        Expr_Index lhs = expr_slot(expr).as.app.lhs;
        bool lhs_paren = expr_slot(lhs).kind == EXPR_FUN;
        if (lhs_paren) sb_appendf(sb, "(");
        expr_display(lhs, sb);
        if (lhs_paren) sb_appendf(sb, ")");

        sb_appendf(sb, " ");

        Expr_Index rhs = expr_slot(expr).as.app.rhs;
        bool rhs_paren = expr_slot(rhs).kind != EXPR_VAR && expr_slot(rhs).kind != EXPR_MAG;
        if (rhs_paren) sb_appendf(sb, "(");
        expr_display(rhs, sb);
        if (rhs_paren) sb_appendf(sb, ")");
    } break;
    case EXPR_MAG: {
        sb_appendf(sb, "#%s", expr_slot(expr).as.mag);
    } break;
    default: UNREACHABLE("Expr_Kind");
    }
}

void dump_expr_ast(Expr_Index expr)
{
    static struct {
        bool *items;
        size_t count;
        size_t capacity;
    } stack = {0};

    for (size_t i = 0; i < stack.count; ++i) {
        if (i + 1 == stack.count) {
            printf("+--");
        } else {
            if (stack.items[i]) {
                printf("|  ");
            } else {
                printf("   ");
            }
        }
    }

    switch (expr_slot(expr).kind) {
    case EXPR_VAR:
        if (expr_slot(expr).as.var.tag == 0) {
            printf("[VAR] %s\n", expr_slot(expr).as.var.label);
        } else {
            printf("[VAR] %s:%zu\n", expr_slot(expr).as.var.label, expr_slot(expr).as.var.tag);
        }
        break;
    case EXPR_FUN:
        if (expr_slot(expr).as.fun.param.tag == 0) {
            printf("[FUN] \\%s\n", expr_slot(expr).as.fun.param.label);
        } else {
            printf("[FUN] \\%s:%zu\n", expr_slot(expr).as.fun.param.label, expr_slot(expr).as.fun.param.tag);
        }
        da_append(&stack, false); {
            dump_expr_ast(expr_slot(expr).as.fun.body);
        } stack.count -= 1;
        break;
    case EXPR_APP:
        printf("[APP]\n");
        da_append(&stack, true); {
            dump_expr_ast(expr_slot(expr).as.app.lhs);
        } stack.count -= 1;
        da_append(&stack, false); {
            dump_expr_ast(expr_slot(expr).as.app.rhs);
        } stack.count -= 1;
        break;
    case EXPR_MAG:
        printf("[MAG] #%s\n", expr_slot(expr).as.mag);
        break;
    default:
        UNREACHABLE("Expr_Index");
    }
}

void trace_expr(Expr_Index expr)
{
    static String_Builder sb = {0};
    sb.count = 0;
    expr_display(expr, &sb);
    sb_append_null(&sb);
    printf("%s", sb.items);
}

bool is_var_free_there(Symbol name, Expr_Index there)
{
    switch (expr_slot(there).kind) {
    case EXPR_VAR:
        return symbol_eq(expr_slot(there).as.var, name);
    case EXPR_FUN:
        if (symbol_eq(expr_slot(there).as.fun.param, name)) return false;
        return is_var_free_there(name, expr_slot(there).as.fun.body);
    case EXPR_APP:
        if (is_var_free_there(name, expr_slot(there).as.app.lhs)) return true;
        if (is_var_free_there(name, expr_slot(there).as.app.rhs)) return true;
        return false;
    case EXPR_MAG:
        return false;
    default: UNREACHABLE("Expr_Kind");
    }
}

Expr_Index replace(Symbol param, Expr_Index body, Expr_Index arg)
{
    switch (expr_slot(body).kind) {
    case EXPR_MAG:
        return body;
    case EXPR_VAR:
        if (symbol_eq(expr_slot(body).as.var, param)) {
            return arg;
        } else {
            return body;
        }
    case EXPR_FUN:
        if (symbol_eq(expr_slot(body).as.fun.param, param)) return body;
        if (!is_var_free_there(expr_slot(body).as.fun.param, arg)) {
            return fun(expr_slot(body).as.fun.param, replace(param, expr_slot(body).as.fun.body, arg));
        }
        Symbol fresh_param_name = symbol_fresh(expr_slot(body).as.fun.param);
        Expr_Index fresh_param = var(fresh_param_name);
        return fun(
            fresh_param_name,
            replace(param,
                replace(
                    expr_slot(body).as.fun.param,
                    expr_slot(body).as.fun.body,
                    fresh_param),
                arg));
    case EXPR_APP:
        return app(
            replace(param, expr_slot(body).as.app.lhs, arg),
            replace(param, expr_slot(body).as.app.rhs, arg));
    default: UNREACHABLE("Expr_Kind");
    }
}

bool eval1(Expr_Index expr, Expr_Index *expr1)
{
    switch (expr_slot(expr).kind) {
    case EXPR_VAR:
        *expr1 = expr;
        return true;
    case EXPR_FUN: {
        Expr_Index body;
        if (!eval1(expr_slot(expr).as.fun.body, &body)) return false;
        if (body.unwrap != expr_slot(expr).as.fun.body.unwrap) {
            *expr1 = fun(expr_slot(expr).as.fun.param, body);
        } else {
            *expr1 = expr;
        }
        return true;
    }
    case EXPR_APP: {
        Expr_Index lhs = expr_slot(expr).as.app.lhs;
        Expr_Index rhs = expr_slot(expr).as.app.rhs;

        if (expr_slot(lhs).kind == EXPR_FUN) {
            *expr1 = replace(
                expr_slot(lhs).as.fun.param,
                expr_slot(lhs).as.fun.body,
                rhs);
            return true;
        } else if (expr_slot(lhs).kind == EXPR_MAG) {
            if (expr_slot(lhs).as.mag == intern_label("trace")) {
                Expr_Index new_rhs;
                if (!eval1(rhs, &new_rhs)) return false;
                if (new_rhs.unwrap == rhs.unwrap) {
                    printf("TRACE: ");
                    trace_expr(rhs);
                    printf("\n");
                    *expr1 = rhs;
                } else {
                    *expr1 = app(lhs, new_rhs);
                }
                return true;
            } else if (expr_slot(lhs).as.mag == intern_label("void")) {
                Expr_Index new_rhs;
                if (!eval1(rhs, &new_rhs)) return false;
                if (new_rhs.unwrap == rhs.unwrap) {
                    *expr1 = lhs;
                } else {
                    *expr1 = app(lhs, new_rhs);
                }
                return true;
            } else {
                printf("ERROR: unknown magic #%s\n", expr_slot(lhs).as.mag);
                return false;
            }
        }

        Expr_Index new_lhs;
        if (!eval1(lhs, &new_lhs)) return false;
        if (lhs.unwrap != new_lhs.unwrap) {
            *expr1 = app(new_lhs, rhs);
            return true;
        }

        Expr_Index new_rhs;
        if (!eval1(rhs, &new_rhs)) return false;
        if (rhs.unwrap != new_rhs.unwrap) {
            *expr1 = app(lhs, new_rhs);
            return true;
        }

        *expr1 = expr;
        return true;
    }
    case EXPR_MAG:
        *expr1 = expr;
        return true;
    default: UNREACHABLE("Expr_Kind");
    }
}

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

const char *token_kind_display(Token_Kind kind)
{
    switch (kind) {
    case TOKEN_INVALID:   return "TOKEN_INVALID";
    case TOKEN_END:       return "TOKEN_END";
    case TOKEN_OPAREN:    return "TOKEN_OPAREN";
    case TOKEN_CPAREN:    return "TOKEN_CPAREN";
    case TOKEN_LAMBDA:    return "TOKEN_LAMBDA";
    case TOKEN_DOT:       return "TOKEN_DOT";
    case TOKEN_COLON:     return "TOKEN_COLON";
    case TOKEN_SEMICOLON: return "TOKEN_SEMICOLON";
    case TOKEN_EQUALS:    return "TOKEN_EQUALS";
    case TOKEN_NAME:      return "TOKEN_NAME";
    case TOKEN_MAGIC:     return "TOKEN_MAGIC";
    default: UNREACHABLE("Token_Kind");
    }
}

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

void lexer_init(Lexer *l, const char *content, size_t count, const char *file_path)
{
    l->content = content;
    l->count = count;
    l->file_path = file_path;
    memset(&l->cur, 0, sizeof(l->cur));
}

void lexer_print_loc(Lexer *l, FILE *stream)
{
    if (l->file_path) fprintf(stream, "%s:", l->file_path);
    fprintf(stream, "%zu:%zu: ", l->row, l->col);
}

char lexer_curr_char(Lexer *l)
{
    if (l->cur.pos >= l->count) return 0;
    return l->content[l->cur.pos];
}

char lexer_next_char(Lexer *l)
{
    if (l->cur.pos >= l->count) return 0;
    char x = l->content[l->cur.pos++];
    if (x == '\n') {
        l->cur.row += 1;
        l->cur.bol = l->cur.pos;
    }
    return x;
}

void lexer_trim_left(Lexer *l)
{
    while (isspace(lexer_curr_char(l))) {
        lexer_next_char(l);
    }
}

bool lexer_starts_with(Lexer *l, const char *prefix)
{
    size_t pos = l->cur.pos;
    while (pos < l->count && *prefix != '\0' && *prefix == l->content[pos]) {
        pos++;
        prefix++;
    }
    return *prefix == '\0';
}

void lexer_drop_line(Lexer *l)
{
    while (l->cur.pos < l->count && lexer_next_char(l) != '\n') {}
}

bool issymbol(int x)
{
    return isalnum(x) || x == '_';
}

bool lexer_next(Lexer *l)
{
    for (;;) {
        lexer_trim_left(l);
        if (lexer_starts_with(l, "//")) lexer_drop_line(l);
        else break;
    }

    l->row = l->cur.row + 1;
    l->col = l->cur.pos - l->cur.bol + 1;

    char x = lexer_next_char(l);
    if (x == '\0') {
        l->token = TOKEN_END;
        return true;
    }

    switch (x) {
    case '(':  l->token = TOKEN_OPAREN;    return true;
    case ')':  l->token = TOKEN_CPAREN;    return true;
    case '\\': l->token = TOKEN_LAMBDA;    return true;
    case '.':  l->token = TOKEN_DOT;       return true;
    case ':':  l->token = TOKEN_COLON;     return true;
    case ';':  l->token = TOKEN_SEMICOLON; return true;
    case '=':  l->token = TOKEN_EQUALS;    return true;
    }

    if (x == '#') {
        l->token = TOKEN_MAGIC;
        l->string.count = 0;
        while (issymbol(lexer_curr_char(l))) {
            x = lexer_next_char(l);
            da_append(&l->string, x);
        }
        sb_append_null(&l->string);
        return true;
    }

    if (issymbol(x)) {
        l->token = TOKEN_NAME;
        l->string.count = 0;
        da_append(&l->string, x);
        while (issymbol(lexer_curr_char(l))) {
            x = lexer_next_char(l);
            da_append(&l->string, x);
        }
        sb_append_null(&l->string);
        return true;
    }

    l->token = TOKEN_INVALID;
    lexer_print_loc(l, stderr);
    fprintf(stderr, "ERROR: Unknown token starts with `%c`\n", x);
    return false;
}

bool lexer_peek(Lexer *l)
{
    Cur cur = l->cur;
    bool result = lexer_next(l);
    l->cur = cur;
    return result;
}

void report_unexpected(Lexer *l, Token_Kind expected)
{
    lexer_print_loc(l, stderr);
    fprintf(stderr, "ERROR: Unexpected token %s. Expected %s instead.\n", token_kind_display(l->token), token_kind_display(expected));
}

bool lexer_expect(Lexer *l, Token_Kind expected)
{
    if (!lexer_next(l)) return false;
    if (l->token != expected) {
        report_unexpected(l, expected);
        return false;
    }
    return true;
}

bool parse_expr(Lexer *l, Expr_Index *expr);

bool parse_fun(Lexer *l, Expr_Index *expr)
{
    if (!lexer_expect(l, TOKEN_NAME)) return false;
    Symbol arg = symbol(l->string.items);
    if (!lexer_expect(l, TOKEN_DOT)) return false;

    Token_Kind a, b;
    Cur cur = l->cur; {
        if (!lexer_next(l)) return false;
        a = l->token;
        if (!lexer_next(l)) return false;
        b = l->token;
    } l->cur = cur;

    Expr_Index body;
    if (a == TOKEN_NAME && b == TOKEN_DOT) {
        if (!parse_fun(l, &body)) return false;
    } else {
        if (!parse_expr(l, &body)) return false;
    }
    *expr = fun(arg, body);
    return true;
}

bool parse_primary(Lexer *l, Expr_Index *expr)
{
    if (!lexer_next(l)) return NULL;
    switch ((int)l->token) {
    case TOKEN_OPAREN: {
        if (!parse_expr(l, expr)) return false;
        if (!lexer_expect(l, TOKEN_CPAREN)) return false;
        return true;
    }
    case TOKEN_LAMBDA: return parse_fun(l, expr);
    case TOKEN_MAGIC:
        *expr = magic(l->string.items);
        return true;
    case TOKEN_NAME:
        *expr = var(symbol(l->string.items));
        return true;
    default:
        lexer_print_loc(l, stderr);
        fprintf(stderr, "ERROR: Unexpected token %s. Expected a primary expression instead.\n", token_kind_display(l->token));
        return false;
    }
}

bool parse_expr(Lexer *l, Expr_Index *expr)
{
    if (!parse_primary(l, expr)) return false;

    if (!lexer_peek(l)) return false;
    while (
        l->token != TOKEN_CPAREN &&
        l->token != TOKEN_END    &&
        l->token != TOKEN_SEMICOLON
    ) {
        Expr_Index rhs;
        if (!parse_primary(l, &rhs)) return false;
        *expr = app(*expr, rhs);
        if (!lexer_peek(l)) return false;
    }
    return true;
}

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

bool command(Commands *commands, const char *input, const char *name, const char *signature, const char *description)
{
    Command command = {
        .name        = name,
        .signature   = signature,
        .description = description,
    };
    da_append(commands, command);
    while (*input && *name && *input == *name) {
        input++;
        name++;
    }
    return *input == '\0';
}

void print_available_commands(Commands *commands)
{
    printf("Available commands:\n");
    int max_name_width = 0;
    int max_sig_width = 0;
    for (size_t i = 0; i < commands->count; ++i) {
        Command command = commands->items[i];
        int name_width  = strlen(command.name);
        int sig_width   = strlen(command.signature);
        if (name_width > max_name_width) max_name_width = name_width;
        if (sig_width  > max_sig_width)  max_sig_width  = sig_width;
    }
    for (size_t i = 0; i < commands->count; ++i) {
        Command command = commands->items[i];
        printf("  :%-*s %-*s - %s\n",
               max_name_width, command.name,
               max_sig_width,  command.signature,
               command.description);
    }
}

void gc_mark(Expr_Index root)
{
    if (expr_slot(root).visited) return;
    expr_slot(root).visited = true;
    switch (expr_slot(root).kind) {
    case EXPR_MAG:
    case EXPR_VAR:
        break;
    case EXPR_FUN:
        gc_mark(expr_slot(root).as.fun.body);
        break;
    case EXPR_APP:
        gc_mark(expr_slot(root).as.app.lhs);
        gc_mark(expr_slot(root).as.app.rhs);
        break;
    default: UNREACHABLE("Expr_Kind");
    }
}

typedef struct {
    Symbol name;
    Expr_Index body;
} Binding;

typedef struct {
    Binding *items;
    size_t count;
    size_t capacity;
} Bindings;

// ============================================================================
// TURING GAS / COMBINATOR SOUP
// ============================================================================

// Gas Pool: A dynamic array of expressions that serves as the "primordial soup"
static struct {
    Expr_Index *items;
    size_t count;
    size_t capacity;
} gas_pool = {0};

// ============================================================================
// SPATIAL GRID SYSTEM (Cellular Automata + Lambda Calculus)
// ============================================================================

// Forward declarations for grid functions that need functions defined later
Expr_Index generate_rich_combinator(int current_depth, int max_depth, const char **env, int env_count);
bool is_identity(Expr_Index expr);
void expr_display_no_tags(Expr_Index expr, String_Builder *sb);

// Metabolic Model Constants
#define MAX_AGE 100
#define COSMIC_RAY_RATE 0  // Disabled by default. Set to 5 for 0.5% spawn chance per empty cell per step

typedef struct {
    Expr_Index atom;
    bool occupied;
    int age;          // Steps survived
    int generation;   // How many ancestors
} Cell;

typedef struct {
    int width;
    int height;
    Cell *cells;
    long steps;
    // Statistics
    long reactions_success;
    long reactions_diverged;
    long movements;
    long deaths_age;      // Deaths from old age
    long cosmic_spawns;   // Spontaneous generations
} Grid;

// Global active grid (for now, just one)
static Grid active_grid = {0};

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

// Forward declarations for grid functions (defined after eval_bounded)
void grid_step(Grid *g, Bindings bindings, size_t eval_steps, size_t max_mass);
size_t grid_analyze(Grid *g, bool verbose);
void grid_render(Grid *g, bool clear_screen);
bool grid_export_log(Grid *g, const char *filename, bool append);
bool grid_save_soup(Grid *g, const char *filename);

// Track total simulation steps for soup dump metadata
static long gas_total_steps = 0;

// Calculate the "mass" or complexity of an expression (number of AST nodes)
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

// Generates a "Closed" expression (no free variables).
// This ensures every molecule is a valid function, not just data.
// Based on AlChemy paper's probabilistic grammar approach.
Expr_Index generate_rich_combinator(int current_depth, int max_depth, const char **env, int env_count) {
    // 1. HARD STOP: If we hit depth limit, we MUST pick a variable.
    if (current_depth >= max_depth) {
        if (env_count > 0) {
            return var(symbol(env[rand() % env_count]));
        } else {
            // Emergency fallback if depth hit but no variables exist (unlikely if logic is right)
            return fun(symbol("x"), var(symbol("x")));
        }
    }

    // 2. LOGIC: Determine available moves
    bool can_pick_var = (env_count > 0);
    // We force growth if we are shallow (less than 30% of max depth)
    bool force_growth = (current_depth < (max_depth / 3)); 
    
    // 3. WEIGHTED CHOICE
    // If no variables bound yet, we MUST Abstract to create one.
    if (env_count == 0) {
        // Must Abstract
    } 
    // Otherwise, roll dice. 
    // Bias: Application (50%), Abstraction (30%), Variable (20%)
    else {
        int r = rand() % 100;
        
        if (force_growth) {
            // Early game: 60% App, 40% Abs, 0% Var
            if (r < 60) goto do_app;
            else        goto do_abs;
        } else {
            // Late game: 50% App, 30% Abs, 20% Var
            if (r < 50) goto do_app;
            if (r < 80) goto do_abs;
            return var(symbol(env[rand() % env_count]));
        }
    }

do_abs:;
    // Abstraction: \new_param. Body
    char buf[32];
    snprintf(buf, sizeof(buf), "v%d", env_count);
    const char *param_name = intern_label(buf);

    const char *new_env[64];
    if (env_count >= 63) return fun(symbol("x"), var(symbol("x"))); // Safety
    
    for(int i=0; i<env_count; ++i) new_env[i] = env[i];
    new_env[env_count] = param_name;

    return fun(
        symbol(param_name),
        generate_rich_combinator(current_depth + 1, max_depth, new_env, env_count + 1)
    );

do_app:;
    // Application: (A B)
    return app(
        generate_rich_combinator(current_depth + 1, max_depth, env, env_count),
        generate_rich_combinator(current_depth + 1, max_depth, env, env_count)
    );
}

// Helper to detect identity function \x.x
bool is_identity(Expr_Index expr) {
    if (expr_slot(expr).kind == EXPR_FUN) {
        Symbol p = expr_slot(expr).as.fun.param;
        Expr_Index body = expr_slot(expr).as.fun.body;
        if (expr_slot(body).kind == EXPR_VAR) {
            return symbol_eq(p, expr_slot(body).as.var);
        }
    }
    return false;
}

void create_binding(Bindings *bindings, Symbol name, Expr_Index body)
{
    for (size_t i = 0; i < bindings->count; ++i) {
        if (symbol_eq(bindings->items[i].name, name)) {
            bindings->items[i].body = body;
            return;
        }
    }
    Binding binding = {
        .name = name,
        .body = body,
    };
    da_append(bindings, binding);
}

bool create_bindings_from_file(const char *file_path, Bindings *bindings)
{
    static String_Builder sb = {0};
    static Lexer l = {0};

    sb.count = 0;
    if (!read_entire_file(file_path, &sb)) return false;

    lexer_init(&l, sb.items, sb.count, file_path);

    if (!lexer_peek(&l)) return false;
    while (l.token != TOKEN_END) {
        if (!lexer_expect(&l, TOKEN_NAME)) return false;
        Symbol name = symbol(l.string.items);
        if (!lexer_expect(&l, TOKEN_EQUALS)) return false;
        Expr_Index body;
        if (!parse_expr(&l, &body)) return false;
        if (!lexer_expect(&l, TOKEN_SEMICOLON)) return false;
        create_binding(bindings, name, body);
        if (!lexer_peek(&l)) return false;
    }
    return true;
}

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

static volatile sig_atomic_t ctrl_c = 0;
void ctrl_c_handler(int signum)
{
    UNUSED(signum);
    ctrl_c = 1;
}

void replace_active_file_path_from_lexer_if_not_empty(Lexer l, char **active_file_path)
{
    const char *path_data = &l.content[l.cur.pos];
    size_t path_count = l.count - l.cur.pos;
    while (path_count > 0 && isspace(*path_data)) {
        path_data++;
        path_count--;
    }
    while (path_count > 0 && isspace(path_data[path_count - 1])) {
        path_count--;
    }

    if (path_count > 0) {
        free(*active_file_path);
        *active_file_path = copy_string_sized(path_data, path_count);
    }
}

typedef enum { EVAL_DONE, EVAL_LIMIT, EVAL_ERROR } Eval_Result;

Eval_Result eval_bounded(Expr_Index start, Expr_Index *out, size_t limit, size_t max_mass) {
    Expr_Index curr = start;
    for (size_t i = 0; i < limit; ++i) {
        // SAFETY CHECK: If the molecule gets too big, it's "unstable" -> kill it.
        // Prevents eval1() from choking on massive substitutions / deep copies.
        if (max_mass > 0 && expr_mass(curr) > max_mass) return EVAL_LIMIT;

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

// ============================================================================
// GRID FUNCTION IMPLEMENTATIONS (after eval_bounded for dependency reasons)
// ============================================================================

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
                g->deaths_age++;
                continue; // Slot is now empty, skip to next
            }
        }
        
        // --- COSMIC RAYS (Spontaneous Generation) ---
        if (!g->cells[curr_idx].occupied) {
            if ((rand() % 1000) < COSMIC_RAY_RATE) {
                g->cells[curr_idx].atom = generate_rich_combinator(0, 3, NULL, 0);
                g->cells[curr_idx].occupied = true;
                g->cells[curr_idx].age = 0;
                g->cells[curr_idx].generation = 0;
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
                // A stays where it is (catalytic)
                // B becomes the result (mutation)
                g->cells[target_idx].atom = result;
                g->cells[target_idx].age = 0;  // Rejuvenate: it's a new creature
                g->cells[target_idx].generation++;
                g->reactions_success++;
            } else {
                // Divergence/Explosion: The victim B dies from instability
                // A survives (it was the catalyst)
                g->cells[target_idx].occupied = false;
                g->reactions_diverged++;
            }
        }
    }

    free(indices);
    g->steps++;
    
    // Periodic GC
    if (g->steps % 10 == 0) {
        gc(var(symbol("_dummy")), bindings);
    }
}

// Helper: Comparator for qsort (forward declare for grid_analyze)
int compare_strings(const void *a, const void *b);
char *expr_to_string(Expr_Index expr);

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
// END GRID FUNCTION IMPLEMENTATIONS
// ============================================================================

// Helper: Comparator for qsort
int compare_strings(const void *a, const void *b) {
    return strcmp(*(const char **)a, *(const char **)b);
}

// Helper: Convert expression to malloc'd string
char *expr_to_string(Expr_Index expr) {
    String_Builder sb = {0};
    expr_display(expr, &sb);
    sb_append_null(&sb);
    return sb.items; // Ownership transferred to caller
}

// Display expression without tags (for serialization)
void expr_display_no_tags(Expr_Index expr, String_Builder *sb)
{
    switch (expr_slot(expr).kind) {
    case EXPR_VAR:
        sb_appendf(sb, "%s", expr_slot(expr).as.var.label);
        // Skip tag output
        break;
    case EXPR_FUN:
        sb_appendf(sb, "\\");
        while (expr_slot(expr).kind == EXPR_FUN) {
            sb_appendf(sb, "%s.", expr_slot(expr).as.fun.param.label);
            // Skip tag output
            expr = expr_slot(expr).as.fun.body;
        }
        expr_display_no_tags(expr, sb);
        break;
    case EXPR_APP: {
        Expr_Index lhs = expr_slot(expr).as.app.lhs;
        bool lhs_paren = expr_slot(lhs).kind == EXPR_FUN;
        if (lhs_paren) sb_appendf(sb, "(");
        expr_display_no_tags(lhs, sb);
        if (lhs_paren) sb_appendf(sb, ")");

        sb_appendf(sb, " ");

        Expr_Index rhs = expr_slot(expr).as.app.rhs;
        bool rhs_paren = expr_slot(rhs).kind != EXPR_VAR && expr_slot(rhs).kind != EXPR_MAG;
        if (rhs_paren) sb_appendf(sb, "(");
        expr_display_no_tags(rhs, sb);
        if (rhs_paren) sb_appendf(sb, ")");
    } break;
    case EXPR_MAG: {
        sb_appendf(sb, "#%s", expr_slot(expr).as.mag);
    } break;
    default: UNREACHABLE("Expr_Kind");
    }
}

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
// ----------------------------

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


#ifndef LAMB_TEST
int main(int argc, char **argv)
{
    static char buffer[1024];
    static Commands commands = {0};
    static Bindings bindings = {0};
    static Lexer l = {0};

#ifndef _WIN32
    // TODO(20251221-171559): Handle ctrl+c on Windows
    //   signal() seem to be a standard thing https://en.cppreference.com/w/c/program/signal.html
    //   Yet Linux man pages say it's not portable. We need to start that out.
    struct sigaction act = {0};
    act.sa_handler = ctrl_c_handler;
    sigaction(SIGINT, &act, NULL);
#endif // _WIN32

    srand((unsigned)time(NULL));

    const char *editor  = getenv("LAMB_EDITOR");
    if (!editor) editor = getenv("EDITOR");
    if (!editor) editor = "vi";

    // NOTE: `active_file_path` is always located on the heap. If you need to replace it, first free() it
    // and then copy_string() it.
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
    printf(" W-W'\n");
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
                // First, we need to advance past any whitespace in the lexer
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
                    if (ctrl_c) goto again; // TODO(20251220-002405)

                    printf("DEBUG: ");
                    trace_expr(expr);
                    printf("\n");

                    printf("-> ");
                    fflush(stdin);

                    // TODO: get rid of the debug REPL. Just make it step through expressions by pressing Enter.
                    // Cancelling debug mode should be Ctrl+C which means we must sort it out on Windows.
                    // See 20251221-171559.
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
                    if ((it + 1) % log_interval == 0) {
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
                // TODO(20251220-002405): Is there perhaps a better way to cancel evaluation by utilizing long jumps from signal handlers?
                // Is that even legal?
                // https://www.gnu.org/savannah-checkouts/gnu/libc/manual/html_node/Longjmp-in-Handler.html
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
#endif // LAMB_TEST

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
