#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

#define PS_HEADER_TYPE uint32_t
#define MAX_LEN 256
#define PS_HEADER_SIZE sizeof(PS_HEADER_TYPE)


void ps_init(char *buf, char *str, size_t len) {
    if (len > MAX_LEN) {
        len = MAX_LEN;
    }

    buf += PS_HEADER_SIZE;

    for (size_t j=0; j<len; j++) {
        buf[j] = str[j]; // We should use memcpy() here.
    }
    buf[len] = 0;

}

char *ps_create(char *str, size_t len) {
    if (len > MAX_LEN) {
        len = MAX_LEN;
    }

    char *buf = malloc(PS_HEADER_SIZE + len + 1);
    if (buf == NULL) {
        return NULL;
    }

    PS_HEADER_TYPE *len_ptr = (PS_HEADER_TYPE *)buf;
    *len_ptr = len; // here we set the length of the string
    ps_init(buf, str, len);

    return buf + PS_HEADER_SIZE;
}

void ps_println(char *buf) {
    PS_HEADER_TYPE len = *(PS_HEADER_TYPE *)(buf - PS_HEADER_SIZE);

    for (size_t j = 0; j < (size_t)len; j++) {
        putchar(buf[j]);
    }
    printf("\n");
}

PS_HEADER_TYPE ps_len(char *buf) {
    return *(PS_HEADER_TYPE *)(buf - PS_HEADER_SIZE);
}

void ps_free(char *buf) {
    free(buf - PS_HEADER_SIZE);
}

int main(void) {
    char *buf = ps_create("Hello World!", 12);
    ps_println(buf);
    printf("%s\n", buf);
    size_t len = ps_len(buf);
    printf("Length: %d\n", (int)len);
    ps_free(buf);
    return 0;
}
