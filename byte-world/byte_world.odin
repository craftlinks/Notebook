package main

import rl "vendor:raylib"

import "core:time"

// --------------------------------------------
// Byte-Physics World (Odin port of byte-world.md)
// --------------------------------------------

GRID_SIZE :: 750

WINDOW_W :: 1024
WINDOW_H :: 1024

// Value ranges (ontology)
RANGE_VOID_MAX  : u8 = 63   // Empty space / Passive data
RANGE_WALL_MAX  : u8 = 127  // Reflective matter (even=H-reflect, odd=V-reflect)
RANGE_SOLAR_MAX : u8 = 191  // Energy sources (metabolism)
// 192..255 are "active instructions" (ops)

// Metabolic costs
COST_MOVE   : f32 = 0.2   // Entropy: cost to exist/move per tick
COST_WRITE  : f32 = 1.0   // Work: cost to change a grid value
COST_SPLIT  : f32 = 6.0  // Reproduction: cost to create a child
COST_MATH   : f32 = 0.1   // Processing: cost to compute (INC/DEC)
PENALTY_HIT : f32 = 0.5   // Damage: cost when hitting a wall
PENALTY_BLOCKED : f32 = 0.5 // Damage: cost when trying to move into an occupied cell

// Metabolic gains
SOLAR_BASE_GAIN : f32 = 0.0 // Minimum energy from a solar tile
solar_bonus_max_setting : f32 = 20.0 // Max solar bonus (adjustable via slider, when few sparks)
solar_bonus_max : f32 = 20.0 // Actual solar bonus (computed dynamically based on spark count)
SOLAR_DRAIN_PER_HARVEST  : u8 = 2 // When a spark steps onto solar

ENERGY_CAP : f32 = 500.0

// Rendering alpha dynamics
ALPHA_DECAY_PER_TICK : f32 = 0.002  // Small fade per tick for unused cells
ALPHA_GAIN_ON_VISIT  : f32 = 0.090   // Large boost when spark visits (>> decay)

// Op codes
OP_LOAD   : u8 = 200 // Register = Grid[Ahead]
OP_STORE  : u8 = 201 // Grid[Ahead] = Register
OP_SPLIT  : u8 = 202 // Divide energy, spawn orthogonal child
OP_LEFT   : u8 = 203 // Turn 90° counter-clockwise
OP_RIGHT  : u8 = 204 // Turn 90° clockwise
OP_INC    : u8 = 205 // Register++
OP_DEC    : u8 = 206 // Register--
OP_BRANCH : u8 = 207 // If Register < 128 -> LEFT else RIGHT

SPARK_COUNT_MIN : int = 150000

SPARK_MAX_AGE_TICKS : int = 500

// Hard upper bound on total sparks alive at once.
SPARK_CAP :: 150_000

Spark :: struct {
	x, y: int,
	dx, dy: int,      // -1, 0, 1
	energy: f32,
	register: u8,     // 8-bit payload (0..255)
	age: int,
	color: rl.Color,  // Lineage color (inherited from parent)
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
	occ_gen: u32,

	rng: u32,
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
	}
	w.occ_gen = 1

	// Initialize alpha values to low opacity
	for i in 0..<len(w.alpha) {
		w.alpha[i] = 0.05
	}

	// Base noise (void/data)
	for i in 0..<len(w.grid) {
		r := rng_u32_bounded(&w.rng, 100)
		if r < 10 {
			// Void (0..63) - 40% of universe
			w.grid[i] = u8(rng_u32_bounded(&w.rng, u32(RANGE_VOID_MAX) + 1))
		} else if r < 11 {
			// Wall (64..127) - 5% of universe
			w.grid[i] = u8(rng_int_inclusive(&w.rng, int(RANGE_VOID_MAX) + 1, int(RANGE_WALL_MAX)))
		} else if r < 12 {
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
		color = color,
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
			color = color,
		}
		if s.dx == 0 && s.dy == 0 {
			s.dx = 1
		}

		if spark_buf_append(sparks, s) {
			w.occ_stamp[i] = w.occ_gen
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
		// Wall/mirror: bounce in place, reflect direction, pay hit penalty.
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
		if res.s.energy > COST_WRITE {
			res.do_store = true
			res.store_idx = ahead_idx
			res.store_value = res.s.register
			res.s.energy -= COST_WRITE
		}

	case OP_SPLIT:
		if res.s.energy > COST_SPLIT {
			half_energy := res.s.energy * 0.5
			half_age := res.s.age / 2
			child := Spark{
				x = nx,
				y = ny,
				dx = -res.s.dy,
				dy = res.s.dx,
				energy = half_energy,
				register = res.s.register,
				age = half_age,
				color = res.s.color,
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
	if is_permeable_for_spawn(w.grid[tidx]) && occ_try_claim(w, tidx) {
		child.x, child.y = tx, ty
		return true, child
	}

	child.dx, child.dy = -child.dx, -child.dy
	tx2 := wrap_i(parent_x + child.dx, w.size)
	ty2 := wrap_i(parent_y + child.dy, w.size)
	tidx2 := idx_of(w.size, tx2, ty2)
	if is_permeable_for_spawn(w.grid[tidx2]) && occ_try_claim(w, tidx2) {
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
		// Rule: if the intended destination is already occupied for the next generation,
		// the move is a no-op (stay put) and we apply a penalty.
		claimed := false
		blocked := false

		attempt := attempt_with_dir(w, s, s.dx, s.dy)
		s_attempt := attempt.s
		s_attempt.x, s_attempt.y = attempt.dest_x, attempt.dest_y

		// Would the parent survive if it took this attempt?
		energy_tmp := s_attempt.energy - COST_MOVE
		survives := energy_tmp > 0 && energy_tmp < ENERGY_CAP && s_attempt.age < SPARK_MAX_AGE_TICKS

		if survives {
			if occ_try_claim(w, attempt.dest_idx) {
				claimed = true
				s = s_attempt

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
							_ = spark_buf_append(&w.sparks_next, child)
						}
					}
				}
			} else {
				// Blocked by occupancy: no-op (no movement, no op/solar execution).
				if occ_try_claim(w, current_idx) {
					claimed = true
					blocked = true
					// Keep s as-is (same position/direction/register); we already incremented age above.
				} else {
					// Can't even stay (someone else claimed this cell) -> removed.
					continue
				}
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
						_ = spark_buf_append(&w.sparks_next, child)
					}
				}
			}
		}

		// Entropy + cap
		if blocked {
			s.energy -= PENALTY_BLOCKED
		}
		s.energy -= COST_MOVE
		// If a spark ever reaches the energy cap, it "burns out" and is removed.
		// This makes ENERGY_CAP a death threshold instead of a clamp.
		if s.energy >= ENERGY_CAP {
			continue
		}

		// Survival
		if claimed && s.energy > 0 && s.age < SPARK_MAX_AGE_TICKS {
			_ = spark_buf_append(&w.sparks_next, s)
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
	case:
		// Unknown ops (192-255): Default dim magenta
		return rl.Color{150, 0, 100, a}
	}
}

render_world_pixels :: proc(w: ^Byte_World, pixels: []rl.Color) {
	assert(len(pixels) == len(w.grid))

	for i in 0..<len(w.grid) {
		pixels[i] = color_from_cell_value(w.grid[i], w.alpha[i])
	}

	// Sparks render on top with their lineage color.
	for s in spark_buf_slice(&w.sparks) {
		pixels[idx_of(w.size, s.x, s.y)] = s.color
	}
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
			// Inject 5000 random sparks
			for _ in 0..<5000 {
				if !spawn_spark_into(&world, &world.sparks) { break }
			}
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

		// Simulate
		if !paused {
			for _ in 0..<steps_per_frame {
				byte_world_step(&world)
			}
		}

		// Upload pixels
		render_world_pixels(&world, pixels)
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
		rl.DrawText("SPACE: pause   N: step (paused)   R: reseed   I: inject 5k sparks   +/-: steps/frame   Ctrl+Wheel: zoom   Arrows: pan   P: pixel-perfect   F: reset view", hud_x, hud_y, body_font_size, rl.RAYWHITE)
		hud_y += body_font_size + 2
		rl.DrawText("Ranges: 0-63(Void/Black), 64-127(Wall/Blue), 128-191(Solar/Green-Yellow), 192+(Ops/Colored)", hud_x, hud_y, body_font_size, rl.RAYWHITE)
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
		hud_y += body_font_size + 2
		
		rl.DrawText(rl.TextFormat("tick=%d   sparks=%d/%d   steps/frame=%d   zoom=%.2f", world.tick, world.sparks.count, int(SPARK_CAP), steps_per_frame, zoom), hud_x, hud_y, body_font_size, rl.RAYWHITE)

		// Solar Bonus Max slider
		slider_x: i32 = sw - 400
		slider_y: i32 = 10
		slider_width: i32 = 200
		slider_height: i32 = 20
		slider_min: f32 = 0.0
		slider_max: f32 = 50.0
		
		// Draw slider background
		slider_rect := rl.Rectangle{f32(slider_x), f32(slider_y), f32(slider_width), f32(slider_height)}
		rl.DrawRectangleRec(slider_rect, rl.Color{50, 50, 50, 255})
		
		// Draw slider fill
		slider_fill_width := (solar_bonus_max_setting - slider_min) / (slider_max - slider_min) * f32(slider_width)
		slider_fill_rect := rl.Rectangle{f32(slider_x), f32(slider_y), slider_fill_width, f32(slider_height)}
		rl.DrawRectangleRec(slider_fill_rect, rl.Color{100, 200, 100, 255})
		
		// Draw slider handle
		handle_x := f32(slider_x) + slider_fill_width
		handle_rect := rl.Rectangle{handle_x - 5, f32(slider_y) - 2, 10, f32(slider_height) + 4}
		rl.DrawRectangleRec(handle_rect, rl.RAYWHITE)
		
		// Draw slider label with both max setting and actual value
		rl.DrawText(rl.TextFormat("Solar Max: %.1f (actual: %.1f)", solar_bonus_max_setting, solar_bonus_max), slider_x, slider_y + slider_height + 5, 16, rl.RAYWHITE)
		
		// Handle slider interaction
		mouse_pos := rl.GetMousePosition()
		if rl.IsMouseButtonDown(.LEFT) {
			if rl.CheckCollisionPointRec(mouse_pos, slider_rect) {
				// Update solar_bonus_max_setting based on mouse position
				local_x := mouse_pos.x - f32(slider_x)
				if local_x < 0 { local_x = 0 }
				if local_x > f32(slider_width) { local_x = f32(slider_width) }
				
				t := local_x / f32(slider_width)
				solar_bonus_max_setting = slider_min + t * (slider_max - slider_min)
			}
		}

		origin := rl.Vector2{0, 0}
		rl.DrawTexturePro(texture, src, dst, origin, 0, rl.WHITE)
		rl.DrawFPS(10, ui_top + 10)

		rl.EndDrawing()
	}
}


