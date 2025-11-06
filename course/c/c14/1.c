#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

typedef struct fraction {
    unsigned char color;
    uint32_t numerator;
    uint32_t denominator;
} fraction;


fraction  *create_fraction(uint32_t n, uint32_t d) {
    fraction *f = malloc(sizeof(fraction));

    if (!f) {
        fprintf(stderr, "Memory allocation failed\n");
        exit(EXIT_FAILURE);
    }

    f->numerator = n;
    f->denominator = d;

    return f;
}

void print_fraction(fraction *f) {
    printf("%u/%u\n", f->numerator, f->denominator);
}

void simplify_fraction(fraction *f) {
    for (uint32_t d = 2; d <= f->numerator && d <= f->denominator; d++) {
        while (f->numerator % d == 0 && f->denominator % d == 0) {
            f->numerator /= d;
            f->denominator /= d;
        }
    }
}

int main(void) {

    printf("size of `fraction` in bytes: %zu\n", sizeof(fraction));

    fraction *f = create_fraction(20, 40);
    print_fraction(f);
    simplify_fraction(f);
    print_fraction(f);
    free(f);

#if 0
    uint32_t *f = create_fraction(20, 40);
    simplify_fraction(f);

    print_fraction(f);

    free(f);

    return 0;
#endif
}
