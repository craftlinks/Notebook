#include <stdio.h>
#include <unistd.h>
#include <string.h>
#include <fcntl.h> // (file descriptor) open
#include <sys/mman.h> // memory management: mmap, munmap
#include <sys/stat.h> // for fstat

int main(void) {
    char *mystr = "Hello World!\n";
    size_t len = strlen(mystr);
    for (size_t i = 0; i < len; i++) {
        putchar(mystr[i]);
        fflush(stdout);
        usleep(100000);
    }
    sleep(2);

    int fd = open("1.c", O_RDONLY);
    printf("Open file descriptor: %d\n", fd);

    // Get the file size
    struct stat sb;
    if (fstat(fd, &sb) == -1) {
        perror("fstat");
        close(fd);
        return 1;
    }

    void *mem = mmap(NULL, sb.st_size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (mem == MAP_FAILED) {
        perror("mmap");
        return 1;
    }
    printf("File mapped at address: %p\n", mem);
    char *s = (char *)mem;

    printf("File content:\n%s\n", s);

    munmap(mem, sb.st_size);
    close(fd);
    return 0;
}
