#include <stdio.h>

void incr(int *p) {
    *p += 1;
}

int main(void) {
    int x = 5;
    int *y = NULL;
    printf("x is %d\n", x);

    y = &x;

    printf("x is stored at address %p\n", y);

    *y = 10;
    printf("x is now %d\n", x);
    printf("y is now %d\n", *y);

    incr(&x);
    printf("after calling incr, x is now %d\n", x);
    printf("... and y is now %d as well\n", *y);


    return 0;
}
