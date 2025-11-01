#include <stdio.h>
#include <unistd.h>

#define GRID_COLS 25
#define GRID_ROWS 25
#define GRID_SIZE (GRID_COLS * GRID_ROWS)
#define ALIVE '*'
#define DEAD '.'


/*
 * Translate a row and column into the index in the linear array.
 * Wrap around the grid if the cell is outside the grid boundaries.
 */
int cell_to_index(int row, int col) {
    if (row < 0 ) {
        row = (-row) % GRID_ROWS;
        row = GRID_ROWS - row;
    }

    if (col < 0 ) {
        col = (-col) % GRID_COLS;
        col = GRID_COLS - col;
    }

    if (row >= GRID_ROWS) row = row % GRID_ROWS;
    if (col >= GRID_COLS) col = col % GRID_COLS;

    return row * GRID_COLS + col;
}


/* Set a cell at a given position (row, col) in the grid to the specified state */
void set_cell(char *grid, int row, int col, char state) {
    grid[cell_to_index(row, col)] = state;
}

/* Get the state of a cell at a given position (row, col) in the grid */
char get_cell(char *grid, int row, int col) {
    return grid[cell_to_index(row, col)];
}


void print_grid(char *grid) {
    printf("\x1b[H\x1b[2J\x1b[3J"); // Clear terminal screen and move cursor to top-left corner.
    for (int row = 0; row < GRID_ROWS; row++) {
        for (int col = 0; col < GRID_COLS; col++) {
            printf("%c ", get_cell(grid, row, col));
        }
        printf("\n");
    }
}

void set_grid(char *grid, char state) {
    for (int row = 0; row < GRID_ROWS; row++) {
        for (int col = 0; col < GRID_COLS; col++) {
            set_cell(grid, row, col, state);
        }
    }
}

int count_living_neighbors(char *grid, int row, int col) {
    int alive = 0;
    for (int row_offset = -1; row_offset <= 1; row_offset++) {
        for (int col_offset = -1; col_offset <= 1; col_offset++) {
            if (row_offset == 0 && col_offset == 0) continue; // Skip the current cell
            int neighbor_row = row + row_offset;
            int neighbor_col = col + col_offset;
            alive += get_cell(grid, neighbor_row, neighbor_col) == ALIVE;
        }
    }
    return alive;
}

void compute_new_state(char *old_grid, char *new_grid) {
for (int row = 0; row < GRID_ROWS; row++) {
       for (int col = 0; col < GRID_COLS; col++) {
           int alive_neighbors = count_living_neighbors(old_grid, row, col);
           if (get_cell(old_grid, row, col) == ALIVE) {
               set_cell(new_grid, row, col, alive_neighbors == 2 || alive_neighbors == 3 ? ALIVE : DEAD);
           } else {
               set_cell(new_grid, row, col, alive_neighbors == 3 ? ALIVE : DEAD);
           }
       }
   }
}

int main(void) {

    char old_grid[GRID_SIZE] = {}; // Initialize grid with all cells set to DEAD
    char new_grid[GRID_SIZE] = {}; // Initialize grid with all cells set to DEAD

    set_grid(old_grid, DEAD);
    set_grid(new_grid, DEAD);
    set_cell(old_grid, 10, 10, ALIVE);
    set_cell(old_grid, 10, 11, ALIVE);
    set_cell(old_grid, 10, 12, ALIVE);

    int count = 0;
    while (1) {
        int even = count % 2 == 0;
        print_grid(even ? old_grid : new_grid);
        compute_new_state(even ? old_grid : new_grid, even ? new_grid : old_grid);
        print_grid(even ? new_grid : old_grid);
        sleep(1);
        count++;
    }

    return 0;
}
