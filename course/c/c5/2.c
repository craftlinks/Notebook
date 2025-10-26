#include <stdio.h>

int main(void){
    int a[5] = {1, 2, 3, 4, 5};
    char str[10] = {'H', 'e', 'l', 'l', 'o', '\0'};
    char str2[] = "World";
    for(int i = 0; i < 5; i++){
        printf("a[%d] = %d\n", i, a[i]);
    }

    printf("str = %s\n", str);
    int i = 0;
    while(str[i] != '\0'){
        printf("%c", str[i]);
        i++;
    }
    printf(" ");
    printf("%s", str2);
    printf("\n");
    printf("size of str2: %lu", sizeof(str2));
    return 0;
}
