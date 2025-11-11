#include <stdio.h>

int main(void) {

    FILE *fp = fopen("2.c", "r");
    if(!fp) {
        printf("Error opening file\n");
        return 1;
    }
    char buf[287];
    size_t nread = fread(&buf, 1, 1024, fp);
    printf("Read %zu bytes\n", nread);

    fclose(fp);
    return 0;
}
