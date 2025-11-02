#include <stdio.h>

int main(void) {
    int x = 10;
    int *y = &x;
    int **z = &y;

    printf("x has value %d\n", x);
    printf("y has value %p, which is the address of x\n", y);
    printf("z has value %p, which is the address of y\n", z);
}
