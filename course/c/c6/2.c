#include <stdio.h>

int main(void) {
    {
        int i = 5;
        printf("inner i(=%d) (%zu bytes) is stored in the stack = %p; pointer size = %zu\n", i, sizeof(i), &i, sizeof(&i));
        {
                int i = 5;
                printf("inner inner i(=%d) (%zu bytes) is stored in the stack = %p; pointer size = %zu\n", i, sizeof(i), &i, sizeof(&i));
        }

    }
    int i = 8;
    printf("outer i(=%d) (%zu bytes) is stored in the stack = %p; pointer size = %zu\n", i, sizeof(i), &i, sizeof(&i));
    return 0;
}
