#include <stdio.h>

void print_sequence_vanilla(int start, int end) {
    if (start > end) return;
    printf("%d %p\n", start, &start);
    print_sequence_vanilla(start + 1, end);
}

void print_sequence_goto(int start, int end) {
    iterate:
        if (start > end) return;
        printf("%d %p\n", start, &start);
        start++;
        goto iterate;
}

void print_sequence(int start, int end) {
    while (start <= end) {
        printf("%d %p\n", start, &start);
        start++;
    }
}

int main(void) {

    // print a message
    printf("Hello, World!\n");

    printf("Printing a sequence using tail call recursion:\n");
    print_sequence_vanilla(1, 10);

    printf("Printing a sequence using GOTO\n");
    print_sequence_goto(1, 10);

    printf("Printing a sequence using a while loop\n");
    print_sequence(1, 10);

    return 0;
}
