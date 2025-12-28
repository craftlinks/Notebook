package main

import rl "vendor:raylib"

import "core:time"
import "core:os"
import "core:fmt"
import "core:math"

// ============================================================================
// EVOLVABLE INSTRUCTION SETS (MICROCODE ARCHITECTURE)
// ============================================================================
// Instead of fixed opcodes, each Spark contains a Microcode RAM.
// 1. Decision Matrix: Decides WHICH microcode to run (Strategy)
// 2. Microcode Library: Custom functions made of atomic physics (Tactics)
// ============================================================================

GRID_SIZE :: 800

WINDOW_W :: 2048
WINDOW_H :: 2048

// Value ranges (ontology)
RANGE_VOID_MAX  : u8 = 63   // Empty space / Passive data
RANGE_WALL_MAX  : u8 = 127  // Reflective matter
RANGE_SOLAR_MAX : u8 = 191  // Energy sources (metabolism)
// 192..255 are now just treated as high-value data (not fixed ops)

// ============================================================================
// ATOMIC PHYSICS (The "Assembly Language")
// ============================================================================
// These are the ONLY things the universe guarantees work.
// 5-bit atoms (0-19) - the bare metal of spark behavior.

ATOM_NOP         :: 0   // Do nothing
ATOM_SET_DX_1    :: 1   // Set motor X to +1
ATOM_SET_DX_N1   :: 2   // Set motor X to -1
ATOM_SET_DY_1    :: 3   // Set motor Y to +1
ATOM_SET_DY_N1   :: 4   // Set motor Y to -1
ATOM_APPLY_MOVE  :: 5   // Commit movement (Cost: Energy)
ATOM_READ_GRID   :: 6   // Load grid value at current position into Register A
ATOM_WRITE_GRID  :: 7   // Write Register A to Grid at current position (Cost: Energy)
ATOM_LOAD_ENG    :: 8   // Load current Energy level into Register A (0-255 scaled)
ATOM_TRANSFER    :: 9   // Bi-directional energy transfer (Universal Interaction)
ATOM_SPLIT_COND  :: 10  // Split IF Energy > Threshold (Cost: Heavy)
ATOM_REG_INC     :: 11  // Register A++
ATOM_REG_DEC     :: 12  // Register A--
ATOM_SWAP_REGS   :: 13  // Swap Reg A and Reg B
ATOM_JUMP_IF     :: 14  // Skip next atom if Reg A > 128
ATOM_RESET       :: 15  // Reset registers/motors to 0

// === HORIZONTAL GENE TRANSFER & ADVANCED ATOMS ===
ATOM_CONJUGATE   :: 16  // HGT: Exchange a library function with adjacent spark (bacterial conjugation)
ATOM_SENSE_AHEAD :: 17  // Look ahead (dx,dy direction) and load grid value into reg_a
ATOM_CALL_FUNC   :: 18  // Call function indexed by (reg_b % 16) - enables composite behaviors
ATOM_RANDOM      :: 19  // Load random byte into reg_a (stochastic behavior)

ATOM_COUNT       :: 20  // Total number of atoms (for mutation)

// Microcode dimensions
MICRO_FUNC_COUNT :: 16  // The spark can remember 16 different behaviors
MICRO_FUNC_LEN   :: 8   // Each behavior is a sequence of 8 atoms

// ============================================================================
// COSTS AND GAINS
// ============================================================================

COST_ATOM      : f32 = 0.001  // Every atom execution costs this (entropy) - THINKING IS CHEAP
COST_MOVE      : f32 = 0.3   // Moving costs energy
COST_WRITE     : f32 = 20.0  // Writing to grid is expensive (farming investment) - MUST be higher than solar max
COST_SPLIT     : f32 = 15.0  // Reproduction threshold
ENERGY_CAP     : f32 = 2000.0 // Maximum energy a spark can hold
SPLIT_ENERGY_THRESHOLD : f32 = 50.0 // Must have this much to split

// Solar energy parameters
solar_bonus_max_setting : f32 = 15.0  // Max solar bonus (adjustable via slider)
solar_bonus_max : f32 = 15.0          // Actual solar bonus (computed dynamically)

// Auto-Solar Mode (Seasons/Tides)
auto_solar_enabled : bool = false
auto_solar_time : f32 = 0.0
auto_solar_speed : f32 = 0.05
auto_solar_amplitude : f32 = 12.0
auto_solar_base : f32 = 8.0

// Auto-Injection Mode
auto_inject_enabled : bool = false
auto_inject_timer : f32 = 0.0
auto_inject_interval : f32 = 60.0
auto_inject_count : int = 5000

// Shuffle frequency - only shuffle every N ticks for performance
SHUFFLE_FREQUENCY :: 4

// Environmental dynamics
SOLAR_REGROWTH_RATE   : int = 2000
SOLAR_REGROWTH_CHANCE : u32 = 2

SPARK_COUNT_MIN : int = 100000
SPARK_CAP :: 150_000

// ============================================================================
// THE SPARK (Programmable CPU)
// ============================================================================

Spark :: struct {
	x, y: int,
	dx, dy: int,      // Motor state (-1, 0, 1)
	energy: f32,
	
	// Virtual CPU Registers
	reg_a: u8,
	reg_b: u8,
	
	// 1. THE DECISION MATRIX (The Manager)
	// Input: (internal_state XOR grid_value) -> Output: Function Index (0-15)
	// This is 256 entries, each 4-bit (but stored as u8 for simplicity)
	decision_matrix: [256]u8,
	
	// 2. THE MICROCODE LIBRARY (The Worker)
	// This is the evolving instruction set.
	// Example: library[0] might evolve to be the "Eat" function.
	//          library[1] might evolve to be the "Run Away" function.
	library: [MICRO_FUNC_COUNT][MICRO_FUNC_LEN]u8,
	
	// Internal State (persists between ticks, used for decision making)
	internal_state: u8,
	
	// Lineage tracking
	color: rl.Color,
	
	// Generation counter (for display/debugging)
	generation: int,
	
	// === METABOLISM SYSTEM (Anti-Oscillation) ===
	// Tracks spatial exploration to punish local looping
	metabolism: f32,              // Metabolism level (0-100, dies if too low)
	last_x: int,                  // Position from previous tick
	last_y: int,
	displacement_sum: f32,        // Cumulative distance traveled (for metabolism gain)
	
	// === OLD AGE SYSTEM (Entropy) ===
	// Tracks age to implement increasing metabolic cost over time
	age: int,                     // Age in ticks (increments each step)
}

Spark_Buffer :: struct {
	data: []Spark,
	count: int,
}

Byte_World :: struct {
	size: int,
	tick: u64,

	grid: []u8,

	sparks: Spark_Buffer,
	sparks_next: Spark_Buffer,

	occ_stamp: []u32,
	occ_owner: []int,
	occ_gen: u32,

	rng: u32,
	
	// Shuffle control - only shuffle every N ticks
	shuffle_counter: int,
}


// ============================================================================
// UTILITIES
// ============================================================================

min_f32 :: proc(a, b: f32) -> f32 {
	return b if a > b else a
}

max_f32 :: proc(a, b: f32) -> f32 {
	return a if a > b else b
}

hsv_to_rgb :: proc(hue: u32, saturation: f32, value: f32) -> rl.Color {
	h := f32(hue % 360)
	s := saturation
	v := value
	
	c := v * s
	x := c * (1.0 - abs(f32(int(h/60.0) % 2) + (h/60.0 - f32(int(h/60.0))) - 1.0))
	m := v - c
	
	r, g, b: f32
	
	if h < 60 {
		r, g, b = c, x, 0
	} else if h < 120 {
		r, g, b = x, c, 0
	} else if h < 180 {
		r, g, b = 0, c, x
	} else if h < 240 {
		r, g, b = 0, x, c
	} else if h < 300 {
		r, g, b = x, 0, c
	} else {
		r, g, b = c, 0, x
	}
	
	return rl.Color{
		u8((r + m) * 255.0),
		u8((g + m) * 255.0),
		u8((b + m) * 255.0),
		255,
	}
}

abs :: proc(x: f32) -> f32 {
	return x if x >= 0 else -x
}

abs_int :: proc(x: int) -> int {
	return x if x >= 0 else -x
}

smooth_solar_cycle :: proc(time: f32) -> f32 {
	wave1 := math.sin(time * 0.3) * 0.5
	wave2 := math.sin(time * 0.7) * 0.3
	wave3 := math.sin(time * 1.5) * 0.2
	combined := wave1 + wave2 + wave3
	normalized := (combined + 1.0) * 0.5
	return normalized
}

wrap_i :: proc(i, n: int) -> int {
	assert(n > 0)
	r := i % n
	if r < 0 { r += n }
	return r
}

idx_of :: proc(size, x, y: int) -> int {
	return y*size + x
}

in_bounds :: proc(size, x, y: int) -> bool {
	return x >= 0 && x < size && y >= 0 && y < size
}

// ============================================================================
// RNG
// ============================================================================

rng_next_u32 :: proc(state: ^u32) -> u32 {
	x := state^
	x ~= x << 13
	x ~= x >> 17
	x ~= x << 5
	state^ = x
	return x
}

rng_u32_bounded :: proc(state: ^u32, max_exclusive: u32) -> u32 {
	if max_exclusive == 0 { return 0 }
	return rng_next_u32(state) % max_exclusive
}

rng_int_inclusive :: proc(state: ^u32, lo_inclusive, hi_inclusive: int) -> int {
	if hi_inclusive <= lo_inclusive { return lo_inclusive }
	span := u32(hi_inclusive - lo_inclusive + 1)
	return lo_inclusive + int(rng_u32_bounded(state, span))
}

rng_choice_dir_3 :: proc(state: ^u32) -> int {
	r := rng_u32_bounded(state, 3)
	switch r {
	case 0: return -1
	case 1: return 0
	case 2: return 1
	}
	return 0
}

shuffle_sparks :: proc(sparks: []Spark, rng: ^u32) {
	if len(sparks) <= 1 {
		return
	}
	for i := len(sparks)-1; i > 0; i -= 1 {
		j := rng_int_inclusive(rng, 0, i)
		sparks[i], sparks[j] = sparks[j], sparks[i]
	}
}

// ============================================================================
// SPARK BUFFER OPERATIONS
// ============================================================================

spark_buf_clear :: proc(b: ^Spark_Buffer) {
	b.count = 0
}

spark_buf_slice :: proc(b: ^Spark_Buffer) -> []Spark {
	if b.count <= 0 { return b.data[:0] }
	return b.data[:b.count]
}

spark_buf_append :: proc(b: ^Spark_Buffer, s: Spark) -> bool {
	if b.count >= len(b.data) {
		return false
	}
	b.data[b.count] = s
	b.count += 1
	return true
}

// ============================================================================
// GENOME INITIALIZATION & MUTATION
// ============================================================================

// Initialize a random genome for a new spark
init_random_genome :: proc(s: ^Spark, rng: ^u32) {
	// Initialize Decision Matrix (256 entries, each 0-15)
	for i in 0..<256 {
		s.decision_matrix[i] = u8(rng_u32_bounded(rng, MICRO_FUNC_COUNT))
	}
	
	// Initialize Microcode Library (16 functions × 8 atoms)
	for f in 0..<MICRO_FUNC_COUNT {
		for a in 0..<MICRO_FUNC_LEN {
			s.library[f][a] = u8(rng_u32_bounded(rng, ATOM_COUNT))
		}
	}
	
	s.internal_state = u8(rng_u32_bounded(rng, 256))
	s.reg_a = 0
	s.reg_b = 0
}

// Copy genome from parent to child
copy_genome :: proc(child: ^Spark, parent: ^Spark) {
	child.decision_matrix = parent.decision_matrix
	child.library = parent.library
	child.internal_state = parent.internal_state
	// Registers start fresh
	child.reg_a = 0
	child.reg_b = 0
}

// Mutation Logic for Microcode (called on reproduction)
mutate_genome :: proc(s: ^Spark, rng: ^u32) {
	// Multiple mutation types with different probabilities
	
	// 1. Point Mutation in Library (30% chance)
	if rng_u32_bounded(rng, 100) < 30 {
		func_idx := rng_u32_bounded(rng, MICRO_FUNC_COUNT)
		atom_idx := rng_u32_bounded(rng, MICRO_FUNC_LEN)
		new_atom := u8(rng_u32_bounded(rng, ATOM_COUNT))
		s.library[func_idx][atom_idx] = new_atom
	}
	
	// 2. Decision Matrix Mutation (20% chance)
	if rng_u32_bounded(rng, 100) < 20 {
		matrix_idx := rng_u32_bounded(rng, 256)
		s.decision_matrix[matrix_idx] = u8(rng_u32_bounded(rng, MICRO_FUNC_COUNT))
	}
	
	// 3. Gene Duplication (10% chance) - Copy one function to another slot
	if rng_u32_bounded(rng, 100) < 10 {
		src_func := rng_u32_bounded(rng, MICRO_FUNC_COUNT)
		dst_func := rng_u32_bounded(rng, MICRO_FUNC_COUNT)
		if src_func != dst_func {
			s.library[dst_func] = s.library[src_func]
		}
	}
	
	// 4. Frame Shift (5% chance) - Rotate atoms in a function
	if rng_u32_bounded(rng, 100) < 5 {
		func_idx := rng_u32_bounded(rng, MICRO_FUNC_COUNT)
		// Rotate left by 1
		first := s.library[func_idx][0]
		for i in 0..<(MICRO_FUNC_LEN-1) {
			s.library[func_idx][i] = s.library[func_idx][i+1]
		}
		s.library[func_idx][MICRO_FUNC_LEN-1] = first
	}
	
	// 5. Internal State Mutation (15% chance)
	if rng_u32_bounded(rng, 100) < 15 {
		s.internal_state = s.internal_state ~ u8(rng_u32_bounded(rng, 256))
	}
}

clamp :: proc(v, min_v, max_v: i32) -> i32 {
	if v < min_v { return min_v }
	if v > max_v { return max_v }
	return v
}

mutate_color :: proc(c: rl.Color, rng: ^u32) -> rl.Color {
	r := c.r
	g := c.g
	b := c.b
	
	drift :: 15
	if rng_u32_bounded(rng, 100) < 10 {
		delta := i32(rng_u32_bounded(rng, drift*2 + 1)) - drift
		new_r := clamp(i32(r) + delta, 50, 255)
		r = u8(new_r)
	}
	if rng_u32_bounded(rng, 100) < 10 {
		delta := i32(rng_u32_bounded(rng, drift*2 + 1)) - drift
		new_g := clamp(i32(g) + delta, 50, 255)
		g = u8(new_g)
	}
	if rng_u32_bounded(rng, 100) < 10 {
		delta := i32(rng_u32_bounded(rng, drift*2 + 1)) - drift
		new_b := clamp(i32(b) + delta, 50, 255)
		b = u8(new_b)
	}
	return rl.Color{r, g, b, 255}
}

// ============================================================================
// WORLD CREATION & SEEDING
// ============================================================================

seed_from_system_time :: proc() -> u32 {
	nsec := u64(time.to_unix_nanoseconds(time.now()))
	cc := time.read_cycle_counter()
	mixed := nsec ~ (cc << 1) ~ (nsec >> 23) ~ 0xA5A5_A5A5_A5A5_A5A5
	return u32(mixed ~ (mixed >> 32))
}

byte_world_make :: proc(size: int, seed: u32) -> Byte_World {
	assert(size > 0)
	cell_count := size * size

	grid := make([]u8, cell_count)
	occ_stamp := make([]u32, cell_count)
	occ_owner := make([]int, cell_count)

	sparks_a := Spark_Buffer{data = make([]Spark, SPARK_CAP), count = 0}
	sparks_b := Spark_Buffer{data = make([]Spark, SPARK_CAP), count = 0}

	w := Byte_World{
		size = size,
		tick = 0,
		grid = grid,
		sparks = sparks_a,
		sparks_next = sparks_b,
		occ_stamp = occ_stamp,
		occ_owner = occ_owner,
		occ_gen = 1,
		rng = seed,
		shuffle_counter = 0,
	}
	byte_world_reseed(&w, seed)
	return w
}

byte_world_reseed :: proc(w: ^Byte_World, seed: u32) {
	w.tick = 0
	w.rng = seed ~ u32(w.size*73856093) ~ 0x9E37_79B9
	w.shuffle_counter = 0

	spark_buf_clear(&w.sparks)
	spark_buf_clear(&w.sparks_next)

	for i in 0..<len(w.occ_stamp) {
		w.occ_stamp[i] = 0
		w.occ_owner[i] = 0
	}
	w.occ_gen = 1

	// Initialize grid with random values
	// The grid is now just "physics substrate" - not instructions
	for i in 0..<len(w.grid) {
		r := rng_u32_bounded(&w.rng, 100)
		if r < 5 {
			// Void (0..63)
			w.grid[i] = u8(rng_u32_bounded(&w.rng, u32(RANGE_VOID_MAX) + 1))
		} else if r < 25 {
			// Wall (64..127)
			w.grid[i] = u8(rng_int_inclusive(&w.rng, int(RANGE_VOID_MAX) + 1, int(RANGE_WALL_MAX)))
		} else if r < 75 {
			// Solar (128..191)
			w.grid[i] = u8(rng_int_inclusive(&w.rng, int(RANGE_WALL_MAX) + 1, int(RANGE_SOLAR_MAX)))
		} else {
			// High data (192..255) - used as environmental data, not ops
			w.grid[i] = u8(rng_int_inclusive(&w.rng, int(RANGE_SOLAR_MAX) + 1, 255))
		}
	}

	// Spawn initial sparks
	for _ in 0..<SPARK_COUNT_MIN {
		if !spawn_spark_into_unique(w, &w.sparks) { break }
	}
}

spawn_spark_into :: proc(w: ^Byte_World, sparks: ^Spark_Buffer) -> bool {
	if sparks.count >= len(sparks.data) {
		return false
	}
	
	hue := rng_u32_bounded(&w.rng, 360)
	color := hsv_to_rgb(hue, 0.8, 1.0)
	
	s := Spark{
		x = rng_int_inclusive(&w.rng, 0, w.size-1),
		y = rng_int_inclusive(&w.rng, 0, w.size-1),
		dx = rng_choice_dir_3(&w.rng),
		dy = rng_choice_dir_3(&w.rng),
		energy = f32(rng_int_inclusive(&w.rng, 50, 80)),
		color = color,
		generation = 0,
		metabolism = 50.0,  // Start with moderate metabolism
		last_x = 0,
		last_y = 0,
		displacement_sum = 0.0,
		age = 0,  // Start at age 0
	}
	
	s.last_x = s.x
	s.last_y = s.y
	
	// Initialize random genome
	init_random_genome(&s, &w.rng)
	
	// Ensure it's moving
	if s.dx == 0 && s.dy == 0 {
		s.dx = 1
	}
	
	return spark_buf_append(sparks, s)
}

spawn_spark_into_unique :: proc(w: ^Byte_World, sparks: ^Spark_Buffer) -> bool {
	if sparks.count >= len(sparks.data) {
		return false
	}

	for _ in 0..<16 {
		x := rng_int_inclusive(&w.rng, 0, w.size-1)
		y := rng_int_inclusive(&w.rng, 0, w.size-1)
		i := idx_of(w.size, x, y)
		if w.occ_stamp[i] == w.occ_gen {
			continue
		}

		hue := rng_u32_bounded(&w.rng, 360)
		color := hsv_to_rgb(hue, 0.8, 1.0)

		s := Spark{
			x = x,
			y = y,
			dx = rng_choice_dir_3(&w.rng),
			dy = rng_choice_dir_3(&w.rng),
			energy = f32(rng_int_inclusive(&w.rng, 50, 80)),
			color = color,
			generation = 0,
			metabolism = 50.0,
			last_x = x,
			last_y = y,
			displacement_sum = 0.0,
			age = 0,  // Start at age 0
		}
		
		init_random_genome(&s, &w.rng)
		
		if s.dx == 0 && s.dy == 0 {
			s.dx = 1
		}

		owner_idx := sparks.count
		if spark_buf_append(sparks, s) {
			w.occ_stamp[i] = w.occ_gen
			w.occ_owner[i] = owner_idx
			return true
		}
		return false
	}

	return spawn_spark_into(w, sparks)
}

// ============================================================================
// MICROCODE EXECUTION (The Virtual Machine)
// ============================================================================

// Move a spark according to its current motor state (dx, dy)
move_spark :: proc(w: ^Byte_World, s: ^Spark) -> bool {
	if s.dx == 0 && s.dy == 0 {
		return false
	}
	
	nx := wrap_i(s.x + s.dx, w.size)
	ny := wrap_i(s.y + s.dy, w.size)
	nidx := idx_of(w.size, nx, ny)
	
	// Check for wall collision
	val := w.grid[nidx]
	if val > RANGE_VOID_MAX && val <= RANGE_WALL_MAX {
		// Bounce off wall
		if (val % 2) == 0 {
			s.dx = -s.dx
		} else {
			s.dy = -s.dy
		}
		s.energy -= 0.1 // Small penalty for hitting wall
		return false
	}
	
	// Move succeeds
	s.x = nx
	s.y = ny
	s.energy -= COST_MOVE
	return true
}

// Universal physics transfer - handles energy flow based on environment
perform_physics_transfer :: proc(w: ^Byte_World, s: ^Spark) {
	idx := idx_of(w.size, s.x, s.y)
	val := w.grid[idx]
	
	// Physics: Energy flows from high potential to low
	if val > RANGE_WALL_MAX && val <= RANGE_SOLAR_MAX {
		// SOLAR TILE: Absorb energy (ONE TIME USE - full depletion)
		efficiency := (f32(val) - 128.0) / 64.0
		gain := 1.0 + efficiency * solar_bonus_max
		s.energy += gain
		
		// Fully drain the solar tile to void (limited resource!)
		w.grid[idx] = RANGE_VOID_MAX
	} else if val <= RANGE_VOID_MAX {
		// VOID TILE: Slight energy dissipation (entropy)
		s.energy -= 0.2
	}
	// Wall tiles: No transfer happens
	
	// Cap energy
	if s.energy > ENERGY_CAP {
		s.energy = ENERGY_CAP
	}
}

// Spawn a child spark (returns false if cannot spawn)
spawn_child :: proc(w: ^Byte_World, parent: ^Spark) -> bool {
	if w.sparks_next.count >= len(w.sparks_next.data) {
		return false
	}
	
	// Split energy
	parent.energy -= COST_SPLIT
	child_energy := parent.energy * 0.5
	parent.energy = parent.energy * 0.5
	
	// Find a spawn location (perpendicular to parent direction)
	child_dx := -parent.dy
	child_dy := parent.dx
	if child_dx == 0 && child_dy == 0 {
		child_dx = 1
	}
	
	// Try to spawn adjacent
	cx := wrap_i(parent.x + child_dx, w.size)
	cy := wrap_i(parent.y + child_dy, w.size)
	cidx := idx_of(w.size, cx, cy)
	
	// Check if spawn location is clear
	grid_val := w.grid[cidx]
	if grid_val > RANGE_VOID_MAX && grid_val <= RANGE_WALL_MAX {
		// Can't spawn into wall, try opposite
		cx = wrap_i(parent.x - child_dx, w.size)
		cy = wrap_i(parent.y - child_dy, w.size)
		cidx = idx_of(w.size, cx, cy)
		grid_val = w.grid[cidx]
		if grid_val > RANGE_VOID_MAX && grid_val <= RANGE_WALL_MAX {
			// Still blocked, refund some energy
			parent.energy += COST_SPLIT * 0.5
			return false
		}
	}
	
	// Check occupancy
	if w.occ_stamp[cidx] == w.occ_gen {
		parent.energy += COST_SPLIT * 0.5
		return false
	}
	
	// Create child
	child := Spark{
		x = cx,
		y = cy,
		dx = child_dx,
		dy = child_dy,
		energy = child_energy,
		color = mutate_color(parent.color, &w.rng),
		generation = parent.generation + 1,
		metabolism = 50.0,  // Children start with fresh metabolism
		last_x = cx,
		last_y = cy,
		displacement_sum = 0.0,
		age = 0,  // Children start at age 0 (fresh start)
	}
	
	// Inherit genome with mutations
	copy_genome(&child, parent)
	mutate_genome(&child, &w.rng)
	
	// Add to world
	owner_idx := w.sparks_next.count
	if spark_buf_append(&w.sparks_next, child) {
		w.occ_stamp[cidx] = w.occ_gen
		w.occ_owner[cidx] = owner_idx
		return true
	}
	
	return false
}

// Execute a microcode function
execute_microcode :: proc(w: ^Byte_World, s: ^Spark, func_idx: u8) {
	// Safety clamp
	idx := int(func_idx % MICRO_FUNC_COUNT)
	
	// Fetch the sequence of atoms from the Spark's own library
	code := s.library[idx]
	
	// Execute the sequence (The Spark's custom Opcode)
	pc := 0
	for pc < MICRO_FUNC_LEN {
		atom := code[pc]
		pc += 1
		
		switch atom {
		case ATOM_NOP:
			// Do nothing
			
		case ATOM_SET_DX_1:
			s.dx = 1
			
		case ATOM_SET_DX_N1:
			s.dx = -1
			
		case ATOM_SET_DY_1:
			s.dy = 1
			
		case ATOM_SET_DY_N1:
			s.dy = -1
			
		case ATOM_APPLY_MOVE:
			move_spark(w, s)
			
		case ATOM_READ_GRID:
			grid_idx := idx_of(w.size, s.x, s.y)
			s.reg_a = w.grid[grid_idx]
			
		case ATOM_WRITE_GRID:
			if s.energy > COST_WRITE {
				grid_idx := idx_of(w.size, s.x, s.y)
				w.grid[grid_idx] = s.reg_a
				s.energy -= COST_WRITE
			}
			
		case ATOM_LOAD_ENG:
			// Scale energy (0-200) to byte (0-255)
			scaled := u8(clamp(i32(s.energy * 1.275), 0, 255))
			s.reg_a = scaled
			
		case ATOM_TRANSFER:
			perform_physics_transfer(w, s)
			
		case ATOM_SPLIT_COND:
			if s.energy > SPLIT_ENERGY_THRESHOLD {
				spawn_child(w, s)
			}
			
		case ATOM_REG_INC:
			s.reg_a = s.reg_a + 1 // Wraps naturally
			
		case ATOM_REG_DEC:
			s.reg_a = s.reg_a - 1 // Wraps naturally
			
		case ATOM_SWAP_REGS:
			s.reg_a, s.reg_b = s.reg_b, s.reg_a
			
		case ATOM_JUMP_IF:
			// Rudimentary logic: If RegA > 128, skip the next instruction
			if s.reg_a > 128 {
				pc += 1
			}
			
		case ATOM_RESET:
			s.dx = 0
			s.dy = 0
			s.reg_a = 0
			s.reg_b = 0
			
		case ATOM_CONJUGATE:
			// HORIZONTAL GENE TRANSFER (Bacterial Conjugation)
			// Look for an adjacent spark and exchange a library function
			perform_conjugation(w, s)
			
		case ATOM_SENSE_AHEAD:
			// Look ahead in the direction of travel
			if s.dx != 0 || s.dy != 0 {
				ahead_x := wrap_i(s.x + s.dx, w.size)
				ahead_y := wrap_i(s.y + s.dy, w.size)
				ahead_idx := idx_of(w.size, ahead_x, ahead_y)
				s.reg_a = w.grid[ahead_idx]
				
				// Bonus: If there's a spark ahead, set high bit
				if w.occ_stamp[ahead_idx] == w.occ_gen {
					s.reg_a = s.reg_a | 0x80  // Set high bit to indicate "occupied"
				}
			} else {
				s.reg_a = 0
			}
			
		case ATOM_CALL_FUNC:
			// Call another function (enables composite behaviors)
			// Uses reg_b as function index, with recursion depth limit
			// We implement this as a simple inline expansion (no stack)
			sub_func := s.reg_b % u8(MICRO_FUNC_COUNT)
			sub_code := s.library[sub_func]
			// Execute just the first 4 atoms of the sub-function (limited recursion)
			for sub_pc := 0; sub_pc < 4; sub_pc += 1 {
				sub_atom := sub_code[sub_pc]
				// Don't allow nested CALL_FUNC to prevent infinite recursion
				if sub_atom == ATOM_CALL_FUNC { continue }
				// Execute simple atoms only (movement, registers, etc.)
				switch sub_atom {
				case ATOM_SET_DX_1:  s.dx = 1
				case ATOM_SET_DX_N1: s.dx = -1
				case ATOM_SET_DY_1:  s.dy = 1
				case ATOM_SET_DY_N1: s.dy = -1
				case ATOM_APPLY_MOVE: move_spark(w, s)
				case ATOM_REG_INC:   s.reg_a += 1
				case ATOM_REG_DEC:   s.reg_a -= 1
				case ATOM_SWAP_REGS: s.reg_a, s.reg_b = s.reg_b, s.reg_a
				case ATOM_TRANSFER:  perform_physics_transfer(w, s)
				}
				s.energy -= COST_ATOM * 0.5  // Sub-calls cost half
			}
			
		case ATOM_RANDOM:
			// Load a random value into reg_a (for stochastic behaviors)
			s.reg_a = u8(rng_u32_bounded(&w.rng, 256))
		}
		
		// Every atom costs entropy
		s.energy -= COST_ATOM
		
		// Check for death during execution
		if s.energy <= 0 {
			break
		}
	}
}

// Horizontal Gene Transfer - exchange genetic material with a neighbor
perform_conjugation :: proc(w: ^Byte_World, s: ^Spark) {
	// Look in all 4 cardinal directions for a neighbor spark
	dirs := [4][2]int{{1,0}, {-1,0}, {0,1}, {0,-1}}
	
	for dir in dirs {
		nx := wrap_i(s.x + dir[0], w.size)
		ny := wrap_i(s.y + dir[1], w.size)
		nidx := idx_of(w.size, nx, ny)
		
		// Check if there's a spark here (in sparks_next buffer)
		if w.occ_stamp[nidx] == w.occ_gen {
			owner_idx := w.occ_owner[nidx]
			neighbor := &w.sparks_next.data[owner_idx]
			
			// Pick a random function to exchange (based on reg_b for some control)
			func_to_swap := int(s.reg_b % u8(MICRO_FUNC_COUNT))
			
			// BIDIRECTIONAL SWAP: Both sparks exchange the function
			// This creates "ideological contagion" - behaviors can spread virally
			temp_func := s.library[func_to_swap]
			s.library[func_to_swap] = neighbor.library[func_to_swap]
			neighbor.library[func_to_swap] = temp_func
			
			// Also mix decision matrices slightly (1 entry)
			matrix_idx := int(s.reg_a)  // Use reg_a to determine which entry
			temp_decision := s.decision_matrix[matrix_idx]
			s.decision_matrix[matrix_idx] = neighbor.decision_matrix[matrix_idx]
			neighbor.decision_matrix[matrix_idx] = temp_decision
			
			// Mix colors slightly (visual indicator of gene flow)
			// Average one channel
			channel := rng_u32_bounded(&w.rng, 3)
			switch channel {
			case 0:
				avg := (u16(s.color.r) + u16(neighbor.color.r)) / 2
				s.color.r = u8(avg)
				neighbor.color.r = u8(avg)
			case 1:
				avg := (u16(s.color.g) + u16(neighbor.color.g)) / 2
				s.color.g = u8(avg)
				neighbor.color.g = u8(avg)
			case 2:
				avg := (u16(s.color.b) + u16(neighbor.color.b)) / 2
				s.color.b = u8(avg)
				neighbor.color.b = u8(avg)
			}
			
			// Energy cost for conjugation
			s.energy -= 0.5
			
			return  // Only conjugate with one neighbor per execution
		}
	}
}

// ============================================================================
// OCCUPANCY & SIMULATION STEP
// ============================================================================

occ_begin_step :: proc(w: ^Byte_World) {
	w.occ_gen += 1
	if w.occ_gen == 0 {
		for i in 0..<len(w.occ_stamp) {
			w.occ_stamp[i] = 0
			w.occ_owner[i] = 0
		}
		w.occ_gen = 1
	}
}

color_equal :: proc(a, b: rl.Color) -> bool {
	return a.r == b.r && a.g == b.g && a.b == b.b && a.a == b.a
}

occ_claim_or_takeover :: proc(w: ^Byte_World, cell_idx: int, s_new: ^Spark) -> (ok: bool, collision_damage: f32) {
	// Unclaimed: append new occupant
	if w.occ_stamp[cell_idx] != w.occ_gen {
		if w.sparks_next.count >= len(w.sparks_next.data) {
			return false, 0.0
		}
		owner_idx := w.sparks_next.count
		w.sparks_next.data[owner_idx] = s_new^
		w.sparks_next.count += 1
		w.occ_stamp[cell_idx] = w.occ_gen
		w.occ_owner[cell_idx] = owner_idx
		return true, 0.0
	}

	// === COLLISION DAMAGE (The "Punch Up" Rule) ===
	// When sparks collide, BOTH lose energy. Movement = aggression.
	// This breaks stationary clusters because being a "wall" is now fatal.
	owner_idx := w.occ_owner[cell_idx]
	occupant := &w.sparks_next.data[owner_idx]
	
	// Collision damage: Both lose significant energy
	collision_cost: f32 = 8.0  // Damage to BOTH parties
	
	// Attacker takes damage
	s_new.energy -= collision_cost
	
	// Defender takes damage (in place)
	occupant.energy -= collision_cost
	
	// Attacker claims the tile if they survive and have more energy than defender
	if s_new.energy > 0 && s_new.energy > occupant.energy {
		// Replace the occupant (defender dies or is pushed out)
		w.sparks_next.data[owner_idx] = s_new^
		return true, collision_cost
	}
	
	// Attacker failed to claim (either died or was too weak)
	return false, collision_cost
}

environmental_physics_step :: proc(w: ^Byte_World) {
	for _ in 0..<SOLAR_REGROWTH_RATE {
		idx := int(rng_u32_bounded(&w.rng, u32(w.size * w.size)))
		val := w.grid[idx]

		// Solar Regrowth (Nature reclaiming void)
		// IMPORTANT: Don't regrow on occupied tiles (no free food delivery!)
		if val <= RANGE_VOID_MAX && w.occ_stamp[idx] != w.occ_gen {
			if rng_u32_bounded(&w.rng, SOLAR_REGROWTH_CHANCE) == 0 {
				w.grid[idx] = u8(rng_int_inclusive(&w.rng, int(RANGE_WALL_MAX) + 1, int(RANGE_SOLAR_MAX)))
			}
		}
	}
}

byte_world_step :: proc(w: ^Byte_World) {
	// Only shuffle every N ticks - significant performance savings
	w.shuffle_counter += 1
	if w.shuffle_counter >= SHUFFLE_FREQUENCY {
		w.shuffle_counter = 0
		shuffle_sparks(spark_buf_slice(&w.sparks), &w.rng)
	}

	spark_buf_clear(&w.sparks_next)
	occ_begin_step(w)
	
	environmental_physics_step(w)

	for s0 in spark_buf_slice(&w.sparks) {
		s := s0
		
		current_idx := idx_of(w.size, s.x, s.y)

		// === THE DECISION LOOP ===
		// 1. Read the grid value at current position
		grid_val := w.grid[current_idx]
		
		// 2. Combine with internal state to select a microcode function
		lookup_key := s.internal_state ~ grid_val
		func_idx := s.decision_matrix[lookup_key]
		
		// 3. Execute the selected microcode
		execute_microcode(w, &s, func_idx)
		
		// 4. Update internal state (simple feedback loop)
		s.internal_state = s.internal_state ~ s.reg_a
		
		// === OLD AGE SYSTEM (Entropy) ===
		// Age increases metabolic cost - forces generational turnover
		s.age += 1
		entropy_cost := 0.1 + (f32(s.age) * 0.001)  // Gets more expensive to live as you age
		s.energy -= entropy_cost
		
		// === METABOLISM SYSTEM (Anti-Oscillation) ===
		// Calculate displacement from last position
		dx_float := f32(s.x - s.last_x)
		dy_float := f32(s.y - s.last_y)
		
		// Handle wrapping (toroidal topology)
		if abs(dx_float) > f32(w.size) / 2.0 {
			dx_float = f32(w.size) - abs(dx_float)
		}
		if abs(dy_float) > f32(w.size) / 2.0 {
			dy_float = f32(w.size) - abs(dy_float)
		}
		
		displacement := math.sqrt(dx_float*dx_float + dy_float*dy_float)
		
		// Update metabolism based on movement
		// Moving increases metabolism, staying still decreases it
		if displacement > 0.5 {
			s.metabolism += displacement * 0.5  // Gain metabolism by moving
			if s.metabolism > 100.0 {
				s.metabolism = 100.0
			}
		} else {
			s.metabolism -= 2.0  // Lose metabolism by staying still
			if s.metabolism < 0.0 {
				s.metabolism = 0.0
			}
		}
		
		// Metabolism Tax: Low metabolism bleeds energy (forces nomadic behavior)
		if s.metabolism < 20.0 {
			// Punishment scales with how low metabolism is
			metabolism_penalty := (20.0 - s.metabolism) * 0.15
			s.energy -= metabolism_penalty
		}
		
		// Update last position for next tick
		s.last_x = s.x
		s.last_y = s.y
		
		// === SURVIVAL CHECK ===
		if s.energy > 0 && s.energy < ENERGY_CAP {
			// Try to claim current position (after potential movement)
			new_idx := idx_of(w.size, s.x, s.y)
			if ok, damage := occ_claim_or_takeover(w, new_idx, &s); ok {
				// Successfully claimed tile
				// Collision damage is already applied inside occ_claim_or_takeover
			}
			// If we couldn't claim, the spark dies (collision killed it)
		}
		// Spark died (no corpse recycling)
	}

	// Extinction failsafe
	if w.sparks_next.count == 0 {
		for _ in 0..<SPARK_COUNT_MIN {
			if !spawn_spark_into_unique(w, &w.sparks_next) { break }
		}
	}

	w.tick += 1
	w.sparks, w.sparks_next = w.sparks_next, w.sparks
}

// ============================================================================
// RENDERING
// ============================================================================

render_world_pixels :: proc(w: ^Byte_World, pixels: []rl.Color) {
	assert(len(pixels) == len(w.grid))

	// Clear to black background
	for i in 0..<len(pixels) {
		pixels[i] = rl.BLACK
	}

	// Render only sparks with their lineage colors
	for s in spark_buf_slice(&w.sparks) {
		pixels[idx_of(w.size, s.x, s.y)] = s.color
	}
}


// ============================================================================
// MAIN
// ============================================================================

main :: proc() {
	rl.SetConfigFlags(rl.ConfigFlags{.WINDOW_RESIZABLE, .VSYNC_HINT})
	rl.InitWindow(WINDOW_W, WINDOW_H, "Byte-Physics: Microcode Architecture")
	defer rl.CloseWindow()
	rl.SetTargetFPS(60)

	seed := seed_from_system_time()
	world := byte_world_make(GRID_SIZE, seed)

	image := rl.GenImageColor(i32(world.size), i32(world.size), rl.BLACK)
	texture := rl.LoadTextureFromImage(image)
	rl.UnloadImage(image)
	defer rl.UnloadTexture(texture)
	rl.SetTextureFilter(texture, rl.TextureFilter.POINT)

	pixels := make([]rl.Color, len(world.grid))

	paused := false
	steps_per_frame := 1
	zoom: f32 = 1.0
	pan := rl.Vector2{0, 0}
	pixel_perfect := true

	for !rl.WindowShouldClose() {
		// Controls
		if rl.IsKeyPressed(.SPACE) { paused = !paused }
		if rl.IsKeyPressed(.R) {
			seed = seed_from_system_time()
			byte_world_reseed(&world, seed)
		}
		if rl.IsKeyPressed(.F) { zoom = 1.0; pan = rl.Vector2{0, 0} }
		if rl.IsKeyPressed(.P) { pixel_perfect = !pixel_perfect }
		if rl.IsKeyPressed(.N) && paused {
			byte_world_step(&world)
		}
		if rl.IsKeyPressed(.EQUAL) || rl.IsKeyPressed(.KP_ADD) {
			steps_per_frame += 1
			if steps_per_frame > 256 { steps_per_frame = 256 }
		}
		if rl.IsKeyPressed(.MINUS) || rl.IsKeyPressed(.KP_SUBTRACT) {
			steps_per_frame -= 1
			if steps_per_frame < 1 { steps_per_frame = 1 }
		}
		if rl.IsKeyPressed(.I) {
			for _ in 0..<5000 {
				if !spawn_spark_into(&world, &world.sparks) { break }
			}
		}

		if rl.IsKeyPressed(.G) {
			auto_solar_enabled = !auto_solar_enabled
			fmt.println(auto_solar_enabled ? "Auto-Solar mode enabled" : "Manual Solar mode enabled")
		}
		
		if rl.IsKeyPressed(.J) {
			auto_inject_enabled = !auto_inject_enabled
			auto_inject_timer = 0.0
			fmt.println(auto_inject_enabled ? "Auto-Injection mode enabled" : "Auto-Injection mode disabled")
		}

		dt := rl.GetFrameTime()
		pan_speed := 600.0 * dt
		if rl.IsKeyDown(.LEFT)  { pan.x -= pan_speed }
		if rl.IsKeyDown(.RIGHT) { pan.x += pan_speed }
		if rl.IsKeyDown(.UP)    { pan.y -= pan_speed }
		if rl.IsKeyDown(.DOWN)  { pan.y += pan_speed }

		wheel_steps := int(rl.GetMouseWheelMove())
		if wheel_steps != 0 {
			ctrl_down := rl.IsKeyDown(.LEFT_CONTROL) || rl.IsKeyDown(.RIGHT_CONTROL)
			if ctrl_down {
				if wheel_steps > 0 {
					for _ in 0..<wheel_steps { zoom *= 1.1 }
				} else {
					for _ in 0..<(-wheel_steps) { zoom /= 1.1 }
				}
			}
		}
		if zoom < 0.25 { zoom = 0.25 }
		if zoom > 64.0 { zoom = 64.0 }

		if auto_solar_enabled {
			auto_solar_time += dt * auto_solar_speed
			cycle_value := smooth_solar_cycle(auto_solar_time)
			solar_bonus_max_setting = auto_solar_base + (cycle_value * auto_solar_amplitude)
		}
		
		if auto_inject_enabled {
			auto_inject_timer += dt
			if auto_inject_timer >= auto_inject_interval {
				auto_inject_timer = 0.0
				injected := 0
				for _ in 0..<auto_inject_count {
					if spawn_spark_into(&world, &world.sparks) {
						injected += 1
					} else {
						break
					}
				}
				fmt.println("Auto-Injection:", injected, "sparks injected")
			}
		}
		
		spark_ratio := f32(world.sparks.count) / f32(SPARK_CAP)
		solar_bonus_max = solar_bonus_max_setting * (1.0 - spark_ratio)

		if !paused {
			for _ in 0..<steps_per_frame {
				byte_world_step(&world)
			}
		}

		render_world_pixels(&world, pixels)
		rl.UpdateTexture(texture, raw_data(pixels))

		sw := rl.GetScreenWidth()
		sh := rl.GetScreenHeight()

		title_font_size :: 20
		body_font_size  :: 18
		pad_y           :: 6
		ui_top: i32 = i32(8 + title_font_size + pad_y + (body_font_size+2)*4 + pad_y)
		if ui_top > sh-1 { ui_top = sh-1 }

		src := rl.Rectangle{0, 0, f32(world.size), f32(world.size)}
		view_w := sw
		view_h := sh - ui_top
		base_scale := min_f32(f32(view_w)/f32(world.size), f32(view_h)/f32(world.size))
		scale := base_scale * zoom
		if pixel_perfect {
			si := int(scale)
			if si < 1 { si = 1 }
			scale = f32(si)
		}

		dst_w := f32(world.size) * scale
		dst_h := f32(world.size) * scale
		dst_x := (f32(view_w) - dst_w) * 0.5 + pan.x
		dst_y := f32(ui_top) + (f32(view_h) - dst_h) * 0.5 + pan.y
		if dst_y < f32(ui_top)+2 { dst_y = f32(ui_top) + 2 }
		dst := rl.Rectangle{dst_x, dst_y, dst_w, dst_h}

		rl.BeginDrawing()
		rl.ClearBackground(rl.BLACK)

		rl.DrawRectangle(0, 0, sw, ui_top, rl.Color{0, 0, 0, 180})
		hud_x: i32 = 10
		hud_y: i32 = 8
		rl.DrawText("Byte-Physics: Microcode Architecture (Evolvable Instruction Sets)", hud_x, hud_y, title_font_size, rl.RAYWHITE)
		hud_y += title_font_size + pad_y
		rl.DrawText("SPACE: pause   N: step   R: reseed   I: inject 5k   +/-: steps/frame   Ctrl+Wheel: zoom   Arrows: pan   F: reset view", hud_x, hud_y, body_font_size, rl.RAYWHITE)
		hud_y += body_font_size + 2
		rl.DrawText("G: auto-solar   J: auto-inject   P: pixel-perfect", hud_x, hud_y, body_font_size, rl.RAYWHITE)
		hud_y += body_font_size + 2
		
		// Draw Atom legend
		legend_x := hud_x
		rl.DrawText("Atoms: NOP DX+ DX- DY+ DY- MOVE READ WRITE ENG XFER SPLIT INC DEC SWAP JMPIF RESET | HGT SENSE CALL RAND", legend_x, hud_y, body_font_size, rl.Color{200, 200, 200, 255})
		hud_y += body_font_size + 2
		
		status_extras := ""
		if auto_solar_enabled {
			status_extras = fmt.tprintf("%s  [Solar:AUTO]", status_extras)
		}
		if auto_inject_enabled {
			status_extras = fmt.tprintf("%s  [Inject:%.0fs]", status_extras, auto_inject_interval - auto_inject_timer)
		}
		
		rl.DrawText(rl.TextFormat("tick=%d   sparks=%d/%d   steps/frame=%d   zoom=%.2f%s", world.tick, world.sparks.count, int(SPARK_CAP), steps_per_frame, zoom, cstring(raw_data(status_extras))), hud_x, hud_y, body_font_size, rl.RAYWHITE)

		// Sliders
		draw_slider_f32 :: proc(x, y, width, height: i32, value: ^f32, min_val, max_val: f32, label: cstring, mouse_pos: rl.Vector2) {
			slider_rect := rl.Rectangle{f32(x), f32(y), f32(width), f32(height)}
			rl.DrawRectangleRec(slider_rect, rl.Color{50, 50, 50, 255})
			
			slider_fill_width := (value^ - min_val) / (max_val - min_val) * f32(width)
			slider_fill_rect := rl.Rectangle{f32(x), f32(y), slider_fill_width, f32(height)}
			rl.DrawRectangleRec(slider_fill_rect, rl.Color{100, 200, 100, 255})
			
			handle_x := f32(x) + slider_fill_width
			handle_rect := rl.Rectangle{handle_x - 5, f32(y) - 2, 10, f32(height) + 4}
			rl.DrawRectangleRec(handle_rect, rl.RAYWHITE)
			
			rl.DrawText(rl.TextFormat("%s: %.2f", label, value^), x, y + height + 5, 14, rl.RAYWHITE)
			
			if rl.IsMouseButtonDown(.LEFT) {
				if rl.CheckCollisionPointRec(mouse_pos, slider_rect) {
					local_x := mouse_pos.x - f32(x)
					if local_x < 0 { local_x = 0 }
					if local_x > f32(width) { local_x = f32(width) }
					t := local_x / f32(width)
					value^ = min_val + t * (max_val - min_val)
				}
			}
		}
		
		draw_slider_int :: proc(x, y, width, height: i32, value: ^int, min_val, max_val: int, label: cstring, mouse_pos: rl.Vector2) {
			slider_rect := rl.Rectangle{f32(x), f32(y), f32(width), f32(height)}
			rl.DrawRectangleRec(slider_rect, rl.Color{50, 50, 50, 255})
			
			slider_fill_width := f32(value^ - min_val) / f32(max_val - min_val) * f32(width)
			slider_fill_rect := rl.Rectangle{f32(x), f32(y), slider_fill_width, f32(height)}
			rl.DrawRectangleRec(slider_fill_rect, rl.Color{100, 200, 100, 255})
			
			handle_x := f32(x) + slider_fill_width
			handle_rect := rl.Rectangle{handle_x - 5, f32(y) - 2, 10, f32(height) + 4}
			rl.DrawRectangleRec(handle_rect, rl.RAYWHITE)
			
			rl.DrawText(rl.TextFormat("%s: %d", label, value^), x, y + height + 5, 14, rl.RAYWHITE)
			
			if rl.IsMouseButtonDown(.LEFT) {
				if rl.CheckCollisionPointRec(mouse_pos, slider_rect) {
					local_x := mouse_pos.x - f32(x)
					if local_x < 0 { local_x = 0 }
					if local_x > f32(width) { local_x = f32(width) }
					t := local_x / f32(width)
					value^ = min_val + int(t * f32(max_val - min_val))
				}
			}
		}
		
		mouse_pos := rl.GetMousePosition()
		slider_x: i32 = sw - 400
		slider_y: i32 = 10
		slider_width: i32 = 200
		slider_height: i32 = 20
		
		slider_rect := rl.Rectangle{f32(slider_x), f32(slider_y), f32(slider_width), f32(slider_height)}
		rl.DrawRectangleRec(slider_rect, rl.Color{50, 50, 50, 255})
		slider_min: f32 = 0.0
		slider_max: f32 = 50.0
		slider_fill_width := (solar_bonus_max_setting - slider_min) / (slider_max - slider_min) * f32(slider_width)
		fill_color := auto_solar_enabled ? rl.Color{200, 150, 50, 255} : rl.Color{100, 200, 100, 255}
		slider_fill_rect := rl.Rectangle{f32(slider_x), f32(slider_y), slider_fill_width, f32(slider_height)}
		rl.DrawRectangleRec(slider_fill_rect, fill_color)
		handle_x := f32(slider_x) + slider_fill_width
		handle_color := auto_solar_enabled ? rl.GOLD : rl.RAYWHITE
		handle_rect := rl.Rectangle{handle_x - 5, f32(slider_y) - 2, 10, f32(slider_height) + 4}
		rl.DrawRectangleRec(handle_rect, handle_color)
		solar_label := auto_solar_enabled ? "Solar Max [AUTO]:" : "Solar Max:"
		rl.DrawText(rl.TextFormat("%s %.1f (actual: %.1f)", cstring(raw_data(solar_label)), solar_bonus_max_setting, solar_bonus_max), slider_x, slider_y + slider_height + 5, 14, rl.RAYWHITE)
		if !auto_solar_enabled && rl.IsMouseButtonDown(.LEFT) {
			if rl.CheckCollisionPointRec(mouse_pos, slider_rect) {
				local_x := mouse_pos.x - f32(slider_x)
				if local_x < 0 { local_x = 0 }
				if local_x > f32(slider_width) { local_x = f32(slider_width) }
				t := local_x / f32(slider_width)
				solar_bonus_max_setting = slider_min + t * (slider_max - slider_min)
			}
		}
		
		if auto_solar_enabled {
			slider_y += 45
			rl.DrawText("--- Auto-Solar (Tides/Seasons) ---", slider_x, slider_y - 5, 14, rl.GOLD)
			slider_y += 20
			draw_slider_f32(slider_x, slider_y, slider_width, slider_height, &auto_solar_speed, 0.01, 0.5, "Speed", mouse_pos)
			slider_y += 40
			draw_slider_f32(slider_x, slider_y, slider_width, slider_height, &auto_solar_amplitude, 5.0, 40.0, "Amplitude", mouse_pos)
			slider_y += 40
			draw_slider_f32(slider_x, slider_y, slider_width, slider_height, &auto_solar_base, 0.0, 30.0, "Base Level", mouse_pos)
		}
		
		if auto_inject_enabled {
			slider_y += 45
			time_left := auto_inject_interval - auto_inject_timer
			countdown_text := rl.TextFormat("--- Auto-Inject (%.0fs) ---", time_left)
			rl.DrawText(countdown_text, slider_x, slider_y - 5, 14, rl.LIME)
			slider_y += 20
			draw_slider_f32(slider_x, slider_y, slider_width, slider_height, &auto_inject_interval, 10.0, 300.0, "Interval (sec)", mouse_pos)
			slider_y += 40
			draw_slider_int(slider_x, slider_y, slider_width, slider_height, &auto_inject_count, 100, 20000, "Spark Count", mouse_pos)
		}

		origin := rl.Vector2{0, 0}
		rl.DrawTexturePro(texture, src, dst, origin, 0, rl.WHITE)

		rl.DrawFPS(10, ui_top + 10)

		rl.EndDrawing()
	}
}
