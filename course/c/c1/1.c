// #include <stdio.h>

// function prototype
int printf(const char * restrict format, ...);

int main(void) {
    printf("Hello, World!\n");
    return 0;
}

/* > cc --version
cc (GCC) 15.2.1 20250813
Copyright (C) 2025 Free Software Foundation, Inc.
This is free software; see the source for copying conditions.  There is NO
warranty; not even for MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
*/

// cc -o 1.c

/* ❯ file a.out
a.out: ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2, BuildID[sha1]=f5f603a0d2e2d5347dbe2ce70c0291bd8faba1d1, for GNU/Linux 4.4.0, not strippe
*/

/* ❯ ./a.out
Hello, World!
*/

/*
 * generate assembly code
 * > cc -S 1.c
 */
