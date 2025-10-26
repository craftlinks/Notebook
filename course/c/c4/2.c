#include <stdio.h>

void clear(void) {
    printf("\x1b[H\x1b[2J\x1b[3J");
}

int main(void) {
    clear();
    printf("Hello, World!\n");
    return 0;
}
