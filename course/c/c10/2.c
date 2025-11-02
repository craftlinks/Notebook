#include <stdio.h>

int main(void) {
    char string[] = "Hello, World!";
    char *ptr = string;

    printf("at %p I can see: \"%s\"\n", ptr, string);


    char mystr[] = "AABBCCDDEEFF";
    short *p = (short*)mystr;
    printf("65+(65*256) = %d or AA\n", *p);


    /* Pointer arithmetic rule: Incrementing a pointer by 1 moves it to the next memory location of !!__the same type__!! */
    p++;
    printf("66+(66*256) = %d or BB\n", *p);

    printf("At the beginning `ptr` addr is %p\n", ptr);
    char *c_begin = ptr;
    while (*ptr != '\0') {
        putchar(*ptr);
        ptr++;
    }
    printf("\n");

    printf("At the end `ptr` addr is %p\n", ptr);

    char *c_end = ptr;
    printf("Length of string is %ld\n", c_end - c_begin);

    return 0;
}
