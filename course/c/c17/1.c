#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HEXDUMP_CHARS_PER_LINE 16

typedef struct Pls{
    size_t len;
    // char *str;
    char other[21];
} Pls;

void hexdump(void *data, size_t size) {
    unsigned char *ptr = data;
    size_t i;

    size_t pos = 0;
    for (i = 0; i < size; i++) {
        printf("%02x ", ptr[i]);
        if ((i + 1) % 8 == 0) {
            printf(" ");
        }

        if ((i + 1) % HEXDUMP_CHARS_PER_LINE == 0) {
            printf("\t");
            for (size_t j = pos; j < i; j++) {
                int c = isprint(ptr[j]) ? ptr[j] : '.';
                printf("%c", c);
            }
            printf("\n");
            pos = i + 1;
        }
    }
    if (size % HEXDUMP_CHARS_PER_LINE != 0) printf("\n");
}

int main(void) {

    Pls s;

    memset(&s, 0, sizeof(s));

    s.len = 23;
    // s.str = malloc(s.len);
    // memcpy(s.str, "Hello", 6);
    // printf("%p\n", s.str);
    memcpy(s.other, "Hello World!", 12);
    hexdump(&s, sizeof(s));
   // free(s.str);

    return 0;
}
