package chromatose

Cell_Type :: enum u8 {
	ETHER  = 0,
	SOURCE = 1,
	CODE   = 2,
}

Op_Code :: enum u8 {
	IDLE  = 0,
	PORE  = 1,
	GROW  = 2,
	WRITE = 3,
	SWAP  = 4,
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
	genes: []u16,
	dir_moves:  []u8,
	dir_reads:  []u8,
	dir_reads2: []u8,
	dir_writes: []u8,
	idle_ticks: []u32, // Track how long each cell has been IDLE

	next_types: []Cell_Type,
	next_vals:  []f32,
	next_ops:   []Op_Code,
	next_genes: []u16,
	next_dir_moves:  []u8,
	next_dir_reads:  []u8,
	next_dir_reads2: []u8,
	next_dir_writes: []u8,
	next_idle_ticks: []u32,
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
		genes      = make([]u16, n),
		dir_moves  = make([]u8, n),
		dir_reads  = make([]u8, n),
		dir_reads2 = make([]u8, n),
		dir_writes = make([]u8, n),
		idle_ticks = make([]u32, n),

		next_types = make([]Cell_Type, n),
		next_vals  = make([]f32, n),
		next_ops   = make([]Op_Code, n),
		next_genes      = make([]u16, n),
		next_dir_moves  = make([]u8, n),
		next_dir_reads  = make([]u8, n),
		next_dir_reads2 = make([]u8, n),
		next_dir_writes = make([]u8, n),
		next_idle_ticks = make([]u32, n),
	}

	for i in 0..<n {
		w.types[i] = .ETHER
		w.vals[i] = 0.0
		w.ops[i] = .IDLE
		w.genes[i] = 0
		w.dir_moves[i]  = 0
		w.dir_reads[i]  = 0
		w.dir_reads2[i] = 0
		w.dir_writes[i] = 0
		w.idle_ticks[i] = 0
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
		w.dir_reads2[i] = 0
		w.dir_writes[i] = 0
		w.idle_ticks[i] = 0
	}
}

world_set_cell :: proc(w: ^World, x, y: int, t: Cell_Type, op: Op_Code, dir_move, dir_read, dir_write: u8, gene: u16, dir_read2: u8 = 255) {
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
		w.dir_reads2[i] = 0
		w.dir_writes[i] = 0
		w.idle_ticks[i] = 0
	} else if t == .CODE {
		// Reset energy on paint so edits are visually obvious and behavior is deterministic.
		// (Caller can always write `w.vals[i]` directly after painting if desired.)
		w.vals[i] = 0.0
		w.ops[i] = op
		if op == .PORE {
			// PORE op-cells allow energy to pass through (like ETHER) but are "solid" (like CODE).
			// They don't participate in directional logic or gene execution.
			w.genes[i] = 0
			w.dir_moves[i]  = 0
			w.dir_reads[i]  = 0
			w.dir_reads2[i] = 0
			w.dir_writes[i] = 0
			w.idle_ticks[i] = 0
			return
		}

		w.dir_moves[i]  = dir_move
		w.dir_reads[i]  = dir_read
		// For SWAP cells, use provided dir_read2 if given (not 255), else default to opposite direction.
		if dir_read2 != 255 {
			w.dir_reads2[i] = dir_read2
		} else {
			w.dir_reads2[i] = u8((int(dir_read) + 4) % 8)
		}
		w.dir_writes[i] = dir_write

		w.genes[i] = gene
		if op == .WRITE && w.genes[i] == 0 {
			w.genes[i] = DEFAULT_WRITE_GENE
		}
		if op != .WRITE {
			w.genes[i] = 0
		}
		w.idle_ticks[i] = 0
	} else {
		// Ether value is left as-is (useful when erasing a source back to Ether without nuking gradient)
		w.ops[i] = .IDLE
		w.genes[i] = 0
		w.dir_moves[i]  = 0
		w.dir_reads[i]  = 0
		w.dir_reads2[i] = 0
		w.dir_writes[i] = 0
		w.idle_ticks[i] = 0
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
world_seed :: proc(w: ^World, seed: u32, cfg: Sim_Config) {
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
	// p_cell_total: probability a position becomes a CODE cell (leave room for ETHER!)
	// p_write/grow/swap: cumulative probabilities for cell op types
	p_cell_total: f32 = 0.06 // 15% of positions become cells
	p_pore:       f32 = 0.03  // 2% of positions become PORE cells
	p_write:      f32 = 0.3   // 100% of cells are WRITE cells
	p_grow:       f32 = 0.3   // 100% GROW
	p_swap:       f32 = 0.3   // 100% SWAP

	for y in 0..<w.height {
		for x in 0..<w.width {
			i := idx_of(w, x, y)
			if w.types[i] != .ETHER {
				continue
			}
			
			// First check if this position becomes a PORE
			if rand_f32_01(&rng) < p_pore {
				world_set_cell(w, x, y, .CODE, .PORE, 0, 0, 0, 0)
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
			} else if r < p_write + p_grow + p_swap {
				op = .SWAP
			} else {
				op = .IDLE
			}

			dm := rand_u8(&rng, 8)
			dr := rand_u8(&rng, 8)
			dw := rand_u8(&rng, 8)
			
			// Generate random gene for writers (5 actions encoded as 3-bit fields)
			// Gene encoding maps 3-bit values (0-4) to actions: 0->IDLE, 1->GROW, 2->WRITE, 3->SWAP, 4->PORE
			// Each slot is 3 bits, 5 slots = 15 bits total (fits in u16)
			gene: u16 = 0
			if op == .WRITE {
				// Generate random action from valid values [0-4]
				rand_action :: proc(state: ^u32) -> u8 {
					return rand_u8(state, 5) // 0, 1, 2, 3, or 4
				}
				// Generate 5 random actions for the gene (bits 0-2, 3-5, 6-8, 9-11, 12-14)
				act0 := rand_action(&rng)
				act1 := rand_action(&rng)
				act2 := rand_action(&rng)
				act3 := rand_action(&rng)
				act4 := rand_action(&rng)
				gene = u16((u16(act0) << 0) | (u16(act1) << 3) | (u16(act2) << 6) | (u16(act3) << 9) | (u16(act4) << 12))
			}
			
			// For SWAP cells, generate two different random read directions.
			dr2: u8 = 255 // default (will use fallback in world_set_cell)
			if op == .SWAP {
				dr2 = rand_u8(&rng, 8)
				// Ensure dr2 is different from dr
				for dr2 == dr {
					dr2 = rand_u8(&rng, 8)
				}
			}
			
			world_set_cell(w, x, y, .CODE, op, dm, dr, dw, gene, dr2)

			// Give non-idle actors some initial charge so dynamics start immediately.
			if op == .WRITE || op == .GROW || op == .SWAP {
				w.vals[i] = 200.0 + rand_f32_01(&rng)*120.0
			} else {
				w.vals[i] = 0.0
			}
		}
	}

	// Place sources at random locations (configurable count).
	source_count := cfg.initial_source_count
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


