#include <stdio.h>

void count(int start, int end) {
    printf("start location: %p; end location: %p\n", &start, &end);
    if (start > end) return;
    printf("%d\n", start);
    count(start + 1, end);
}


int main(void) {
    count(0,9);
    return 0;
}
