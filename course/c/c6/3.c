#include <stdio.h>

int main(void) {
    int i = 0;

    again:
        printf("Hello World_Again: %d!\n", i);
        i++;
        if (i < 5) goto again;

    i = 0;
    while(i <5) {
        printf("While Hello World_%d!\n", i);
        i++;
    }

    i = 0;
    do {
        printf("Do While Hello World_%d!\n", i);
        i++;
    } while (i < 5);

    i = 0;
    for (; i < 5; i++) {
        printf("For Hello World_%d!\n", i);
    }

    i = 0;
    loop:
        if (i >= 5) goto next; // {
            printf("Loop Hello World_%d!\n", i);
            i++;
            goto loop; // }
    next:
        printf("Next Hello World_%d!\n", i);

    return 0;
}
