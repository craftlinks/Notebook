# LAMB - Lambda Calculus Interpreter
# Makefile for building optimized lamb_gas, lamb_grid, and lamb_view executables

CC ?= cc
CFLAGS_COMMON = -Wall -Wextra -pedantic -std=c99 -D_DEFAULT_SOURCE
CFLAGS_DEBUG = $(CFLAGS_COMMON) -g -O0 -DDEBUG
CFLAGS_RELEASE = $(CFLAGS_COMMON) -O3 -march=native -flto
LDFLAGS = -lm
LDFLAGS_RELEASE = -lm -flto

# Default to release build
CFLAGS ?= $(CFLAGS_RELEASE)
LDFLAGS_ACTUAL ?= $(LDFLAGS_RELEASE)

# --- Raylib Configuration ---
RAYLIB_INCLUDE = -I./external/raylib/src
RAYLIB_LIBPATH = -L./external/raylib/src
RAYLIB_LDFLAGS = $(RAYLIB_LIBPATH) -lraylib -lm

# OS Detection for Raylib platform-specific libraries
UNAME_S := $(shell uname -s)

ifeq ($(UNAME_S),Linux)
    RAYLIB_LDFLAGS += -lGL -lpthread -ldl -lrt -lX11
endif
ifeq ($(UNAME_S),Darwin)
    RAYLIB_LDFLAGS += -framework OpenGL -framework Cocoa -framework IOKit -framework CoreVideo
endif
ifeq ($(OS),Windows_NT)
    RAYLIB_LDFLAGS += -lopengl32 -lgdi32 -lwinmm
endif

# Source files
LIB_SRC = lamb_lib.c
GAS_SRC = lamb_gas.c
GRID_SRC = lamb_grid.c
VIEW_SRC = lamb_view.c
HEADER = lamb.h

# Object files
LIB_OBJ = lamb_lib.o
GAS_OBJ = lamb_gas.o
GRID_OBJ = lamb_grid.o

# Executables
GAS_BIN = lamb_gas
GRID_BIN = lamb_grid
VIEW_BIN = lamb_view

# Default target: build CLI apps (not raylib visualizer)
.PHONY: all
all: $(GAS_BIN) $(GRID_BIN)

# Build everything including raylib visualizer
.PHONY: full
full: $(GAS_BIN) $(GRID_BIN) $(VIEW_BIN)

# --- Raylib Targets ---

# Build Raylib locally (static library)
.PHONY: raylib
raylib:
	$(MAKE) -C external/raylib/src PLATFORM=PLATFORM_DESKTOP

# Build the LAMB Visualizer (requires raylib to be built first)
$(VIEW_BIN): raylib $(VIEW_SRC) $(GRID_SRC) $(LIB_SRC) $(HEADER)
	$(CC) $(CFLAGS) $(RAYLIB_INCLUDE) -o $@ $(VIEW_SRC) $(GRID_SRC) $(LIB_SRC) -DLAMB_LIBRARY_MODE $(RAYLIB_LDFLAGS)

# Convenience target for visualizer
.PHONY: view
view: $(VIEW_BIN)

# --- CLI Targets ---

# Library object (shared between CLI apps)
$(LIB_OBJ): $(LIB_SRC) $(HEADER)
	$(CC) $(CFLAGS) -c -o $@ $(LIB_SRC)

# Gas app object
$(GAS_OBJ): $(GAS_SRC) $(HEADER)
	$(CC) $(CFLAGS) -c -o $@ $(GAS_SRC)

# Grid app object
$(GRID_OBJ): $(GRID_SRC) $(HEADER)
	$(CC) $(CFLAGS) -c -o $@ $(GRID_SRC)

# Link gas app
$(GAS_BIN): $(GAS_OBJ) $(LIB_OBJ)
	$(CC) -o $@ $(GAS_OBJ) $(LIB_OBJ) $(LDFLAGS_ACTUAL)

# Link grid app
$(GRID_BIN): $(GRID_OBJ) $(LIB_OBJ)
	$(CC) -o $@ $(GRID_OBJ) $(LIB_OBJ) $(LDFLAGS_ACTUAL)

# --- Build Variants ---

# Debug builds
.PHONY: debug
debug: CFLAGS = $(CFLAGS_DEBUG)
debug: LDFLAGS_ACTUAL = $(LDFLAGS)
debug: clean all

# Release builds (explicit)
.PHONY: release
release: CFLAGS = $(CFLAGS_RELEASE)
release: LDFLAGS_ACTUAL = $(LDFLAGS_RELEASE)
release: clean all

# Individual targets
.PHONY: gas grid
gas: $(GAS_BIN)
grid: $(GRID_BIN)

# --- Clean ---

# Clean CLI build artifacts only
.PHONY: clean
clean:
	rm -f $(LIB_OBJ) $(GAS_OBJ) $(GRID_OBJ) $(GAS_BIN) $(GRID_BIN) $(VIEW_BIN)

# Clean everything including raylib
.PHONY: cleanall
cleanall: clean
	$(MAKE) -C external/raylib/src clean

# --- Install/Uninstall ---

# Install to /usr/local/bin (requires sudo)
.PHONY: install
install: all
	install -m 755 $(GAS_BIN) /usr/local/bin/
	install -m 755 $(GRID_BIN) /usr/local/bin/

# Uninstall
.PHONY: uninstall
uninstall:
	rm -f /usr/local/bin/$(GAS_BIN) /usr/local/bin/$(GRID_BIN)

# --- Help ---

.PHONY: help
help:
	@echo "LAMB - Lambda Calculus Interpreter"
	@echo ""
	@echo "Targets:"
	@echo "  all       Build lamb_gas and lamb_grid (optimized, default)"
	@echo "  full      Build all executables including lamb_view (raylib)"
	@echo "  gas       Build only lamb_gas"
	@echo "  grid      Build only lamb_grid"
	@echo "  view      Build lamb_view (raylib visualizer)"
	@echo "  raylib    Build raylib static library from submodule"
	@echo "  debug     Build CLI apps with debug symbols"
	@echo "  release   Build CLI apps with full optimization"
	@echo "  clean     Remove CLI build artifacts"
	@echo "  cleanall  Remove all build artifacts including raylib"
	@echo "  install   Install CLI apps to /usr/local/bin (requires sudo)"
	@echo "  uninstall Remove CLI apps from /usr/local/bin (requires sudo)"
	@echo "  help      Show this help message"
	@echo ""
	@echo "Examples:"
	@echo "  make              # Build optimized CLI versions"
	@echo "  make view         # Build raylib visualizer"
	@echo "  make full         # Build everything"
	@echo "  make debug        # Build debug CLI versions"
	@echo "  make clean all    # Clean rebuild CLI"
	@echo "  make cleanall full # Clean rebuild everything"
