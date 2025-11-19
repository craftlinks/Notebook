#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <ctype.h>
#include <limits.h>
#include <string.h>
#include <assert.h>

/* ================= Data Structures ================= */

#define TFO_TYPE_INT 0
#define TFO_TYPE_FLOAT 1
#define TFO_TYPE_STRING 2
#define TFO_TYPE_LIST 3
#define TFO_TYPE_BOOL 4
#define TFO_TYPE_SYMBOL 5


typedef struct tfo{
    int ref_count;
    int type; // TFO_TYPE_*
    union {
        int i;
        struct {
            char *s;
            size_t len;
        } str;
        struct {
            struct tfo **ele;
            size_t len;
        } list;
    };
} tfo;


typedef struct tf_parser {
    char *prg; // The program to compile
    char *ch; // The next character to be parsed
} tf_parser;

typedef struct tf_ctx tf_ctx;

typedef struct {
    char *name;
    void (*func)(tf_ctx *ctx, tfo *name);
    tfo *user_list;
} FunctionTableEntry;

typedef struct FunctionTable{
    struct FunctionTableEntry **func_table;
    size_t func_count;
} FunctionTable;

struct tf_ctx {
    tfo *stack;
    struct FunctionTable func_table;

};

/* ============ Utility Functions ============ */

void *xmalloc(size_t size) {
    void *ptr = malloc(size);
    if (!ptr) {
        fprintf(stderr, "Out of memory allocating %zu bytes failed\n", size);
        exit(EXIT_FAILURE);
    }
    return ptr;
}

FILE *xfopen(const char *filename, const char *mode) {
    FILE *fp = fopen(filename, mode);
    if (!fp) {
        fprintf(stderr, "Failed to open file '%s'\n", filename);
        exit(EXIT_FAILURE);
    }
    return fp;
}

/* ================= Utility functions ================= */

// Allocate and initialize a new tfo object
tfo *create_tfo(int type) {
    tfo *obj = xmalloc(sizeof(tfo));
    obj->ref_count = 1;
    obj->type = type;
    return obj;
}


tfo *create_tfo_string(char *s, size_t len) {
    tfo *o = create_tfo(TFO_TYPE_STRING);
    o->str.s = xmalloc(len + 1);
    memcpy(o->str.s, s, len);
    o->str.s[len] = '\0';
    o->str.len = len;
    return o;
}

tfo *create_tfo_int(int i) {
    tfo *o = create_tfo(TFO_TYPE_INT);
    o->i = i;
    return o;
}

tfo *create_tfo_symbol(char *s, size_t len) {
    tfo *o = create_tfo_string(s, len);
    o->type = TFO_TYPE_SYMBOL;
    return o;
}

tfo *create_tfo_float(float f) {
    tfo *o = create_tfo(TFO_TYPE_FLOAT);
    o->i = f;
    return o;
}

tfo *create_tfo_bool(int b) {
    tfo *o = create_tfo(TFO_TYPE_BOOL);
    o->i = b;
    return o;
}

void retain(tfo *o) {
    if (!o) return;
    o->ref_count++;
}

void free_tfo(tfo *o);

void release(tfo *o) {
    if (!o) return;
    assert(o->ref_count > 0);
    o->ref_count--;
    if (o->ref_count == 0) {
        free_tfo(o);
    }
}

void free_tfo(tfo *o) {
    if (!o) return;
    assert(o->ref_count == 0);
    switch (o->type) {
        case TFO_TYPE_SYMBOL:
        case TFO_TYPE_STRING:
            free(o->str.s);
            break;
        case TFO_TYPE_LIST:
            for (size_t i = 0; i < o->list.len; i++) {
                release(o->list.ele[i]);
            }
            free(o->list.ele);
            break;
        case TFO_TYPE_INT:
        case TFO_TYPE_FLOAT:
        case TFO_TYPE_BOOL:
            // No extra data to free
            break;
    }
    free(o);
}

void print_tfo(tfo *o) {
    switch (o->type) {
        case TFO_TYPE_LIST:
            printf("[");
            for (size_t i = 0; i < o->list.len; i++) {
                struct tfo *element = o->list.ele[i];
                print_tfo(element);
                if (i < o->list.len - 1) {
                    printf(" ");
                }
            }
            printf("]");
            break;

        case TFO_TYPE_INT:
            printf("%d", o->i);
            break;
        case TFO_TYPE_SYMBOL:
            printf("%s", o->str.s);
            break;
        case TFO_TYPE_STRING:
            printf("\"%s\"", o->str.s);
            break;
        default:
            printf("Unknown type\n");
            break;
    }

}

/* ================List object================== */

tfo *create_tfo_list(void) {
    tfo *o = create_tfo(TFO_TYPE_LIST);
    o->list.ele = NULL;
    o->list.len = 0;
    return o;
}

void add_element_to_list(tfo *list, tfo *element) {
    if (!list || list->type != TFO_TYPE_LIST) return;

    size_t new_len = list->list.len + 1;
    tfo **new_ele = realloc(list->list.ele, new_len * sizeof(tfo *));

    if (!new_ele) {
        fprintf(stderr, "Failed to reallocate memory for list element\n");
        exit(EXIT_FAILURE);
    }
    
    list->list.ele = new_ele;
    list->list.ele[list->list.len] = (struct tfo *)element;
    list->list.len = new_len;
}

/* ===================Compile=================== */

void parser_skip_whitespace(tf_parser *parser) {
    while (isspace(*parser->ch)) parser->ch++;
}


#define MAX_NUM_LEN 10
tfo *parse_number(tf_parser *parser) {
    int64_t i = 0;
    int j = 0;
    int sign = 1;

    if (parser->ch[0] == '-') {
        sign = -1;
        parser->ch++;
    }

    while (isdigit(parser->ch[0])) {
        int digit = parser->ch[0] - '0';

        // Check for overflow before doing the multiplication and addition
        if (sign == 1) {
            // For positive numbers: check against INT_MAX
            if (i > (INT_MAX - digit) / 10) {
                printf("Error: Overflow occurred while parsing number ...\n");
                return NULL; // Overflow would occur
            }
        } else {
            // For negative numbers: check against INT_MIN
            if (i < (INT_MIN + digit) / 10) {
                printf("Error: Underflow occurred while parsing number ...\n");
                return NULL; // Underflow would occur
            }
        }

        i = i * 10 + sign * digit;
        parser->ch++;
        j++;
    }
    if (j == 0) {
        printf("Error: Invalid number format ...\n");
        return NULL;
    }

    return create_tfo_int((int)i);
}

int is_symbol_char(int c) {
    char symbol_chrs[] = "+-*/%";
    if (isalpha(c)) {
        return 1;
    } else if (strchr(symbol_chrs, c) != NULL) {
        return 1;
    } else {
        return 0;
    }
}

tfo *parse_symbol(tf_parser *parser) {
    char *start = parser->ch;
    while(parser->ch[0] && is_symbol_char(parser->ch[0])) {
        parser->ch++;
    }
    return create_tfo_symbol(start, parser->ch - start); // Pointer arithmetic
}

tfo *parse_string(tf_parser *parser) {
    char *start = parser->ch;
    while(parser->ch[0] && parser->ch[0] != '"') {
        parser->ch++;
    }
    if (parser->ch[0] == '\0') {
        printf("Error: Unterminated string ...\n");
        return NULL;
    }
    parser->ch++;
    return create_tfo_string(start, parser->ch - start - 2); // Pointer arithmetic
}

tfo *compile(char *prg_text) {
    tf_parser parser;

    tfo *parsed = create_tfo_list();

    parser.prg = prg_text;
    parser.ch = prg_text;
    char *token_start = parser.ch;

    while (parser.ch) {
        token_start = parser.ch;
        tfo *o;

        parser_skip_whitespace(&parser);
        if (parser.ch[0] == '\0') break;
        if (isdigit(parser.ch[0]) || parser.ch[0] == '-') {
            o = parse_number(&parser);
        } else if (is_symbol_char(parser.ch[0])) {
            o = parse_symbol(&parser);
        } else {
            o = NULL;
        }

        if (o == NULL) {
            release(parsed);
            printf("Error: Syntax error near: %s...\n", token_start);
            exit(1);
        } else {
            add_element_to_list(parsed, o);
        }
    }

    return parsed;
}

tf_ctx *create_context() {
    tf_ctx *ctx = xmalloc(sizeof(*ctx));
    ctx->stack = create_tfo_list();
    ctx->func_table.func_table = NULL;
    ctx->func_table.func_count = 0;
    return ctx;
}

void free_context(tf_ctx *ctx) {
    if (!ctx) return;
    release(ctx->stack);
    // In the future, we would free the function table here as well.
    free(ctx);
}


int call_symbol(tf_ctx *ctx, tfo *symbol) {
    // https://youtu.be/oMj3N6jYIUU?si=brgSq6LrKX0oqJ6b&t=1159
    printf("%s\n", symbol->str.s);
    return 0;
}

void exec(tf_ctx *ctx, tfo *prg) {
    assert(prg != NULL && prg->type == TFO_TYPE_LIST);

    for (size_t i = 0; i < prg->list.len; i++) {
        struct tfo *word = prg->list.ele[i];
        switch (word->type) {
            case TFO_TYPE_SYMBOL:
                call_symbol(ctx, word);
                break;
            default:
                add_element_to_list(ctx->stack, word);
                retain(word);
                break;
        }
    }

}

/* ==================== Main ================== */

int main(int argc, char **argv) {

    if (argc != 2) {
        fprintf(stderr, "Usage: %s <filename>\n", argv[0]);
        return 1;
    }

    FILE *fp = xfopen(argv[1],"r");

    fseek(fp, 0, SEEK_END);
    size_t file_size = ftell(fp);
    char *prg_text = xmalloc(file_size + 1);
    fseek(fp, 0, SEEK_SET);
    fread(prg_text, 1, file_size, fp);
    prg_text[file_size] = '\0';
    fclose(fp);

    tfo *compiled_program = compile(prg_text);
    free(prg_text);

    print_tfo(compiled_program);
    printf("\n");

    tf_ctx *ctx = create_context();
    exec(ctx, compiled_program);

    printf("Stack content at end: ");
    print_tfo(ctx->stack);
    printf("\n");

    release(compiled_program);
    free_context(ctx);

    return 0;

}