#include <stdio.h>

// Glbal variable
int x = 0;

void inc(void) {
    // Static variable y is global, and only visible withion this function
    static int y = 0;
    x = x + 1;
    y = y + 1;
    printf("%d, %d\n", x, y);
}

int double_int(int a) {
    a = a + a;
    return a;
}

int main(void) {
    inc();
    inc();
    inc();

    int a = 5;
    /*
    a is passed by value;
    this means that the function receives a copy of the value of a,
    and any changes made to the copy do not affect the original value of a.
    */
    int b = double_int(a);
    printf("original: %d, doubled :%d\n",a, b);
    // printf("%d, %d\n", x, y);
    // ❯ cc -O2 3.c && ./a.out
    // 3.c: In function ‘main’:
    // 3.c:16:27: error: ‘y’ undeclared (first use in this function)
    //    16 |     printf("%d, %d\n", x, y);
    //       |                           ^
    return 0;
}
