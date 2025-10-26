#include <stdio.h>
#include<limits.h>
#include<stdint.h>

int main(void) {
    char c = 1; // 1 byte -> 8 bits
    short s = 2; // 2 bytes -> 16 bits
    int x = 5; // 4 bytes -> 32 bits
    long l = 10; // 8 bytes -> 64 bits
    printf("Hello World: int is %lu bytes.\nint min: %d - int max: %d\n", sizeof(x), INT_MIN, INT_MAX);

    uint64_t u = 10;

    printf("uint64_t is %lu bytes.\nuint64_t min: %lu - uint64_t max: %lu\n", sizeof(u), 0, UINT64_MAX);

    size_t size = sizeof(u);
    printf("size_t size: %lu bytes.\n", sizeof(size));
    return 0;
}
