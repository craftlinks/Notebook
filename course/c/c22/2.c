#include <stdio.h>

void hello(void) {
    printf("Hello, World!\n");
}

void goodbye(void) {
    printf("Goodbye, World!\n");
}

void call_n_times(void (*f)(void), int n) {
    while (n--) {
        f();
    }
}

int main(void) {
    // function pointer declaration
    // void (*f)(void);

    call_n_times(hello, 3);
    call_n_times(goodbye, 2);

    return 0;
}
