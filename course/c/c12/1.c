#include <stdio.h>
#include<stdlib.h>

#define MAX_LEN 256

void ps_init(char *buf, char *str, int len) {
    if (len > MAX_LEN) {
        len = MAX_LEN;
    }
    buf[0] = len;
    for (int j =0; j < len; j++) {
        buf[j + 1] = str[j];
    }
    buf[len + 1] = 0;

}

char *ps_create(char *str, int len) {
    if (len > MAX_LEN) {
        len = MAX_LEN;
    }

    char *buf = malloc(1 + len + 1);
    if (buf == NULL) {
        return NULL;
    }
    ps_init(buf, str, len);
    return buf;
}

void ps_println(char *buf) {
    int len = buf[0];

    for (int j = 0; j < len; j++) {
        putchar(buf[j + 1]);
    }
    printf("\n");
}

char *ps_getc(char *buf) {
    return buf + 1;
}

int main(void) {
    char *buf = ps_create("Hello World", 11);
    ps_println(buf);
    printf("%s\n", ps_getc(buf));
    free(buf);
    return 0;
}
