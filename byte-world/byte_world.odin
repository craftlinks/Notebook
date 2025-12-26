package main

import rl "vendor:raylib"

import "core:time"
import "core:os"
import "core:fmt"

// --------------------------------------------
// Byte-Physics World (Odin port of byte-world.md)
// --------------------------------------------

GRID_SIZE :: 800

WINDOW_W :: 2048
WINDOW_H :: 2048

// Value ranges (ontology)
RANGE_VOID_MAX  : u8 = 63   // Empty space / Passive data
RANGE_WALL_MAX  : u8 = 127  // Reflective matter (even=H-reflect, odd=V-reflect)
RANGE_SOLAR_MAX : u8 = 191  // Energy sources (metabolism)
// 192..255 are "active instructions" (ops)

// Metabolic costs
COST_MOVE   : f32 = 0.2   // Entropy: cost to exist/move per tick
COST_WRITE  : f32 = 1.0   // Work: cost to change a grid value
COST_WRITE_WALL : f32 = 2.0  // Work: cost to overwrite a wall (structural change)
COST_SPLIT  : f32 = 6.0  // Reproduction: cost to create a child
COST_MATH   : f32 = 0.1   // Processing: cost to compute (INC/DEC)
PENALTY_HIT : f32 = -0.01   // Damage: cost when hitting a wall
PENALTY_BLOCKED : f32 = 0.5 // Damage: cost when trying to move into an occupied cell

// Metabolic gains
SOLAR_BASE_GAIN : f32 = 0.0 // Minimum energy from a solar tile
solar_bonus_max_setting : f32 = 20.0 // Max solar bonus (adjustable via slider, when few sparks)
solar_bonus_max : f32 = 20.0 // Actual solar bonus (computed dynamically based on spark count)
SOLAR_DRAIN_PER_HARVEST  : u8 = 2 // When a spark steps onto solar

ENERGY_CAP : f32 = 1000.0

// Rendering alpha dynamics
ALPHA_DECAY_PER_TICK : f32 = 0.002  // Small fade per tick for unused cells
ALPHA_GAIN_ON_VISIT  : f32 = 0.090   // Large boost when spark visits (>> decay)

// Randomization of forgotten regions
RANDOMIZE_THRESHOLD : f32 = 0.05  // Alpha level below which cells can be randomized
RANDOMIZE_CHANCE    : f32 = 0.5   // Probability of randomizing a low-alpha cell

// Op codes
OP_LOAD   : u8 = 200 // Register = Grid[Ahead]
OP_STORE  : u8 = 201 // Grid[Ahead] = Register
OP_SPLIT  : u8 = 202 // Divide energy, spawn orthogonal child
OP_LEFT   : u8 = 203 // Turn 90° counter-clockwise
OP_RIGHT  : u8 = 204 // Turn 90° clockwise
OP_INC    : u8 = 205 // Register++
OP_DEC    : u8 = 206 // Register--
OP_BRANCH : u8 = 207 // If Register < 128 -> LEFT else RIGHT
OP_SWAP   : u8 = 208 // Swap Register <-> Grid[Ahead]
OP_PICKUP : u8 = 209 // Inventory = Grid[Ahead], Grid[Ahead] = VOID (if inventory empty)
OP_DROP   : u8 = 210 // Grid[Ahead] = Inventory, Inventory = EMPTY (if grid ahead is VOID)

SPARK_COUNT_MIN : int = 150000

SPARK_MAX_AGE_TICKS : int = 1000

// Maximum number of SOLAR writes a spark can perform in its lifetime
SPARK_MAX_SOLAR_WRITES : int = 4

// Hard upper bound on total sparks alive at once.
SPARK_CAP :: 150_000

Spark :: struct {
	x, y: int,
	dx, dy: int,      // -1, 0, 1
	energy: f32,
	register: u8,     // 8-bit payload (0..255)
	age: int,
	solar_writes: int, // Number of SOLAR cells written during lifetime
	color: rl.Color,  // Lineage color (inherited from parent)
	inventory: u8,    // Cargo slot (holds a Grid Byte, separate from register)
}

Spark_Buffer :: struct {
	data: []Spark, // backing storage is allocated once (fixed capacity)
	count: int,
}

Byte_World :: struct {
	size: int,
	tick: u64,

	grid: []u8,
	alpha: []f32,  // Alpha channel per cell (0.0 to 1.0)

	// Two buffers to avoid per-tick allocations.
	sparks: Spark_Buffer,
	sparks_next: Spark_Buffer,

	// Spark occupancy for the *next* generation.
	// Uses a stamp buffer so we don't clear GRID_SIZE^2 booleans every tick.
	occ_stamp: []u32,
	// Owner (index into `sparks_next.data`) for each occupied cell in the current
	// `occ_gen`. Only valid when `occ_stamp[idx] == occ_gen`.
	occ_owner: []int,
	occ_gen: u32,

	rng: u32,
}

// ----------------
// Pattern/Blueprint System
// ----------------

// A spark relative to the top-left of a pattern
Relative_Spark :: struct {
	rel_x, rel_y: i16, // Relative offset
	dx, dy:       i8,
	register:     u8,
	color_r:      u8,
	color_g:      u8,
	color_b:      u8,
	inventory:    u8,  // Cargo slot
}

// The blueprint structure
Pattern :: struct {
	width, height: int,
	cells:         []u8,
	sparks:        [dynamic]Relative_Spark,
}

free_pattern :: proc(p: ^Pattern) {
	delete(p.cells)
	delete(p.sparks)
}

// ----------------
// Auto-Detection System
// ----------------

// A structure to hold found patterns temporarily
Detected_Blob :: struct {
	rect:   rl.Rectangle, // The bounding box
	score:  f32,          // Average alpha (heat)
	pixels: int,          // Total area
}

// Global list of detected blobs (reset every detection frame)
detected_blobs: [dynamic]Detected_Blob

// Configuration (now adjustable via sliders)
detect_alpha_threshold : f32 = 0.12   // Cell must be this bright to be part of a blob
min_blob_size          : int = 4     // Width/Height minimum
max_blob_size          : int = 512   // Max size (ignore world-spanning chaos)
min_pixel_count        : int = 128    // Minimum active cells to count as a pattern

detect_active_regions :: proc(w: ^Byte_World) {
	// Clear previous results
	clear(&detected_blobs)

	// Keep track of visited cells during this scan
	visited := make([]bool, w.size * w.size)
	defer delete(visited)

	// Stack for flood fill
	stack := make([dynamic]int, 0, 1000)
	defer delete(stack)

	for y := 0; y < w.size; y += 1 {
		for x := 0; x < w.size; x += 1 {
			idx := idx_of(w.size, x, y)
			
			// If hot and not visited, start a new blob detection
			if w.alpha[idx] > detect_alpha_threshold && !visited[idx] {
				
				// --- Start Flood Fill ---
				append(&stack, idx)
				visited[idx] = true

				min_x, max_x := x, x
				min_y, max_y := y, y
				total_alpha: f32 = 0.0
				count: int = 0

				for len(stack) > 0 {
					curr_idx := pop(&stack)
					curr_val := w.alpha[curr_idx]
					
					cx := curr_idx % w.size
					cy := curr_idx / w.size

					// Update bounds
					if cx < min_x { min_x = cx }
					if cx > max_x { max_x = cx }
					if cy < min_y { min_y = cy }
					if cy > max_y { max_y = cy }
					
					total_alpha += curr_val
					count += 1

					// Check 4 neighbors
					// We only follow "hot" paths
					// We do NOT wrap here, because a pattern wrapping around the screen edge 
					// is hard to save/load as a simple rectangle.
					
					// Up
					if cy > 0 {
						n_idx := curr_idx - w.size
						if !visited[n_idx] && w.alpha[n_idx] > detect_alpha_threshold {
							visited[n_idx] = true
							append(&stack, n_idx)
						}
					}
					// Down
					if cy < w.size-1 {
						n_idx := curr_idx + w.size
						if !visited[n_idx] && w.alpha[n_idx] > detect_alpha_threshold {
							visited[n_idx] = true
							append(&stack, n_idx)
						}
					}
					// Left
					if cx > 0 {
						n_idx := curr_idx - 1
						if !visited[n_idx] && w.alpha[n_idx] > detect_alpha_threshold {
							visited[n_idx] = true
							append(&stack, n_idx)
						}
					}
					// Right
					if cx < w.size-1 {
						n_idx := curr_idx + 1
						if !visited[n_idx] && w.alpha[n_idx] > detect_alpha_threshold {
							visited[n_idx] = true
							append(&stack, n_idx)
						}
					}
				}

				// --- End Flood Fill ---

				width := max_x - min_x + 1
				height := max_y - min_y + 1

				// Filter noise
				if width >= min_blob_size && height >= min_blob_size && 
				   width <= max_blob_size && height <= max_blob_size &&
				   count >= min_pixel_count {
					
					// Add padding to the rect so we catch sparks slightly outside the core path
					pad :: 2
					final_x := max(0, min_x - pad)
					final_y := max(0, min_y - pad)
					final_w := min(w.size - final_x, width + pad*2)
					final_h := min(w.size - final_y, height + pad*2)

					append(&detected_blobs, Detected_Blob{
						rect = rl.Rectangle{f32(final_x), f32(final_y), f32(final_w), f32(final_h)},
						score = total_alpha / f32(count),
						pixels = count,
					})
				}
			}
		}
	}
}

// ----------------
// Small utilities
// ----------------

min_f32 :: proc(a, b: f32) -> f32 {
	return b if a > b else a
}

// Convert HSV to RGB. H in [0, 360), S and V in [0, 1]
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

wrap_i :: proc(i, n: int) -> int {
	// Wrap i into [0, n). Works for negative i too.
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

// ----------------
// RNG (xorshift32)
// ----------------

rng_next_u32 :: proc(state: ^u32) -> u32 {
	// Simple xorshift32.
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
	// Uniform choice from {-1, 0, +1}.
	r := rng_u32_bounded(state, 3)
	switch r {
	case 0: return -1
	case 1: return 0
	case 2: return 1
	}
	return 0
}

shuffle_sparks :: proc(sparks: []Spark, rng: ^u32) {
	// Fisher-Yates shuffle, in-place.
	if len(sparks) <= 1 {
		return
	}
	for i := len(sparks)-1; i > 0; i -= 1 {
		j := rng_int_inclusive(rng, 0, i)
		sparks[i], sparks[j] = sparks[j], sparks[i]
	}
}

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

// -------------------------
// World seeding / lifecycle
// -------------------------

seed_from_system_time :: proc() -> u32 {
	// Mix wall-clock and cycle counter for a cheap, high-entropy seed.
	nsec := u64(time.to_unix_nanoseconds(time.now()))
	cc := time.read_cycle_counter()
	mixed := nsec ~ (cc << 1) ~ (nsec >> 23) ~ 0xA5A5_A5A5_A5A5_A5A5
	return u32(mixed ~ (mixed >> 32))
}

byte_world_make :: proc(size: int, seed: u32) -> Byte_World {
	assert(size > 0)
	cell_count := size * size

	// Allocate once; we'll reuse these buffers every tick.
	grid := make([]u8, cell_count)
	alpha := make([]f32, cell_count)
	occ_stamp := make([]u32, cell_count)
	occ_owner := make([]int, cell_count)

	// Fixed-capacity spark pools (hard cap); no per-tick allocations.
	sparks_a := Spark_Buffer{data = make([]Spark, SPARK_CAP), count = 0}
	sparks_b := Spark_Buffer{data = make([]Spark, SPARK_CAP), count = 0}

	w := Byte_World{
		size = size,
		tick = 0,
		grid = grid,
		alpha = alpha,
		sparks = sparks_a,
		sparks_next = sparks_b,
		occ_stamp = occ_stamp,
		occ_owner = occ_owner,
		occ_gen = 1,
		rng = seed,
	}
	byte_world_reseed(&w, seed)
	return w
}

byte_world_reseed :: proc(w: ^Byte_World, seed: u32) {
	w.tick = 0
	w.rng = seed ~ u32(w.size*73856093) ~ 0x9E37_79B9

	spark_buf_clear(&w.sparks)
	spark_buf_clear(&w.sparks_next)

	// Reset occupancy stamping.
	for i in 0..<len(w.occ_stamp) {
		w.occ_stamp[i] = 0
		w.occ_owner[i] = 0
	}
	w.occ_gen = 1

	// Initialize alpha values to low opacity
	for i in 0..<len(w.alpha) {
		w.alpha[i] = 0.05
	}

	// Base noise (void/data)
	for i in 0..<len(w.grid) {
		r := rng_u32_bounded(&w.rng, 100)
		if r < 5 {
			// Void (0..63) - 40% of universe
			w.grid[i] = u8(rng_u32_bounded(&w.rng, u32(RANGE_VOID_MAX) + 1))
		} else if r < 15 {
			// Wall (64..127) - 5% of universe
			w.grid[i] = u8(rng_int_inclusive(&w.rng, int(RANGE_VOID_MAX) + 1, int(RANGE_WALL_MAX)))
		} else if r < 25 {
			// Solar (128..191) - 5% of universe
			w.grid[i] = u8(rng_int_inclusive(&w.rng, int(RANGE_WALL_MAX) + 1, int(RANGE_SOLAR_MAX)))
		} else {
			// Ops (192..255) - 50% of universe
			w.grid[i] = u8(rng_int_inclusive(&w.rng, int(RANGE_SOLAR_MAX) + 1, 255))
		}
	}

	// // Solar clusters (food)
	// for _ in 0..<30 {
	// 	cx := rng_int_inclusive(&w.rng, 0, w.size-1)
	// 	cy := rng_int_inclusive(&w.rng, 0, w.size-1)
	// 	radius := rng_int_inclusive(&w.rng, 2, 5)

	// 	for y := cy-radius; y < cy+radius; y += 1 {
	// 		for x := cx-radius; x < cx+radius; x += 1 {
	// 			if !in_bounds(w.size, x, y) { continue }
	// 			val := u8(128 + rng_u32_bounded(&w.rng, 64)) // 128..191
	// 			w.grid[idx_of(w.size, x, y)] = val
	// 		}
	// 	}
	// }

	// // Wall debris (obstacles)
	// for _ in 0..<200 {
	// 	rx := rng_int_inclusive(&w.rng, 0, w.size-1)
	// 	ry := rng_int_inclusive(&w.rng, 0, w.size-1)
	// 	val := u8(64 + rng_u32_bounded(&w.rng, 64)) // 64..127
	// 	w.grid[idx_of(w.size, rx, ry)] = val
	// }

	// Spawn initial sparks
	for _ in 0..<SPARK_COUNT_MIN {
		if !spawn_spark_into_unique(w, &w.sparks) { break }
	}
}

spawn_spark_into :: proc(w: ^Byte_World, sparks: ^Spark_Buffer) -> bool {
	// Prefer the buffer's actual capacity to avoid drift if allocation ever changes.
	if sparks.count >= len(sparks.data) {
		return false
	}
	// Generate a distinct, vibrant lineage color
	hue := rng_u32_bounded(&w.rng, 360)
	color := hsv_to_rgb(hue, 0.8, 1.0)
	
	s := Spark{
		x = rng_int_inclusive(&w.rng, 0, w.size-1),
		y = rng_int_inclusive(&w.rng, 0, w.size-1),
		dx = rng_choice_dir_3(&w.rng),
		dy = rng_choice_dir_3(&w.rng),
		energy = f32(rng_int_inclusive(&w.rng, 50, 80)),
		register = 0,
		age = 0,
		solar_writes = 0,
		color = color,
		inventory = RANGE_VOID_MAX, // Empty inventory (max void value = empty)
	}
	// Ensure it's moving.
	if s.dx == 0 && s.dy == 0 {
		s.dx = 1
	}
	return spark_buf_append(sparks, s)
}

spawn_spark_into_unique :: proc(w: ^Byte_World, sparks: ^Spark_Buffer) -> bool {
	// Spawn a spark into an unclaimed cell for the current `w.occ_gen` stamp.
	// Falls back to a normal spawn if we can't find a free cell quickly.
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

		// Generate a distinct, vibrant lineage color
		hue := rng_u32_bounded(&w.rng, 360)
		color := hsv_to_rgb(hue, 0.8, 1.0)

		s := Spark{
			x = x,
			y = y,
			dx = rng_choice_dir_3(&w.rng),
			dy = rng_choice_dir_3(&w.rng),
			energy = f32(rng_int_inclusive(&w.rng, 50, 80)),
			register = 0,
			age = 0,
			solar_writes = 0,
			color = color,
			inventory = RANGE_VOID_MAX, // Empty inventory (max void value = empty)
		}
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

// -----------------
// Simulation update
// -----------------

is_permeable_for_spawn :: proc(v: u8) -> bool {
	// Permeable == not a wall (walls are 64..127).
	return v <= RANGE_VOID_MAX || v > RANGE_WALL_MAX
}

occ_begin_step :: proc(w: ^Byte_World) {
	// Advance generation stamp. If it wraps, clear once.
	w.occ_gen += 1
	if w.occ_gen == 0 {
		for i in 0..<len(w.occ_stamp) {
			w.occ_stamp[i] = 0
			w.occ_owner[i] = 0
		}
		w.occ_gen = 1
	}
}

occ_try_claim :: proc(w: ^Byte_World, idx: int) -> bool {
	if w.occ_stamp[idx] == w.occ_gen {
		return false
	}
	w.occ_stamp[idx] = w.occ_gen
	return true
}

Attempt_Result :: struct {
	ok: bool,
	s: Spark,
	dest_x, dest_y: int,
	dest_idx: int,

	// Deferred mutations (apply only if we actually take this attempt)
	do_solar_drain: bool,
	solar_idx: int,

	do_store: bool,
	store_idx: int,
	store_value: u8,

	// Split spawning (also subject to occupancy)
	do_split: bool,
	child: Spark,
}

color_equal :: proc(a, b: rl.Color) -> bool {
	return a.r == b.r && a.g == b.g && a.b == b.b && a.a == b.a
}

clamp :: proc(v, min_v, max_v: i32) -> i32 {
	if v < min_v { return min_v }
	if v > max_v { return max_v }
	return v
}

mutate_color :: proc(c: rl.Color, rng: ^u32) -> rl.Color {
	// Small chance to mutate color slightly
	r := c.r
	g := c.g
	b := c.b
	
	// 10% chance to drift each channel
	drift :: 15
	if rng_u32_bounded(rng, 100) < 10 {
		delta := i32(rng_u32_bounded(rng, drift*2 + 1)) - drift
		new_r := clamp(i32(r) + delta, 50, 255) // Keep it visible (>50)
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

occ_claim_or_takeover :: proc(w: ^Byte_World, cell_idx: int, s_new: Spark) -> (ok: bool, did_takeover: bool, loot: f32) {
	// Unclaimed: append new occupant.
	if w.occ_stamp[cell_idx] != w.occ_gen {
		if w.sparks_next.count >= len(w.sparks_next.data) {
			return false, false, 0.0
		}
		owner_idx := w.sparks_next.count
		w.sparks_next.data[owner_idx] = s_new
		w.sparks_next.count += 1
		w.occ_stamp[cell_idx] = w.occ_gen
		w.occ_owner[cell_idx] = owner_idx
		return true, false, 0.0
	}

	// Claimed: allow takeover only when different color AND strictly higher energy.
	owner_idx := w.occ_owner[cell_idx]
	occupant := w.sparks_next.data[owner_idx]
	if !color_equal(occupant.color, s_new.color) && s_new.energy > occupant.energy {
		// --- INJECTED MECHANIC: VAMPIRISM ---
		// The victor absorbs 50% of the victim's remaining energy.
		loot := occupant.energy * 0.5
		
		w.sparks_next.data[owner_idx] = s_new
		return true, true, loot
	}
	return false, false, 0.0
}

attempt_with_dir :: proc(w: ^Byte_World, s0: Spark, dirx, diry: int) -> Attempt_Result {
	if dirx == 0 && diry == 0 {
		return Attempt_Result{ok=false}
	}

	s := s0
	s.dx, s.dy = dirx, diry

	nx := wrap_i(s.x + s.dx, w.size)
	ny := wrap_i(s.y + s.dy, w.size)
	nidx := idx_of(w.size, nx, ny)
	val := w.grid[nidx]

	// Randomize low-alpha cells on-demand (forgotten regions become new random code)
	if w.alpha[nidx] < RANDOMIZE_THRESHOLD {
		roll := f32(rng_next_u32(&w.rng)) / f32(max(u32))
		if roll < RANDOMIZE_CHANCE {
			// Randomize using same distribution as initial seeding
			r := rng_u32_bounded(&w.rng, 100)
			if r < 10 {
				val = u8(rng_u32_bounded(&w.rng, u32(RANGE_VOID_MAX) + 1))
			} else if r < 11 {
				val = u8(rng_int_inclusive(&w.rng, int(RANGE_VOID_MAX) + 1, int(RANGE_WALL_MAX)))
			} else if r < 12 {
				val = u8(rng_int_inclusive(&w.rng, int(RANGE_WALL_MAX) + 1, int(RANGE_SOLAR_MAX)))
			} else {
				val = u8(rng_int_inclusive(&w.rng, int(RANGE_SOLAR_MAX) + 1, 255))
			}
			w.grid[nidx] = val
		}
	}

	res := Attempt_Result{
		ok = true,
		s = s,
		dest_x = s.x,
		dest_y = s.y,
		dest_idx = idx_of(w.size, s.x, s.y),
	}

	if val <= RANGE_VOID_MAX {
		res.dest_x, res.dest_y, res.dest_idx = nx, ny, nidx
		return res
	} else if val <= RANGE_WALL_MAX {
		// Wall/mirror: enter the cell, reflect direction, pay hit penalty.
		res.dest_x, res.dest_y, res.dest_idx = nx, ny, nidx
		if (val % 2) == 0 {
			res.s.dx = -res.s.dx
		} else {
			res.s.dy = -res.s.dy
		}
		res.s.energy -= PENALTY_HIT
		return res
	} else if val <= RANGE_SOLAR_MAX {
		// Solar: enter, gain energy, drain tile.
		res.dest_x, res.dest_y, res.dest_idx = nx, ny, nidx
		efficiency := (f32(val) - 128.0) / 64.0
		gain := SOLAR_BASE_GAIN + efficiency*solar_bonus_max
		res.s.energy += gain
		res.do_solar_drain = true
		res.solar_idx = nidx
		return res
	}

	// Operators: enter and execute.
	res.dest_x, res.dest_y, res.dest_idx = nx, ny, nidx

	// Look-ahead (for read/write), relative to the *current* direction.
	ax := wrap_i(nx + res.s.dx, w.size)
	ay := wrap_i(ny + res.s.dy, w.size)
	ahead_idx := idx_of(w.size, ax, ay)

	switch val {
	case OP_LOAD:
		res.s.register = w.grid[ahead_idx]

	case OP_STORE:
		ahead_val := w.grid[ahead_idx]
		write_cost := COST_WRITE
		// Overwriting walls costs more (structural change)
		if ahead_val > RANGE_VOID_MAX && ahead_val <= RANGE_WALL_MAX {
			write_cost = COST_WRITE_WALL
		}
		// Check if we're trying to write a SOLAR value
		is_solar_write := res.s.register > RANGE_WALL_MAX && res.s.register <= RANGE_SOLAR_MAX
		can_write_solar := !is_solar_write || res.s.solar_writes < SPARK_MAX_SOLAR_WRITES
		
		if res.s.energy > write_cost && can_write_solar {
			res.do_store = true
			res.store_idx = ahead_idx
			res.store_value = res.s.register
			res.s.energy -= write_cost
			// Track SOLAR writes
			if is_solar_write {
				res.s.solar_writes += 1
			}
		}

	case OP_SPLIT:
		if res.s.energy > COST_SPLIT {
			half_energy := res.s.energy * 0.5
			half_age := res.s.age / 2
			
			// --- INJECTED MECHANIC: MUTATION ---
			new_color := mutate_color(res.s.color, &w.rng)
			
			child := Spark{
				x = nx,
				y = ny,
				dx = -res.s.dy,
				dy = res.s.dx,
				energy = half_energy,
				register = res.s.register,
				age = half_age,
				solar_writes = 0, // Child starts with fresh solar write counter
				color = new_color, // Use the mutated color
				inventory = res.s.inventory, // Child inherits inventory
			}
			res.do_split = true
			res.child = child
			res.s.energy = half_energy
			res.s.age = half_age
		}

	case OP_LEFT:
		res.s.dx, res.s.dy = res.s.dy, -res.s.dx

	case OP_RIGHT:
		res.s.dx, res.s.dy = -res.s.dy, res.s.dx

	case OP_INC:
		res.s.register = u8((int(res.s.register) + 1) & 255)
		res.s.energy -= COST_MATH

	case OP_DEC:
		res.s.register = u8((int(res.s.register) + 255) & 255)
		res.s.energy -= COST_MATH

	case OP_BRANCH:
		if res.s.register < 128 {
			res.s.dx, res.s.dy = res.s.dy, -res.s.dx
		} else {
			res.s.dx, res.s.dy = -res.s.dy, res.s.dx
		}

	case OP_SWAP:
		ahead_val := w.grid[ahead_idx]
		
		// Determine cost based on what we are swapping with
		swap_cost := COST_WRITE
		if ahead_val > RANGE_VOID_MAX && ahead_val <= RANGE_WALL_MAX {
			swap_cost = COST_WRITE_WALL
		}
		
		// If we have energy, perform the swap
		if res.s.energy > swap_cost {
			// Atomic exchange: Register <-> Grid[Ahead]
			// 1. Update Spark Register (immediate effect)
			old_register := res.s.register
			res.s.register = ahead_val
			
			// 2. Schedule Grid Update (deferred effect)
			res.do_store = true
			res.store_idx = ahead_idx
			res.store_value = old_register
			
			res.s.energy -= swap_cost
		}

	case OP_PICKUP:
		ahead_val := w.grid[ahead_idx]
		// Swap inventory with the cell ahead
		if res.s.energy > COST_WRITE {
			// What's currently in inventory goes to the grid
			old_inventory := res.s.inventory
			// What's in the grid comes to inventory
			res.s.inventory = ahead_val
			// Place old inventory value in the grid
			res.do_store = true
			res.store_idx = ahead_idx
			res.store_value = old_inventory
			res.s.energy -= COST_WRITE
		}

	case OP_DROP:
		ahead_val := w.grid[ahead_idx]
		// Check if inventory has a block AND Grid[Ahead] is VOID
		has_cargo := res.s.inventory != RANGE_VOID_MAX
		is_ahead_void := ahead_val <= RANGE_VOID_MAX
		
		if has_cargo && is_ahead_void && res.s.energy > COST_WRITE {
			// Drop the block
			res.do_store = true
			res.store_idx = ahead_idx
			res.store_value = res.s.inventory
			res.s.inventory = RANGE_VOID_MAX // Empty the inventory
			res.s.energy -= COST_WRITE
		}

	case:
		// Unknown op tile: treated as permeable no-op.
	}

	return res
}

try_spawn_child_adjacent :: proc(w: ^Byte_World, parent_x, parent_y: int, child0: Spark) -> (ok: bool, child: Spark) {
	child = child0

	// Prefer spawning the child one cell forward in its heading, else try the opposite.
	tx := wrap_i(parent_x + child.dx, w.size)
	ty := wrap_i(parent_y + child.dy, w.size)
	tidx := idx_of(w.size, tx, ty)
	if is_permeable_for_spawn(w.grid[tidx]) && w.occ_stamp[tidx] != w.occ_gen {
		child.x, child.y = tx, ty
		return true, child
	}

	child.dx, child.dy = -child.dx, -child.dy
	tx2 := wrap_i(parent_x + child.dx, w.size)
	ty2 := wrap_i(parent_y + child.dy, w.size)
	tidx2 := idx_of(w.size, tx2, ty2)
	if is_permeable_for_spawn(w.grid[tidx2]) && w.occ_stamp[tidx2] != w.occ_gen {
		child.x, child.y = tx2, ty2
		return true, child
	}

	return false, child0
}

byte_world_step :: proc(w: ^Byte_World) {
	shuffle_sparks(spark_buf_slice(&w.sparks), &w.rng)

	spark_buf_clear(&w.sparks_next)
	occ_begin_step(w)

	// Decay alpha for all cells (emphasizes actively used code paths)
	for i in 0..<len(w.alpha) {
		w.alpha[i] -= ALPHA_DECAY_PER_TICK
		if w.alpha[i] < 0 { w.alpha[i] = 0 }
	}

	for s0 in spark_buf_slice(&w.sparks) {
		s := s0
		s.age += 1

		// Mark current cell as visited (boost alpha to visualize active code paths)
		current_idx := idx_of(w.size, s.x, s.y)
		w.alpha[current_idx] = min_f32(w.alpha[current_idx] + ALPHA_GAIN_ON_VISIT, 1.0)

		// --- Physics interpreter with occupancy ---
		// Rule update:
		// - If target cell is occupied: a different-color spark with strictly higher energy
		//   takes over the cell (kills the occupant).
		// - If same color OR equal energy: keep old rule (first mover keeps the cell).
		blocked := false

		attempt := attempt_with_dir(w, s, s.dx, s.dy)
		s_attempt := attempt.s
		s_attempt.x, s_attempt.y = attempt.dest_x, attempt.dest_y

		// Would the parent survive if it took this attempt?
		energy_move := s_attempt.energy - COST_MOVE
		survives_move := energy_move > 0 && energy_move < ENERGY_CAP && s_attempt.age < SPARK_MAX_AGE_TICKS

		if survives_move {
			// Candidate occupant if we can enter/take this destination.
			s_move := s_attempt
			s_move.energy = energy_move

			if ok, _, loot := occ_claim_or_takeover(w, attempt.dest_idx, s_move); ok {
				s = s_move
				
				// Apply the predatory gain (Vampirism)
				s.energy += loot
				if s.energy > ENERGY_CAP { s.energy = ENERGY_CAP }

				// Commit deferred grid mutations now that we actually entered/stayed.
				if attempt.do_solar_drain {
					w.grid[attempt.solar_idx] -= SOLAR_DRAIN_PER_HARVEST
				}
				if attempt.do_store {
					w.grid[attempt.store_idx] = attempt.store_value
				}

				// Split: spawn child into an adjacent free cell (never same cell).
				if attempt.do_split {
					if w.sparks_next.count < len(w.sparks_next.data) {
						if ok, child := try_spawn_child_adjacent(w, s.x, s.y, attempt.child); ok {
							child_owner_idx := w.sparks_next.count
							_ = spark_buf_append(&w.sparks_next, child)
							cidx := idx_of(w.size, child.x, child.y)
							w.occ_stamp[cidx] = w.occ_gen
							w.occ_owner[cidx] = child_owner_idx
						}
					}
				}
			} else {
				// Blocked by occupancy: no-op (no movement, no op/solar execution).
				blocked = true
			}
		} else {
			// Parent won't persist; still execute physical/op effects, but don't claim occupancy.
			s = s_attempt
			if attempt.do_solar_drain {
				w.grid[attempt.solar_idx] -= SOLAR_DRAIN_PER_HARVEST
			}
			if attempt.do_store {
				w.grid[attempt.store_idx] = attempt.store_value
			}
			if attempt.do_split {
				if w.sparks_next.count < len(w.sparks_next.data) {
					// Child is a next-gen spark, so it must obey occupancy.
					if ok, child := try_spawn_child_adjacent(w, s.x, s.y, attempt.child); ok {
						child_owner_idx := w.sparks_next.count
						_ = spark_buf_append(&w.sparks_next, child)
						cidx := idx_of(w.size, child.x, child.y)
						w.occ_stamp[cidx] = w.occ_gen
						w.occ_owner[cidx] = child_owner_idx
					}
				}
			}
		}

		// If we were blocked, attempt to stay in-place (also subject to takeover rule).
		if blocked {
			s_stay := s0
			s_stay.age = s.age // keep age increment
			s_stay.energy -= PENALTY_BLOCKED
			s_stay.energy -= COST_MOVE

			stay_survives := s_stay.energy > 0 && s_stay.energy < ENERGY_CAP && s_stay.age < SPARK_MAX_AGE_TICKS
			if stay_survives {
				if ok, _, loot := occ_claim_or_takeover(w, current_idx, s_stay); ok {
					// Apply loot even when staying in place
					s_stay.energy += loot
					if s_stay.energy > ENERGY_CAP { s_stay.energy = ENERGY_CAP }
				}
			}

			continue
		}
	}

	// Extinction failsafe (panspermia): inject a new spark into the next generation.
	if w.sparks_next.count == 0 {
		for _ in 0..<SPARK_COUNT_MIN {
			if !spawn_spark_into_unique(w, &w.sparks_next) { break }
		}
	}

	w.tick += 1
	w.sparks, w.sparks_next = w.sparks_next, w.sparks
}

// -----------------
// Rendering helpers
// -----------------

u8_from_f32_01 :: proc(x: f32) -> u8 {
	if x <= 0 { return 0 }
	if x >= 1 { return 255 }
	return u8(int(x*255.0 + 0.5))
}

color_from_cell_value :: proc(v: u8, alpha: f32) -> rl.Color {
	a := u8_from_f32_01(alpha)
	
	if v <= RANGE_VOID_MAX {
		// Void -> Black
		return rl.Color{0, 0, 0, a}
	} else if v <= RANGE_WALL_MAX {
		// Blue shades
		brightness := f32(v-64) / 64.0
		b := u8_from_f32_01(0.4 + brightness*0.6)
		return rl.Color{0, 0, b, a}
	} else if v <= RANGE_SOLAR_MAX {
		// Green/yellow-ish shades
		brightness := f32(v-128) / 64.0
		r := u8_from_f32_01(brightness * 0.8)
		g := u8_from_f32_01(0.4 + brightness*0.6)
		return rl.Color{r, g, 0, a}
	}
	
	// Ops: Each OP code gets a distinct color
	switch v {
	case OP_LOAD:   // 200: Cyan (memory read)
		return rl.Color{0, 255, 255, a}
	case OP_STORE:  // 201: Orange (memory write)
		return rl.Color{255, 140, 0, a}
	case OP_SPLIT:  // 202: Bright Magenta (reproduction)
		return rl.Color{255, 0, 255, a}
	case OP_LEFT:   // 203: Lime Green (turn left)
		return rl.Color{50, 255, 50, a}
	case OP_RIGHT:  // 204: Yellow (turn right)
		return rl.Color{255, 255, 0, a}
	case OP_INC:    // 205: Light Blue (increment)
		return rl.Color{100, 150, 255, a}
	case OP_DEC:    // 206: Light Red (decrement)
		return rl.Color{255, 100, 100, a}
	case OP_BRANCH: // 207: Hot Pink (conditional)
		return rl.Color{255, 20, 147, a}
	case OP_SWAP:   // 208: Violet (atomic exchange/transport)
		return rl.Color{138, 43, 226, a}
	case OP_PICKUP: // 209: Teal (pickup cargo)
		return rl.Color{0, 200, 200, a}
	case OP_DROP:   // 210: Brown/Orange (drop cargo)
		return rl.Color{200, 100, 0, a}
	case:
		// Unknown ops (192-255): Default dim magenta
		return rl.Color{150, 0, 100, a}
	}
}

render_world_pixels :: proc(w: ^Byte_World, pixels: []rl.Color, show_trails: bool) {
	assert(len(pixels) == len(w.grid))

	if show_trails {
		// Render grid with trails (alpha visualization)
		for i in 0..<len(w.grid) {
			pixels[i] = color_from_cell_value(w.grid[i], w.alpha[i])
		}
	} else {
		// No trails, just black background
		for i in 0..<len(pixels) {
			pixels[i] = rl.BLACK
		}
	}

	// Sparks render on top with their lineage color.
	for s in spark_buf_slice(&w.sparks) {
		pixels[idx_of(w.size, s.x, s.y)] = s.color
	}
}

// --------------------------
// Pattern Save/Load System
// --------------------------

// Converts screen pixel coordinates to World Grid coordinates
screen_to_world :: proc(screen_pos: rl.Vector2, world_size: int, ui_top: f32, view_w, view_h: f32, pan: rl.Vector2, zoom: f32) -> (int, int) {
	// Reconstruct the destination rectangle logic from your main loop to invert it.
	base_scale := min_f32(view_w/f32(world_size), view_h/f32(world_size))
	scale := base_scale * zoom
	// Assuming pixel_perfect is usually on or close enough
	if scale >= 1.0 { scale = f32(int(scale)) }

	dst_w := f32(world_size) * scale
	dst_h := f32(world_size) * scale
	
	// The drawing offset
	dst_x := (view_w - dst_w) * 0.5 + pan.x
	dst_y := ui_top + (view_h - dst_h) * 0.5 + pan.y
	if dst_y < ui_top + 2 { dst_y = ui_top + 2 }

	// Inverse transform
	local_x := screen_pos.x - dst_x
	local_y := screen_pos.y - dst_y

	grid_x := int(local_x / scale)
	grid_y := int(local_y / scale)

	return grid_x, grid_y
}

save_pattern :: proc(w: ^Byte_World, x, y, width, height: int, filename: string) {
	if width <= 0 || height <= 0 { return }

	// 1. Collect Sparks in region
	// We scan the active buffer
	rel_sparks := make([dynamic]Relative_Spark)
	defer delete(rel_sparks)

	sparks_slice := spark_buf_slice(&w.sparks)
	for s in sparks_slice {
		// Check bounds
		if s.x >= x && s.x < x + width && s.y >= y && s.y < y + height {
			append(&rel_sparks, Relative_Spark{
				rel_x    = i16(s.x - x),
				rel_y    = i16(s.y - y),
				dx       = i8(s.dx),
				dy       = i8(s.dy),
				register = s.register,
				color_r  = s.color.r,
				color_g  = s.color.g,
				color_b  = s.color.b,
				inventory = s.inventory,
			})
		}
	}

	// 2. Build Buffer
	// Header: W(4), H(4), SparkCount(4) = 12 bytes
	// Grid: W*H bytes
	// Sparks: Count * sizeof(Relative_Spark)
	
	buf: [dynamic]u8
	
	// Write Header
	// (Simple generic write helpers)
	append_int :: proc(b: ^[dynamic]u8, v: int) {
		val := i32(v)
		bytes_view := transmute([4]u8)val
		append(b, bytes_view[0], bytes_view[1], bytes_view[2], bytes_view[3])
	}
	
	append_int(&buf, width)
	append_int(&buf, height)
	append_int(&buf, len(rel_sparks))

	// Write Grid Cells
	for row := 0; row < height; row += 1 {
		for col := 0; col < width; col += 1 {
			// Handle wrapping or clamping? Let's use wrap_i just in case logic is weird,
			// though usually selection is clamped.
			wx := wrap_i(x + col, w.size)
			wy := wrap_i(y + row, w.size)
			val := w.grid[idx_of(w.size, wx, wy)]
			append(&buf, val)
		}
	}

	// Write Sparks
	for s in rel_sparks {
		// We can just cast the struct to bytes for simplicity in this prototype
		data := transmute([size_of(Relative_Spark)]u8)s
		for b in data { append(&buf, b) }
	}

	// 3. Write to Disk
	os.write_entire_file(filename, buf[:])
	fmt.println("Saved pattern to", filename)
}

load_and_paste_pattern :: proc(w: ^Byte_World, dest_x, dest_y: int, filename: string) {
	data, ok := os.read_entire_file(filename)
	if !ok {
		fmt.println("Failed to load", filename)
		return
	}
	defer delete(data)

	if len(data) < 12 { return } // header too small

	offset := 0
	read_int :: proc(d: []u8, off: ^int) -> int {
		if len(d) < off^ + 4 { return 0 }
		val_bytes := [4]u8{d[off^], d[off^+1], d[off^+2], d[off^+3]}
		off^ += 4
		return int(transmute(i32)val_bytes)
	}

	p_w := read_int(data, &offset)
	p_h := read_int(data, &offset)
	s_count := read_int(data, &offset)

	// Paste Grid
	grid_size := p_w * p_h
	if len(data) < offset + grid_size { return }

	for row := 0; row < p_h; row += 1 {
		for col := 0; col < p_w; col += 1 {
			val := data[offset]
			offset += 1
			
			// Paste into world with wrapping
			wx := wrap_i(dest_x + col, w.size)
			wy := wrap_i(dest_y + row, w.size)
			idx := idx_of(w.size, wx, wy)
			
			// Hard overwrite is usually better for blueprints.
			w.grid[idx] = val
			w.alpha[idx] = 1.0 // Highlight pasted area
		}
	}

	// Paste Sparks
	spark_bytes := size_of(Relative_Spark)
	for i := 0; i < s_count; i += 1 {
		if len(data) < offset + spark_bytes { break }
		
		// Copy bytes to a temp array to transmute
		temp_b: [size_of(Relative_Spark)]u8
		for k := 0; k < spark_bytes; k+=1 { temp_b[k] = data[offset+k] }
		offset += spark_bytes
		
		rs := transmute(Relative_Spark)temp_b
		
		// Inject spark
		final_x := wrap_i(dest_x + int(rs.rel_x), w.size)
		final_y := wrap_i(dest_y + int(rs.rel_y), w.size)
		
		new_spark := Spark{
			x = final_x,
			y = final_y,
			dx = int(rs.dx),
			dy = int(rs.dy),
			energy = 100.0, // Give fresh energy
			register = rs.register,
			age = 0,
			solar_writes = 0,
			color = rl.Color{rs.color_r, rs.color_g, rs.color_b, 255},
			inventory = rs.inventory,
		}
		
		// Only add if buffer has space
		spark_buf_append(&w.sparks, new_spark)
	}
	fmt.println("Loaded pattern from", filename)
}

// Load pattern into a Pattern structure (without pasting to world)
load_pattern_from_file :: proc(filename: string) -> (Pattern, bool) {
	data, ok := os.read_entire_file(filename)
	if !ok {
		return Pattern{}, false
	}
	defer delete(data)

	if len(data) < 12 { return Pattern{}, false }

	offset := 0
	read_int :: proc(d: []u8, off: ^int) -> int {
		if len(d) < off^ + 4 { return 0 }
		val_bytes := [4]u8{d[off^], d[off^+1], d[off^+2], d[off^+3]}
		off^ += 4
		return int(transmute(i32)val_bytes)
	}

	p_w := read_int(data, &offset)
	p_h := read_int(data, &offset)
	s_count := read_int(data, &offset)

	// Read Grid
	grid_size := p_w * p_h
	if len(data) < offset + grid_size { return Pattern{}, false }
	
	cells := make([]u8, grid_size)
	for i := 0; i < grid_size; i += 1 {
		cells[i] = data[offset]
		offset += 1
	}

	// Read Sparks
	sparks := make([dynamic]Relative_Spark, 0, s_count)
	spark_bytes := size_of(Relative_Spark)
	for i := 0; i < s_count; i += 1 {
		if len(data) < offset + spark_bytes { break }
		
		temp_b: [size_of(Relative_Spark)]u8
		for k := 0; k < spark_bytes; k+=1 { temp_b[k] = data[offset+k] }
		offset += spark_bytes
		
		rs := transmute(Relative_Spark)temp_b
		append(&sparks, rs)
	}

	return Pattern{
		width = p_w,
		height = p_h,
		cells = cells,
		sparks = sparks,
	}, true
}

// Paste a Pattern structure to the world at given coordinates
paste_pattern_to_world :: proc(w: ^Byte_World, p: ^Pattern, dest_x, dest_y: int) {
	// Paste Grid
	for row := 0; row < p.height; row += 1 {
		for col := 0; col < p.width; col += 1 {
			val := p.cells[row * p.width + col]
			
			wx := wrap_i(dest_x + col, w.size)
			wy := wrap_i(dest_y + row, w.size)
			idx := idx_of(w.size, wx, wy)
			
			w.grid[idx] = val
			w.alpha[idx] = 1.0
		}
	}

	// Paste Sparks
	for rs in p.sparks {
		final_x := wrap_i(dest_x + int(rs.rel_x), w.size)
		final_y := wrap_i(dest_y + int(rs.rel_y), w.size)
		
		new_spark := Spark{
			x = final_x,
			y = final_y,
			dx = int(rs.dx),
			dy = int(rs.dy),
			energy = 100.0,
			register = rs.register,
			age = 0,
			solar_writes = 0,
			color = rl.Color{rs.color_r, rs.color_g, rs.color_b, 255},
			inventory = rs.inventory,
		}
		
		spark_buf_append(&w.sparks, new_spark)
	}
}

// Initialize world by tiling auto-patterns across the grid
init_world_from_auto_patterns :: proc(w: ^Byte_World) {
	// Clear the world first
	w.tick = 0
	spark_buf_clear(&w.sparks)
	spark_buf_clear(&w.sparks_next)
	
	for i in 0..<len(w.occ_stamp) {
		w.occ_stamp[i] = 0
	}
	w.occ_gen = 1
	
	for i in 0..<len(w.alpha) {
		w.alpha[i] = 0.05
	}
	
	for i in 0..<len(w.grid) {
		w.grid[i] = 0 // Fill with void
	}

	// Load all available auto_pattern files
	patterns := make([dynamic]Pattern)
	defer {
		for &p in patterns {
			free_pattern(&p)
		}
		delete(patterns)
	}

	// Try to load auto_pattern_0.dat through auto_pattern_99.dat
	for i := 0; i < 100; i += 1 {
		filename := fmt.tprintf("auto_pattern_%d.dat", i)
		if pattern, ok := load_pattern_from_file(filename); ok {
			append(&patterns, pattern)
			fmt.println("Loaded", filename, "for tiling")
		}
	}

	if len(patterns) == 0 {
		fmt.println("No auto-patterns found. Using normal random seeding.")
		byte_world_reseed(w, w.rng)
		return
	}

	fmt.println("Tiling", len(patterns), "patterns across the grid...")

	// Shuffle the patterns array for variety
	for i := len(patterns)-1; i > 0; i -= 1 {
		j := rng_int_inclusive(&w.rng, 0, i)
		patterns[i], patterns[j] = patterns[j], patterns[i]
	}

	// Tile patterns across the grid
	x_offset := 0
	y_offset := 0
	max_height_in_row := 0
	pattern_idx := 0

	for y_offset < w.size {
		x_offset = 0
		max_height_in_row = 0

		for x_offset < w.size {
			if len(patterns) == 0 { break }
			
			// Pick next pattern (cycle through them)
			p := &patterns[pattern_idx % len(patterns)]
			pattern_idx += 1

			// Paste pattern at current offset
			paste_pattern_to_world(w, p, x_offset, y_offset)

			// Advance horizontally
			x_offset += p.width
			if p.height > max_height_in_row {
				max_height_in_row = p.height
			}
		}

		// Advance vertically
		y_offset += max_height_in_row
	}

	fmt.println("Grid initialized with tiled patterns!")
}

// -----
// Main
// -----

main :: proc() {
	rl.SetConfigFlags(rl.ConfigFlags{.WINDOW_RESIZABLE, .VSYNC_HINT})
	rl.InitWindow(WINDOW_W, WINDOW_H, "Byte-Physics World (Odin)")
	defer rl.CloseWindow()
	rl.SetTargetFPS(60)

	seed := seed_from_system_time()
	world := byte_world_make(GRID_SIZE, seed)

	// GPU texture
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
	show_trails := true

	// Selection State
	selecting := false
	sel_start_x, sel_start_y: int
	sel_curr_x, sel_curr_y: int

	// File logic
	last_save_file := "pattern_01.dat"
	auto_pattern_mode := false
	auto_pattern_index := 0

	// Auto-Detection State
	show_debug_blobs := false
	auto_scan_timer: f32 = 0.0

	for !rl.WindowShouldClose() {
		// Controls
		if rl.IsKeyPressed(.SPACE) { paused = !paused }
		if rl.IsKeyPressed(.C) { show_trails = !show_trails }
		if rl.IsKeyPressed(.R) {
			seed = seed_from_system_time()
			byte_world_reseed(&world, seed)
		}
		if rl.IsKeyPressed(.T) {
			// Tile mode: Initialize grid from auto-patterns
			init_world_from_auto_patterns(&world)
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
			// Inject 5000 random sparks
			for _ in 0..<5000 {
				if !spawn_spark_into(&world, &world.sparks) { break }
			}
		}

		// 'D' to toggle debug visualization of detected patterns
		if rl.IsKeyPressed(.D) {
			show_debug_blobs = !show_debug_blobs
			// Force a scan immediately
			detect_active_regions(&world)
			fmt.println("Pattern detection", show_debug_blobs ? "enabled" : "disabled")
		}

		// 'S' (Snapshot): Save ALL currently detected blobs to files
		if rl.IsKeyPressed(.S) && show_debug_blobs {
			fmt.println("Snapshotting", len(detected_blobs), "patterns...")
			for blob, i in detected_blobs {
				fname := fmt.tprintf("auto_pattern_%d.dat", i)
				// Convert rect floats back to ints
				bx := int(blob.rect.x)
				by := int(blob.rect.y)
				bw := int(blob.rect.width)
				bh := int(blob.rect.height)
				save_pattern(&world, bx, by, bw, bh, fname)
			}
		}

		// 'A' to toggle auto-pattern mode
		if rl.IsKeyPressed(.A) {
			auto_pattern_mode = !auto_pattern_mode
			fmt.println(auto_pattern_mode ? "Auto-pattern mode enabled" : "Manual pattern mode enabled")
		}

		// '[' and ']' to navigate through auto-patterns
		if auto_pattern_mode {
			if rl.IsKeyPressed(.LEFT_BRACKET) {
				auto_pattern_index -= 1
				if auto_pattern_index < 0 { auto_pattern_index = 0 }
			}
			if rl.IsKeyPressed(.RIGHT_BRACKET) {
				auto_pattern_index += 1
				if auto_pattern_index > 999 { auto_pattern_index = 999 }
			}
		}

		// Number keys: Switch pattern slot (only in manual mode)
		if !auto_pattern_mode {
			if rl.IsKeyPressed(.ONE)   { last_save_file = "pattern_01.dat" }
			if rl.IsKeyPressed(.TWO)   { last_save_file = "pattern_02.dat" }
			if rl.IsKeyPressed(.THREE) { last_save_file = "pattern_03.dat" }
			if rl.IsKeyPressed(.FOUR)  { last_save_file = "pattern_04.dat" }
			if rl.IsKeyPressed(.FIVE)  { last_save_file = "pattern_05.dat" }
			if rl.IsKeyPressed(.SIX)   { last_save_file = "pattern_06.dat" }
			if rl.IsKeyPressed(.SEVEN) { last_save_file = "pattern_07.dat" }
			if rl.IsKeyPressed(.EIGHT) { last_save_file = "pattern_08.dat" }
			if rl.IsKeyPressed(.NINE)  { last_save_file = "pattern_09.dat" }
		}

		// Pan with arrows (screen space)
		dt := rl.GetFrameTime()
		pan_speed := 600.0 * dt
		if rl.IsKeyDown(.LEFT)  { pan.x -= pan_speed }
		if rl.IsKeyDown(.RIGHT) { pan.x += pan_speed }
		if rl.IsKeyDown(.UP)    { pan.y -= pan_speed }
		if rl.IsKeyDown(.DOWN)  { pan.y += pan_speed }

		// Ctrl+Wheel zoom
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

		// Update solar bonus based on spark population (self-regulating)
		// When spark count is low, solar bonus is high (helps recovery)
		// When spark count approaches cap, solar bonus approaches zero (limits growth)
		spark_ratio := f32(world.sparks.count) / f32(SPARK_CAP)
		// Inverse relationship: fewer sparks = more solar energy
		solar_bonus_max = solar_bonus_max_setting * (1.0 - spark_ratio)

		// Auto-update detection every 1 second if visible
		if show_debug_blobs {
			auto_scan_timer += dt
			if auto_scan_timer > 1.0 {
				auto_scan_timer = 0
				detect_active_regions(&world)
			}
		}

		// Simulate
		if !paused {
			for _ in 0..<steps_per_frame {
				byte_world_step(&world)
			}
		}

		// Upload pixels
		render_world_pixels(&world, pixels, show_trails)
		rl.UpdateTexture(texture, raw_data(pixels))

		// Layout
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

		// Draw
		rl.BeginDrawing()
		rl.ClearBackground(rl.BLACK)

		rl.DrawRectangle(0, 0, sw, ui_top, rl.Color{0, 0, 0, 180})
		hud_x: i32 = 10
		hud_y: i32 = 8
		rl.DrawText("Byte-Physics World", hud_x, hud_y, title_font_size, rl.RAYWHITE)
		hud_y += title_font_size + pad_y
		rl.DrawText("SPACE: pause   N: step   R: reseed   T: tile-patterns   I: inject 5k   +/-: steps/frame   Ctrl+Wheel: zoom   Arrows: pan   P: pixel-perfect   C: trails   F: reset view", hud_x, hud_y, body_font_size, rl.RAYWHITE)
		hud_y += body_font_size + 2
		rl.DrawText("RIGHT-DRAG: save   MIDDLE/L: paste   1-9: manual slots   A: toggle auto-mode   [/]: browse auto   D: detect   S: snapshot", hud_x, hud_y, body_font_size, rl.RAYWHITE)
		hud_y += body_font_size + 2
		
		// Draw OP code legend with actual colors
		legend_x := hud_x
		rl.DrawText("Ops: ", legend_x, hud_y, body_font_size, rl.RAYWHITE)
		legend_x += 45
		rl.DrawText("LOAD", legend_x, hud_y, body_font_size, rl.Color{0, 255, 255, 255}) // Cyan
		legend_x += 60
		rl.DrawText("STORE", legend_x, hud_y, body_font_size, rl.Color{255, 140, 0, 255}) // Orange
		legend_x += 75
		rl.DrawText("SPLIT", legend_x, hud_y, body_font_size, rl.Color{255, 0, 255, 255}) // Magenta
		legend_x += 65
		rl.DrawText("LEFT", legend_x, hud_y, body_font_size, rl.Color{50, 255, 50, 255}) // Lime
		legend_x += 60
		rl.DrawText("RIGHT", legend_x, hud_y, body_font_size, rl.Color{255, 255, 0, 255}) // Yellow
		legend_x += 70
		rl.DrawText("INC", legend_x, hud_y, body_font_size, rl.Color{100, 150, 255, 255}) // Light Blue
		legend_x += 50
		rl.DrawText("DEC", legend_x, hud_y, body_font_size, rl.Color{255, 100, 100, 255}) // Light Red
		legend_x += 50
		rl.DrawText("BRANCH", legend_x, hud_y, body_font_size, rl.Color{255, 20, 147, 255}) // Hot Pink
		legend_x += 80
		rl.DrawText("SWAP", legend_x, hud_y, body_font_size, rl.Color{138, 43, 226, 255}) // Violet
		legend_x += 60
		rl.DrawText("PICKUP", legend_x, hud_y, body_font_size, rl.Color{0, 200, 200, 255}) // Teal
		legend_x += 80
		rl.DrawText("DROP", legend_x, hud_y, body_font_size, rl.Color{200, 100, 0, 255}) // Brown/Orange
		hud_y += body_font_size + 2
		
		// Display current pattern info based on mode
		pattern_display := last_save_file
		if auto_pattern_mode {
			pattern_display = fmt.tprintf("auto_pattern_%d.dat [%c/%c]", auto_pattern_index, '[', ']')
		}
		mode_indicator := auto_pattern_mode ? "AUTO" : "MANUAL"
		rl.DrawText(rl.TextFormat("tick=%d   sparks=%d/%d   steps/frame=%d   zoom=%.2f   trails=%s   [%s: %s]", world.tick, world.sparks.count, int(SPARK_CAP), steps_per_frame, zoom, show_trails ? "ON" : "OFF", cstring(raw_data(mode_indicator)), cstring(raw_data(pattern_display))), hud_x, hud_y, body_font_size, rl.RAYWHITE)

		// Slider helper procedure
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
		
		// Solar Bonus Max slider
		mouse_pos := rl.GetMousePosition()
		slider_x: i32 = sw - 400
		slider_y: i32 = 10
		slider_width: i32 = 200
		slider_height: i32 = 20
		
		// Solar bonus slider with special display
		slider_rect := rl.Rectangle{f32(slider_x), f32(slider_y), f32(slider_width), f32(slider_height)}
		rl.DrawRectangleRec(slider_rect, rl.Color{50, 50, 50, 255})
		slider_min: f32 = 0.0
		slider_max: f32 = 50.0
		slider_fill_width := (solar_bonus_max_setting - slider_min) / (slider_max - slider_min) * f32(slider_width)
		slider_fill_rect := rl.Rectangle{f32(slider_x), f32(slider_y), slider_fill_width, f32(slider_height)}
		rl.DrawRectangleRec(slider_fill_rect, rl.Color{100, 200, 100, 255})
		handle_x := f32(slider_x) + slider_fill_width
		handle_rect := rl.Rectangle{handle_x - 5, f32(slider_y) - 2, 10, f32(slider_height) + 4}
		rl.DrawRectangleRec(handle_rect, rl.RAYWHITE)
		rl.DrawText(rl.TextFormat("Solar Max: %.1f (actual: %.1f)", solar_bonus_max_setting, solar_bonus_max), slider_x, slider_y + slider_height + 5, 14, rl.RAYWHITE)
		if rl.IsMouseButtonDown(.LEFT) {
			if rl.CheckCollisionPointRec(mouse_pos, slider_rect) {
				local_x := mouse_pos.x - f32(slider_x)
				if local_x < 0 { local_x = 0 }
				if local_x > f32(slider_width) { local_x = f32(slider_width) }
				t := local_x / f32(slider_width)
				solar_bonus_max_setting = slider_min + t * (slider_max - slider_min)
			}
		}
		
		// Pattern Detection Sliders (only show when detection is active)
		if show_debug_blobs {
			slider_y += 45
			rl.DrawText("--- Pattern Detection ---", slider_x, slider_y - 5, 14, rl.YELLOW)
			slider_y += 20
			draw_slider_f32(slider_x, slider_y, slider_width, slider_height, &detect_alpha_threshold, 0.01, 0.5, "Alpha Threshold", mouse_pos)
			slider_y += 40
			draw_slider_int(slider_x, slider_y, slider_width, slider_height, &min_blob_size, 1, 20, "Min Size", mouse_pos)
			slider_y += 40
			draw_slider_int(slider_x, slider_y, slider_width, slider_height, &max_blob_size, 50, 1000, "Max Size", mouse_pos)
			slider_y += 40
			draw_slider_int(slider_x, slider_y, slider_width, slider_height, &min_pixel_count, 10, 500, "Min Pixels", mouse_pos)
		}

		origin := rl.Vector2{0, 0}
		rl.DrawTexturePro(texture, src, dst, origin, 0, rl.WHITE)

		// --- Draw Detected Blobs ---
		if show_debug_blobs {
			for blob in detected_blobs {
				// Convert Grid Rect to Screen Rect using view transform
				rx := dst.x + blob.rect.x * scale
				ry := dst.y + blob.rect.y * scale
				rw := blob.rect.width * scale
				rh := blob.rect.height * scale
				
				// Draw bounding box
				rl.DrawRectangleLinesEx(rl.Rectangle{rx, ry, rw, rh}, 2, rl.YELLOW)
				
				// Draw score
				score_text := rl.TextFormat("%.2f", blob.score)
				rl.DrawText(score_text, i32(rx), i32(ry)-12, 10, rl.YELLOW)
			}
			
			// Draw detection info
			detection_text := rl.TextFormat("Detected: %d patterns", len(detected_blobs))
			rl.DrawText(detection_text, 10, sh - 30, 20, rl.YELLOW)
		}

		// --- Grid Interaction Logic (Pattern Selection) ---
		// Get World Coordinates
		gx, gy := screen_to_world(mouse_pos, world.size, f32(ui_top), f32(view_w), f32(view_h), pan, zoom)

		// Right Mouse: Select Region
		if rl.IsMouseButtonPressed(.RIGHT) {
			selecting = true
			sel_start_x = gx
			sel_start_y = gy
		}

		if selecting {
			sel_curr_x = gx
			sel_curr_y = gy
			
			if rl.IsMouseButtonReleased(.RIGHT) {
				selecting = false
				// Normalize rectangle
				rx := min(sel_start_x, sel_curr_x)
				ry := min(sel_start_y, sel_curr_y)
				rw := abs_int(sel_curr_x - sel_start_x) + 1
				rh := abs_int(sel_curr_y - sel_start_y) + 1
				
				// Save automatically on release
				save_pattern(&world, rx, ry, rw, rh, last_save_file)
			}
		}

		// Middle Mouse (or 'L' key): Load/Paste Pattern
		if rl.IsMouseButtonPressed(.MIDDLE) || (rl.IsKeyPressed(.L) && !paused) {
			// Determine which file to load based on mode
			file_to_load := last_save_file
			if auto_pattern_mode {
				file_to_load = fmt.tprintf("auto_pattern_%d.dat", auto_pattern_index)
			}
			load_and_paste_pattern(&world, gx, gy, file_to_load)
		}

		// Visual Feedback: Draw Selection Rectangle
		if selecting {
			min_gx := min(sel_start_x, sel_curr_x)
			min_gy := min(sel_start_y, sel_curr_y)
			w_gx   := abs_int(sel_curr_x - sel_start_x) + 1
			h_gy   := abs_int(sel_curr_y - sel_start_y) + 1

			rect_x := dst.x + f32(min_gx) * scale
			rect_y := dst.y + f32(min_gy) * scale
			rect_w := f32(w_gx) * scale
			rect_h := f32(h_gy) * scale
			
			rl.DrawRectangleLinesEx(rl.Rectangle{rect_x, rect_y, rect_w, rect_h}, 2, rl.GREEN)
		}

		rl.DrawFPS(10, ui_top + 10)

		rl.EndDrawing()
	}
}


