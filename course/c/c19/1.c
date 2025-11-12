#include <stdio.h>
#include <fcntl.h>
#include <unistd.h> // Unix standard


int main(void) {
    int fd = open("1.c", O_RDONLY);
    if (fd < 0) {
        perror("Unable to open file");
        return 1;
    }

    char buf[1024];
    ssize_t nread;

    while(1) {
        nread = read(fd, buf, sizeof(buf));
        if (nread == -1) {
            perror("Unable to read file");
            return 0;
        }
        if (nread == 0)  break;
        // Process the data in buf
        printf("%s", buf);
        break;
    }
    close(fd);
    return 0;
}
