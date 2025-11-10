#include <stdint.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>


typedef struct pls {
    uint32_t len;
    uint32_t ref_count;
    uint32_t magic;
    char str[]; // `char *str`, instead would be uinitialised and give me errors!!
} pls;

char *ps_create(char *s, size_t len) {

    pls *_pls = malloc(sizeof(pls) + len + 1);

    for (size_t i=0; i < len; i++) {
        _pls->str[i] = s[i];
    }
    _pls->len = len;
    _pls->ref_count = 1;
    _pls->str[len] = 0;
    return _pls->str;
}

void ps_print(char *s) {
    pls *p = (pls *)(s - sizeof(*p));
    for (size_t i=0; i < p->len; i++) {
        putchar(p->str[i]);
    }
    printf("\n");
}

void ps_release(char *s) {
    pls *p = (pls *)(s - sizeof(*p));
    if (p->ref_count == 0) {
        printf("ABORTED ON RETAIN STRING ERROR\n");
        exit(1);
    }
    if (--p->ref_count == 0) {
        free(p);
    }
}

void ps_retain(char *s) {
    pls *p = (pls *)(s - sizeof(*p));
    if (p->ref_count == 0) {
        printf("ABORTED ON FREE ERROR\n");
        exit(1);
    }

    p->ref_count++;
}

size_t ps_len(char *s) {
    pls *p = (pls *)(s - sizeof(*p));
    return p->len;
}

char *global_string;

int main(void) {
    char *my_str = ps_create("Hello, World!", 13);
    global_string = my_str;
    ps_retain(my_str);
    ps_print(my_str);
    ps_release(my_str);
    ps_print(global_string);
    ps_release(my_str);
    return 0;
}

// continue at 18:00
