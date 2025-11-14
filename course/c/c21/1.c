#include <stdio.h>
#include <string.h>
#include <limits.h>

typedef struct {
    int i;
    unsigned char a[4];
} S;

typedef struct {
    union {
        int i;
        unsigned char a[4];
    };
} U;


// Bitfields
typedef struct {
    unsigned char a:4; // 4 bit
    unsigned char b:4; // 4 bit
    unsigned char c:8; // 8 bit
} B;



int main(void) {

    // S s = {10, {1, 2, 3, 4}};
    S s;
    s.i = 10;
    memcpy(s.a, "\x01\x02\x03\x04", sizeof(s.a));
    printf("%d %d %d %d\n", s.a[0], s.a[1], s.a[2], s.a[3]);
    memcpy(s.a, "abcd", sizeof(s.a));
    printf("%c %c %c %c\n", s.a[0], s.a[1], s.a[2], s.a[3]);

    U u;
    u.i = INT_MAX;
    printf("%d\n", u.i);
    printf("%d, %d, %d, %d\n", u.a[0], u.a[1], u.a[2], u.a[3]);
    u.i = INT_MIN;
    printf("%d\n", u.i);
    printf("%d, %d, %d, %d\n", u.a[0], u.a[1], u.a[2], u.a[3]);

    printf("%zu\n", sizeof(B));

    return 0;
}
