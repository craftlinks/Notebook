#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <ctype.h>
#include <limits.h>

/* ================= Data Structures ================= */

#define TFO_TYPE_INT 0
#define TFO_TYPE_FLOAT 1
#define TFO_TYPE_STRING 2
#define TFO_TYPE_LIST 3
#define TFO_TYPE_BOOL 4
#define TFO_TYPE_SYMBOL 5


typedef struct tfo{
    int refcount;
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

typedef struct tf_ctx {
    tfo *stack;

} tf_ctx;

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
    obj->refcount = 1;
    obj->type = type;
    return obj;
}


tfo *create_tfo_string(char *s, size_t len) {
    tfo *o = create_tfo(TFO_TYPE_STRING);
    o->str.s = s;
    o->str.len = len;
    return o;
}

tfo *create_tfo_int(int i) {
    tfo *o = create_tfo(TFO_TYPE_INT);
    o->i = i;
    return o;
}

tfo *create_tfo_symbol(char *s, size_t len) {
    tfo *o = create_tfo(TFO_TYPE_SYMBOL);
    o->str.s = s;
    o->str.len = len;
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

/* ================List object================== */

tfo *create_tfo_list(void) {
    tfo *o = create_tfo(TFO_TYPE_LIST);
    o->list.ele = NULL;
    o->list.len = 0;
    return o;
}

void add_element_to_list(tfo *list, tfo *element) {
    if (!list || list->type != TFO_TYPE_LIST) return;

    list->list.len++;
    list->list.ele = realloc(list->list.ele, list->list.len * sizeof(tfo *));
    list->list.ele[list->list.len - 1] = (struct tfo *)element;
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

    return create_tfo_int((int)i);
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
        } else {
            o = NULL;
        }

        if (o == NULL) {
            // FIXME: Release resources before exiting
            printf("Error: Syntax error near: %s...\n", token_start);
            exit(1);
        } else {
            add_element_to_list(parsed, o);
        }
    }

    return parsed;
}

void execute_program(tfo *program) {
    printf("[ ");
    for (size_t i = 0; i < program->list.len; i++) {
        struct tfo *element = program->list.ele[i];
        switch (element->type) {
            case TFO_TYPE_INT:
                printf("%d", element->i);
                break;
            default:
                printf("Unknown type\n");
                break;
        }
        printf(" ");
    }
    printf("]\n");
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

    tfo *compiled_program = compile(prg_text);

    execute_program(compiled_program);

    fclose(fp);
    return 0;

}
