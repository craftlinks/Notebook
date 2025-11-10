#include <stdio.h>
#include <stdlib.h>


typedef struct node {
    int val;
    struct node *left, *right;
} node;

// using recursion, consuming the stack
node *add(node *root, int val) {

    node *new = malloc(sizeof(*new));
    new->left = new->right = NULL;
    new->val = val;

    if (root == NULL) {
        return new;
    }

    if (val < root->val) {
        root->left = add(root->left, val);
    } else {
        root->right = add(root->right, val);
    }

    return root;

}

void print_sorted(node *root) {
    if (root == NULL) {
        return;
    }

    print_sorted(root->left);
    printf("%d ", root->val);
    print_sorted(root->right);
}

int main(void) {
    node *root = NULL;

    root = add(root, 10);
    root = add(root, 3);
    root = add(root, 7);
    root = add(root, 2);
    root = add(root, 4);
    root = add(root, 6);
    root = add(root, 8);
    print_sorted(root);
    printf("\n");
    return 0;
}
