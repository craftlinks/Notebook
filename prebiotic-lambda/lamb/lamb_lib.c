// ,---@>
//  W-W'
// LAMB - Lambda Calculus Interpreter Library
// Core engine and shared utilities
#include "lamb.h"

// ============================================================================
// GLOBAL VARIABLES
// ============================================================================

GC_Context GC = {0};

static struct {
    const char **items;
    size_t count;
    size_t capacity;
} labels = {0};

volatile sig_atomic_t ctrl_c = 0;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

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

// ============================================================================
// SYMBOL FUNCTIONS
// ============================================================================

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

// ============================================================================
// EXPRESSION MANAGEMENT
// ============================================================================

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

// ============================================================================
// EXPRESSION DISPLAY
// ============================================================================

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

// Helper: Convert expression to malloc'd string
char *expr_to_string(Expr_Index expr) {
    String_Builder sb = {0};
    expr_display(expr, &sb);
    sb_append_null(&sb);
    return sb.items; // Ownership transferred to caller
}

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

// ============================================================================
// EVALUATION
// ============================================================================

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
// LEXER / PARSER
// ============================================================================

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

// ============================================================================
// REPL HELPERS
// ============================================================================

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

// ============================================================================
// GC
// ============================================================================

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

// Note: The gc() function needs access to gas_pool and active_grid for marking.
// These are defined in the app-specific files. We provide a basic gc() here
// that can be extended or replaced in the apps.
// For now, the apps will need to implement their own gc() that also marks their pools.

// ============================================================================
// COMBINATOR GENERATION
// ============================================================================

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
    UNUSED(can_pick_var);
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

// Detect Church True: λx.λy.x (selects first argument)
// Structure: FUN(x, FUN(y, VAR(x)))
bool is_church_true(Expr_Index expr) {
    if (expr_slot(expr).kind != EXPR_FUN) return false;
    
    Symbol x = expr_slot(expr).as.fun.param;
    Expr_Index inner = expr_slot(expr).as.fun.body;
    
    if (expr_slot(inner).kind != EXPR_FUN) return false;
    
    // Symbol y = expr_slot(inner).as.fun.param;  // Not needed for check
    Expr_Index body = expr_slot(inner).as.fun.body;
    
    // Body should be VAR(x)
    if (expr_slot(body).kind != EXPR_VAR) return false;
    
    return symbol_eq(expr_slot(body).as.var, x);
}

// Detect Church False: λx.λy.y (selects second argument)
// Structure: FUN(x, FUN(y, VAR(y)))
bool is_church_false(Expr_Index expr) {
    if (expr_slot(expr).kind != EXPR_FUN) return false;
    
    // Symbol x = expr_slot(expr).as.fun.param;  // Not needed for check
    Expr_Index inner = expr_slot(expr).as.fun.body;
    
    if (expr_slot(inner).kind != EXPR_FUN) return false;
    
    Symbol y = expr_slot(inner).as.fun.param;
    Expr_Index body = expr_slot(inner).as.fun.body;
    
    // Body should be VAR(y)
    if (expr_slot(body).kind != EXPR_VAR) return false;
    
    return symbol_eq(expr_slot(body).as.var, y);
}

// ============================================================================
// SHARED HELPERS
// ============================================================================

// Helper: Comparator for qsort
int compare_strings(const void *a, const void *b) {
    return strcmp(*(const char **)a, *(const char **)b);
}

// ============================================================================
// GC DIAGNOSTICS
// ============================================================================

size_t gc_slot_count(void) {
    return GC.slots.count;
}

size_t gc_dead_count(void) {
    return GC.dead.count;
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
