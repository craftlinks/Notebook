#include <stdio.h>

int main(void) {
    int i = 10;

    switch (i) {
        case 1:
            // int a = 10;  can't do
            printf("One\n");
            printf("1\n");
            break;
        case 2:
        {
            int a = 10; // can do
            printf("Two\n");
            printf("2\n");
            break;
        }
        default:
            printf("Other\n");
            break;
    }
}
