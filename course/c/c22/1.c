#include <stdio.h>

int main(int argc, char **argv) {
    printf("%d\n", argc);
    argc++;
    if (argc == 3) {
        printf("Hello World!");
        return 0;
    }

    // function pointer declaration and initialization
    int (*main_ptr)(int argc, char **argv) = main;
    main_ptr(argc, argv);

    return 0;
}
