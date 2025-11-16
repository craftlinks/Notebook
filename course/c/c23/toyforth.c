#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

/* ================= Data Structures ================= */

#define TFO_TYPE_INT 0
#define TFO_TYPE_FLOAT 1
#define TFO_TYPE_STRING 2
#define TFO_TYPE_LIST 3
#define TFO_TYPE_BOOL 4
#define TFO_TYPE_SYMBOL 5


typedef struct {
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
    char *token; // The next token to parsed
} tf_parser;

typedef struct tf_ctx {
    tfo *stack;

} tf_ctx;

/* ============ Allocation wrappers ============ */

void *xmalloc(size_t size) {
    void *ptr = malloc(size);
    if (!ptr) {
        fprintf(stderr, "Out of memory allocating %zu bytes failed\n", size);
        exit(EXIT_FAILURE);
    }
    return ptr;
}


/* ================= Functions ================= */

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

tfo *create_tfo_list() {
    tfo *o = create_tfo(TFO_TYPE_LIST);
    o->list.ele = NULL;
    o->list.len = 0;
    return o;
}

tfo *create_tfo_bool(int b) {
    tfo *o = create_tfo(TFO_TYPE_BOOL);
    o->i = b;
    return o;
}

/* ================= Main ====================== */

int main(int argc, char **argv) {

    if (argc != 2) {
        fprintf(stderr, "Usage: %s <filename>\n", argv[0]);
        return 1;
    }



}
