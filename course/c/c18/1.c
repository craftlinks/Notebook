#include <stdio.h>

typedef int errorcode;

typedef struct {
    int n;
    int d;
} fract;

typedef fract *fractptr;

errorcode foo(void) {
    return -20;
}

int main(void) {
    errorcode a = foo();
    printf("Error code: %d\n", a);
    fract f;
    fractptr fp = &f;
    f.n = 1;
    f.d = 2;
    printf("Fraction: %d/%d is stored at %p\n", f.n, f.d, fp);

    return 0;
}
