#include <stdio.h>

// Prefixed-length strings
int main(void) {
    char str[] = "\015Hello, World!"; // first byte is the length of the string in octal (15, 13 in decimal)
    char *ptr = str;
    int len = *ptr++; // read the length of the string, and advance the pointer to the next character
    for (int i = 0; i < len; i++) {
        printf("%c", *ptr++);
    }
    printf("\n");
}
