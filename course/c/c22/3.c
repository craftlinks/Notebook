#include <stdio.h>
#include <stdlib.h>

int compare_int(const void *a, const void *b) {
    int aa = *(int *)a;
    int bb = *(int *)b;

    if (aa == bb) {
        return 0;
    }
    return aa < bb ? -1 : 1;
}


int main(void) {
    int a[10];
    for (int i = 0; i < 10; i++) {
        a[i] = rand() & 15;
    }
    for (int i = 0; i < 10; i++) {
        printf("%d ", a[i]);
    }

    printf("\n");

    qsort(a, 10, sizeof(int), compare_int);

    for (int i = 0; i < 10; i++) {
        printf("%d ", a[i]);
    }

    printf("\n");
}
