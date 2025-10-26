#include <stdio.h>

int sum(int a, int b){
    return a + b;
}

int main(void) {
    int a, b, c;
    a = 1;
    b = 2;
    c = a + b;

    printf("Hello, World > %d ; %d\n", sum(1, 2), c);
    return 0;
}

// Enable warnings
// ❯ cc -O2 -W -Wall 2.c

/* print out the program's return value
 * ❯ ./a.out; echo $?
 Hello, World > 3 ; 3
 0
 */
