package chromatose

Cell_Type :: enum u8 {
	ETHER  = 0,
	SOURCE = 1,
	CELL   = 2,
}

Op_Code :: enum u8 {
	IDLE  = 0,
	GROW  = 2,
	WRITE = 3,
}

Vec2i :: struct {
	x, y: int,
}

// 0: N, 1: NE, 2: E, 3: SE, 4: S, 5: SW, 6: W, 7: NW
DIR_OFFSETS :: [8]Vec2i{
	{ 0, -1}, // 0: N
	{ 1, -1}, // 1: NE
	{ 1,  0}, // 2: E
	{ 1,  1}, // 3: SE
	{ 0,  1}, // 4: S
	{-1,  1}, // 5: SW
	{-1,  0}, // 6: W
	{-1, -1}, // 7: NW
}

World :: struct {
	width, height: int,
	tick: u64,

	types: []Cell_Type,
	vals:  []f32,
	ops:   []Op_Code,
	genes: []u8,
	dir_moves:  []u8,
	dir_reads:  []u8,
	dir_writes: []u8,

	next_types: []Cell_Type,
	next_vals:  []f32,
	next_ops:   []Op_Code,
	next_genes: []u8,
	next_dir_moves:  []u8,
	next_dir_reads:  []u8,
	next_dir_writes: []u8,
}

idx_of :: proc(w: ^World, x, y: int) -> int {
	return y*w.width + x
}

in_bounds :: proc(w: ^World, x, y: int) -> bool {
	return x >= 0 && x < w.width && y >= 0 && y < w.height
}

world_make :: proc(width, height: int) -> World {
	assert(width > 0 && height > 0)
	n := width * height

	w := World{
		width  = width,
		height = height,
		tick   = 0,

		types      = make([]Cell_Type, n),
		vals       = make([]f32, n),
		ops        = make([]Op_Code, n),
		genes      = make([]u8, n),
		dir_moves  = make([]u8, n),
		dir_reads  = make([]u8, n),
		dir_writes = make([]u8, n),

		next_types = make([]Cell_Type, n),
		next_vals  = make([]f32, n),
		next_ops   = make([]Op_Code, n),
		next_genes      = make([]u8, n),
		next_dir_moves  = make([]u8, n),
		next_dir_reads  = make([]u8, n),
		next_dir_writes = make([]u8, n),
	}

	for i in 0..<n {
		w.types[i] = .ETHER
		w.vals[i] = 0.0
		w.ops[i] = .IDLE
		w.genes[i] = 0
		w.dir_moves[i]  = 0
		w.dir_reads[i]  = 0
		w.dir_writes[i] = 0
	}
	return w
}

world_clear :: proc(w: ^World) {
	n := w.width * w.height
	w.tick = 0
	for i in 0..<n {
		w.types[i] = .ETHER
		w.vals[i] = 0.0
		w.ops[i] = .IDLE
		w.genes[i] = 0
		w.dir_moves[i]  = 0
		w.dir_reads[i]  = 0
		w.dir_writes[i] = 0
	}
}

world_set_cell :: proc(w: ^World, x, y: int, t: Cell_Type, op: Op_Code, dir_move, dir_read, dir_write: u8, gene: u8) {
	if !in_bounds(w, x, y) {
		return
	}
	i := idx_of(w, x, y)
	w.types[i] = t
	if t == .SOURCE {
		w.vals[i] = ENERGY_MAX
		w.ops[i] = .IDLE
		w.genes[i] = 0
		w.dir_moves[i]  = 0
		w.dir_reads[i]  = 0
		w.dir_writes[i] = 0
	} else if t == .CELL {
		// Reset energy on paint so edits are visually obvious and behavior is deterministic.
		// (Caller can always write `w.vals[i]` directly after painting if desired.)
		w.vals[i] = 0.0
		w.ops[i] = op
		w.dir_moves[i]  = dir_move
		w.dir_reads[i]  = dir_read
		w.dir_writes[i] = dir_write

		w.genes[i] = gene
		if op == .WRITE && w.genes[i] == 0 {
			w.genes[i] = DEFAULT_WRITE_GENE
		}
		if op != .WRITE {
			w.genes[i] = 0
		}
	} else {
		// Ether value is left as-is (useful when erasing a source back to Ether without nuking gradient)
		w.ops[i] = .IDLE
		w.genes[i] = 0
		w.dir_moves[i]  = 0
		w.dir_reads[i]  = 0
		w.dir_writes[i] = 0
	}
}

// Boundary behavior: clamp coordinates (no-flux / Neumann-ish), so edges don't artificially darken.
clamp_coords :: proc(w: ^World, x, y: int) -> (int, int) {
	xx := x
	yy := y
	if xx < 0 { xx = 0 }
	if yy < 0 { yy = 0 }
	if xx >= w.width  { xx = w.width-1 }
	if yy >= w.height { yy = w.height-1 }
	return xx, yy
}

idx_clamped :: proc(w: ^World, x, y: int) -> int {
	cx, cy := clamp_coords(w, x, y)
	return idx_of(w, cx, cy)
}

points_to_idx :: proc(w: ^World, from_idx: int, dir: u8, to_idx: int) -> bool {
	ww := w.width
	fx := from_idx % ww
	fy := from_idx / ww
	dir_offsets := DIR_OFFSETS
	off := dir_offsets[int(dir)]
	ti := idx_clamped(w, fx + off.x, fy + off.y)
	return ti == to_idx
}

// Seed a randomized soup.
// Note: the caller owns time-seeding; pass in a seed (e.g. from wall clock) for variability.
world_seed :: proc(w: ^World, seed: u32) {
	world_clear(w)

	// Simple xorshift32 RNG.
	rng := seed ~ u32(w.width*73856093) ~ u32(w.height*19349663)
	next_u32 :: proc(state: ^u32) -> u32 {
		x := state^
		x ~= x << 13
		x ~= x >> 17
		x ~= x << 5
		state^ = x
		return x
	}
	rand_u8 :: proc(state: ^u32, max_exclusive: u8) -> u8 {
		if max_exclusive == 0 { return 0 }
		return u8(next_u32(state) % u32(max_exclusive))
	}
	rand_f32_01 :: proc(state: ^u32) -> f32 {
		// 24-bit mantissa fraction
		return f32(next_u32(state) & 0x00FF_FFFF) / f32(0x0100_0000)
	}
	rand_int :: proc(state: ^u32, lo_inclusive, hi_inclusive: int) -> int {
		if hi_inclusive <= lo_inclusive { return lo_inclusive }
		span := u32(hi_inclusive - lo_inclusive + 1)
		return lo_inclusive + int(next_u32(state)%span)
	}

	// Sprinkle solids and walkers (keep sparse so motion is visible).
	p_cell_total: f32 = 0.016
	p_write:      f32 = 0.5
	p_grow:       f32 = 0.5

	for y in 0..<w.height {
		for x in 0..<w.width {
			i := idx_of(w, x, y)
			if w.types[i] != .ETHER {
				continue
			}
			if rand_f32_01(&rng) > p_cell_total {
				continue
			}

			r := rand_f32_01(&rng)
			op: Op_Code = .IDLE
			if r < p_write {
				op = .WRITE
			} else if r < p_write + p_grow {
				op = .GROW
			} else {
				op = .IDLE
			}

			dm := rand_u8(&rng, 8)
			dr := rand_u8(&rng, 8)
			dw := rand_u8(&rng, 8)
			world_set_cell(w, x, y, .CELL, op, dm, dr, dw, 0)

			// Give non-idle actors some initial charge so dynamics start immediately.
			if op == .WRITE || op == .GROW {
				w.vals[i] = 200.0 + rand_f32_01(&rng)*120.0
			} else {
				w.vals[i] = 0.0
			}
		}
	}

	// Place 3 or 4 sources at random locations (still low, but enough to energize the field faster).
	source_count := 3 + int(next_u32(&rng)&1)
	for _ in 0..<source_count {
		for _ in 0..<2048 {
			sx := rand_int(&rng, 0, w.width-1)
			sy := rand_int(&rng, 0, w.height-1)
			i := idx_of(w, sx, sy)
			if w.types[i] == .ETHER {
				world_set_cell(w, sx, sy, .SOURCE, .IDLE, 0, 0, 0, 0)
				break
			}
		}
	}
}


