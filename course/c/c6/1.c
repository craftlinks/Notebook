#include <stdio.h>

int main(void) {
    int a = 1;
    {
        int a = 5;
        if(a > 3) printf("inner a > 3\n");
        else printf("inner a <= 3\n");
    }
    if (a > 3) printf("outer a > 3\n");
    else printf("outer a <= 3\n");
    return 0;
}
