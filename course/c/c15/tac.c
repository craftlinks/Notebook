#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>

typedef struct line {
    char *s;
    struct line *next;
} line;

int main(int argc, char **argv) {
    #if 0
    for (int i = 0; i < argc; i++) {
        printf("%d: %s\n", i, argv[i]); // or, `*(argv + i)`
    }
    #endif
    if (argc != 2) {
        printf("Usage: %s <file>\n", argv[0]);
        return 1;
    }

    FILE *fp = fopen(argv[1], "r");
    if (!fp) {
        printf("fopen failed for: %s\n", argv[1]);
        return 1;
    }

    char buf[1024];

    line *head = NULL;
    while(fgets(buf, sizeof(buf), fp)) {
        line *l = malloc(sizeof(line));

        size_t line_len = strlen(buf);

        l->s = malloc(line_len + 1);
        for (size_t i = 0; i <= line_len; i++) {
            l->s[i] = buf[i];
        }
        l->next = head;
        head = l;
        // printf("%s", buf);
    }

    while(head) {
        printf("%s", head->s);
        free(head->s);
        line *tmp = head;
        head = head->next;
        free(tmp);
    }
    free(head);

    fclose(fp);

    return 0;
}
