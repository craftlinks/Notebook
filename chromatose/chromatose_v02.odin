package chromatose

import rl "vendor:raylib"

WINDOW_W :: 1024
WINDOW_H :: 1024

SIM_W :: 256
SIM_H :: 256

// Directional growth tuning
GROW_STEP_COST   :: 100.0
GROW_CHARGE_RATE :: 0.1 // per-tick gain factor from neighborhood energy

Cell_Type :: enum u8 {
	ETHER  = 0,
	SOURCE = 1,
	CELL = 2,
}

Op_Code :: enum u8 {
	IDLE    = 0,
	GROW    = 2,
	WRITE   = 3,
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
		w.vals[i] = 512.0
		w.ops[i] = .IDLE
		w.genes[i] = 0
		w.dir_moves[i]  = 0
		w.dir_reads[i]  = 0
		w.dir_writes[i] = 0
	} else if t == .CELL {
		// VAL persists unless caller wants to reset it.
		// Keep as-is to avoid nuking accumulated energy when repainting OP.
		w.vals[i] = 0.0
		w.ops[i] = op
		w.dir_moves[i]  = dir_move
		w.dir_reads[i]  = dir_read
		w.dir_writes[i] = dir_write

		w.genes[i] = gene
		// Default gene for WRITE (2 bits per observed OP):
		// - read IDLE   -> write GROW
		// - read GROW   -> write WRITE
		// - read WRITE  -> write GROW
		if op == .WRITE && w.genes[i] == 0 {
			// Bit slots are indexed by Op_Code numeric value (0..3).
			// Note: Op_Code=1 is unused (HARVEST removed).
			w.genes[i] = u8((2 << 0) | (3 << 4) | (2 << 6))
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

world_seed :: proc(w: ^World) {
	world_clear(w)

	// Randomized soup seed (keeps SOURCE count low: 1 or 2).
	//
	// Notes:
	// - `world_clear` sets everything to ETHER/0; we add a light random ether-energy field.
	// - We sprinkle a sparse set of CELLs with varied OPs and random head directions.
	// - WRITE cells use the default gene unless you explicitly set one.

	// Simple xorshift32 RNG seeded from time and world size (deterministic-ish per run, but varies across presses).
	rng: u32 = u32(rl.GetTime()*1000.0) ~ u32(w.width*73856093) ~ u32(w.height*19349663)
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

	// Ether starts at 0.0 everywhere (world_clear already did this).

	// Sprinkle solids and walkers (keep sparse so motion is visible).
	// Tune these rates as desired.
	p_cell_total: f32 = 0.016  // 0.8% of tiles become CELLs
	p_write:      f32 = 0.5  // of CELLs, 20% are WRITE
	p_grow:       f32 = 0.5  // of CELLs, 4% are GROW (keep heads rare)

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
				// IDLE walls keep low charge (cosmetic).
				w.vals[i] = 0.0
			}
		}
	}

	// Place 3 or 4 sources at random locations (still low, but enough to energize the field faster).
	// (This is the previous 1–2 plus 2 more.)
	source_count := 3 + int(next_u32(&rng)&1)
	for s in 0..<source_count {
		for tries in 0..<2048 {
			sx := rand_int(&rng, 0, w.width-1)
			sy := rand_int(&rng, 0, w.height-1)
			i := idx_of(w, sx, sy)
			// Prefer overwriting only ether; avoid destroying seeded structures.
			if w.types[i] == .ETHER {
				world_set_cell(w, sx, sy, .SOURCE, .IDLE, 0, 0, 0, 0)
				break
			}
		}
	}
}

clamp_i32 :: proc(x, lo, hi: i32) -> i32 {
	if x < lo { return lo }
	if x > hi { return hi }
	return x
}

clamp_f32 :: proc(x, lo, hi: f32) -> f32 {
	if x < lo { return lo }
	if x > hi { return hi }
	return x
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

// Neighbor sampling for ETHER updates:
// - SOURCE -> include 512
// - ETHER  -> include neighbor val
// - CELL (OP==IDLE)    -> ignore (wall)
sample_for_ether :: proc(w: ^World, x, y: int) -> (include: bool, v: f32) {
	xx, yy := clamp_coords(w, x, y)
	i := idx_of(w, xx, yy)
	switch w.types[i] {
	case .SOURCE:
		return true, 512.0
	case .ETHER:
		return true, w.vals[i]
	case .CELL:
		return false, 0.0
	}
	return true, w.vals[i]
}

tick :: proc(w: ^World, spread_rate: f32) {
	// Synchronous update:
	// - SOURCE: VAL_next = 255 (always emits maximum energy)
// - ETHER: Diffuses energy but leaves a small leak so a gradient can form
//   Takes average of 8 neighbors and nudges toward it each tick
//   Spread rate controls how quickly the cell moves toward its neighbors
	ww := w.width
	hh := w.height
	dir_offsets := DIR_OFFSETS

	// Spread rate: controls how quickly the cell moves toward the average of its neighbors.
	// IMPORTANT: This is an explicit relaxation step; if the step size > 1.0 it overshoots and
	// the field "explodes" (rapid saturation/instability). Keep it in [0, 1].

	for y in 0..<hh {
		row := y*ww
		for x in 0..<ww {
			i := row + x
			t := w.types[i]

			switch t {
			case .SOURCE:
				w.next_types[i] = .SOURCE
				w.next_vals[i]  = 512.0
				w.next_ops[i]   = .IDLE
				w.next_genes[i] = 0
				w.next_dir_moves[i]  = 0
				w.next_dir_reads[i]  = 0
				w.next_dir_writes[i] = 0
			case .CELL:
				// Persist state
				w.next_types[i] = .CELL
				w.next_ops[i]   = w.ops[i]
				w.next_genes[i] = w.genes[i]
				w.next_dir_moves[i]  = w.dir_moves[i]
				w.next_dir_reads[i]  = w.dir_reads[i]
				w.next_dir_writes[i] = w.dir_writes[i]
				current_val := w.vals[i]

				// Accept external writes (mutation) from locked WRITE neighbors.
				// Deterministic: first qualifying writer in DIR_OFFSETS order wins.
				for off in dir_offsets {
					nx, ny := clamp_coords(w, x + off.x, y + off.y)
					n_idx := idx_of(w, nx, ny)
					if w.types[n_idx] != .CELL || w.ops[n_idx] != .WRITE {
						continue
					}
					// Does neighbor's write head point to me?
					if !points_to_idx(w, n_idx, w.dir_writes[n_idx], i) {
						continue
					}

					// Writer must be locked: reading solid AND writing solid (this cell).
					n_r_dir := w.dir_reads[n_idx]
					n_r_off := dir_offsets[int(n_r_dir)]
					n_r_idx := idx_clamped(w, nx + n_r_off.x, ny + n_r_off.y)

					n_w_dir := w.dir_writes[n_idx]
					n_w_off := dir_offsets[int(n_w_dir)]
					n_w_idx := idx_clamped(w, nx + n_w_off.x, ny + n_w_off.y)

					is_locked := (w.types[n_r_idx] != .ETHER) && (w.types[n_w_idx] != .ETHER)
					if !is_locked {
						continue
					}

					// Writer must afford the cost (based on my current OP).
					cost: f32 = 10.0
					if w.ops[i] != .IDLE {
						cost = 100.0
					}
					if w.vals[n_idx] <= cost {
						continue
					}

					// Decode gene -> target op (2 bits per observed OP).
					n_r_op: Op_Code = .IDLE
					if w.types[n_r_idx] == .CELL {
						n_r_op = w.ops[n_r_idx]
					} else if w.types[n_r_idx] == .SOURCE {
						n_r_op = .IDLE
					}
					shift := u8(n_r_op) * 2
					target_op_bits := (w.genes[n_idx] >> shift) & 0b11
					w.next_ops[i] = Op_Code(target_op_bits)
					break
				}

				// OP execution: GROW (departure check)
				if w.ops[i] == .GROW {
					my_dir := w.dir_moves[i]
					off := dir_offsets[int(my_dir)]
					tx, ty := clamp_coords(w, x + off.x, y + off.y)
					ti := idx_of(w, tx, ty)

					// If target is Ether, we "depart": become an IDLE tail and drop energy here.
					// The actual new head + energy transfer happens from the Ether perspective (pull).
					if w.types[ti] == .ETHER && current_val >= GROW_STEP_COST {
						w.next_ops[i] = .IDLE
						current_val = 0.0
					} else {
						// Charge up from the local Ether neighborhood (and sources).
						// Note: This is not energy-conserving (neighbors are not depleted).
						energy_sum: f32 = 0.0
						for off2 in dir_offsets {
							nx := x + off2.x
							ny := y + off2.y
							cx, cy := clamp_coords(w, nx, ny)
							ni := idx_of(w, cx, cy)
							nt := w.types[ni]
							if nt == .SOURCE {
								energy_sum += 512.0
							} else if nt == .ETHER {
								energy_sum += w.vals[ni]
							}
						}
						current_val += energy_sum * GROW_CHARGE_RATE
					}
				}

				// OP execution: WRITE ("Scanner Walker")
				if w.ops[i] == .WRITE {
					leaving := false

					// Phase 1: SENSE (Read head)
					r_dir := w.dir_reads[i]
					r_off := dir_offsets[int(r_dir)]
					r_idx := idx_clamped(w, x + r_off.x, y + r_off.y)
					r_type := w.types[r_idx]
					r_op: Op_Code = .IDLE

					// Phase 2: REFLEX (Read Scan)
					if r_type == .ETHER {
						w.next_dir_reads[i] = u8((int(r_dir) + 1) % 8) // rotate CW
					} else {
						if r_type == .CELL {
							r_op = w.ops[r_idx]
						} else if r_type == .SOURCE {
							r_op = .IDLE
						}

						// Phase 2b: REFLEX (Write Align)
						w_dir := w.dir_writes[i]
						w_off := dir_offsets[int(w_dir)]
						w_idx := idx_clamped(w, x + w_off.x, y + w_off.y)
						w_type := w.types[w_idx]

						// Only CELL is a valid write target (SOURCE is solid but isn't meaningfully writable here).
						if w_type != .CELL {
							w.next_dir_writes[i] = u8((int(w_dir) + 7) % 8) // rotate CCW
						} else {
							// Phase 3: EXECUTION (Fully Locked)
							did_write := false

							// --- WRITE ACTION (pay cost; target accepts write in its own update) ---
							cost: f32 = 10.0
							if w.ops[w_idx] != .IDLE {
								cost = 100.0
							}

							// "Successful write" is defined as: this writer is the first eligible writer
							// that the target would accept this tick (deterministic, same scan order).
							is_winner := false
							{
								tx := w_idx % ww
								ty := w_idx / ww
								for off3 in dir_offsets {
									cx, cy := clamp_coords(w, tx + off3.x, ty + off3.y)
									cand_idx := idx_of(w, cx, cy)
									if w.types[cand_idx] != .CELL || w.ops[cand_idx] != .WRITE {
										continue
									}
									if !points_to_idx(w, cand_idx, w.dir_writes[cand_idx], w_idx) {
										continue
									}

									// Candidate must be locked (read solid AND write solid).
									c_r_dir := w.dir_reads[cand_idx]
									c_r_off := dir_offsets[int(c_r_dir)]
									c_r_idx := idx_clamped(w, cx + c_r_off.x, cy + c_r_off.y)

									c_w_dir := w.dir_writes[cand_idx]
									c_w_off := dir_offsets[int(c_w_dir)]
									c_w_idx := idx_clamped(w, cx + c_w_off.x, cy + c_w_off.y)

									c_locked := (w.types[c_r_idx] != .ETHER) && (w.types[c_w_idx] != .ETHER)
									if !c_locked {
										continue
									}
									// Candidate must afford the cost (same cost for all contenders).
									if w.vals[cand_idx] <= cost {
										continue
									}

									is_winner = cand_idx == i
									break // first eligible writer decides the winner
								}
							}

							if is_winner && current_val > cost {
								shift := u8(r_op) * 2
								_ = (w.genes[i] >> shift) & 0b11 // decoded by target acceptance
								current_val -= cost
								did_write = true
							}

							// --- MOVE ACTION (depart; target Ether accepts invasion) ---
							m_dir := w.dir_moves[i]
							m_off := dir_offsets[int(m_dir)]
							m_idx := idx_clamped(w, x + m_off.x, y + m_off.y)
							// Movement is only allowed after a successful write (same tick).
							if did_write && w.types[m_idx] == .ETHER && current_val > 50.0 {
								leaving = true
								w.next_types[i] = .ETHER
								w.next_ops[i]   = .IDLE
								w.next_vals[i]  = 0.0
								w.next_genes[i] = 0
								w.next_dir_moves[i]  = 0
								w.next_dir_reads[i]  = 0
								w.next_dir_writes[i] = 0
							}
						}
					}

					if !leaving {
						// Save updated VAL
						current_val = clamp_f32(current_val, 0.0, 512.0)
						w.next_vals[i] = current_val
					}
				}

				// Clamp (WRITE handles its own VAL write because it can depart as ETHER)
				if w.ops[i] != .WRITE {
					current_val = clamp_f32(current_val, 0.0, 512.0)
					w.next_vals[i] = current_val
				}
			case .ETHER:
				// First: invasion "pull" checks.
				// Priority: WRITE walker invasion (Scanner Walker) > GROW invasion.
				invaded := false
				invader_idx := -1

				for ni in 0..<8 {
					off := dir_offsets[ni]
					nx, ny := clamp_coords(w, x + off.x, y + off.y)
					n_idx := idx_of(w, nx, ny)

					// WRITE invasion: neighbor must be locked and moving into ME.
					if w.types[n_idx] == .CELL && w.ops[n_idx] == .WRITE {
						if points_to_idx(w, n_idx, w.dir_moves[n_idx], i) {
							// Locked: reading solid AND writing solid (not necessarily me).
							n_r_dir := w.dir_reads[n_idx]
							n_r_off := dir_offsets[int(n_r_dir)]
							n_r_idx := idx_clamped(w, nx + n_r_off.x, ny + n_r_off.y)

							n_w_dir := w.dir_writes[n_idx]
							n_w_off := dir_offsets[int(n_w_dir)]
							n_w_idx := idx_clamped(w, nx + n_w_off.x, ny + n_w_off.y)

							// Write target must be a CELL (see WRITE align rule).
							is_locked := (w.types[n_r_idx] != .ETHER) && (w.types[n_w_idx] == .CELL)

							// Must have enough energy to pay write cost AND still exceed move threshold.
							cost: f32 = 10.0
							if w.ops[n_w_idx] != .IDLE {
								cost = 100.0
							}

							// Must be the winning writer for its write-target this tick (same as target acceptance).
							is_winner := false
							if is_locked && w.vals[n_idx] > cost {
								tx := n_w_idx % ww
								ty := n_w_idx / ww
								for off3 in dir_offsets {
									cx, cy := clamp_coords(w, tx + off3.x, ty + off3.y)
									cand_idx := idx_of(w, cx, cy)
									if w.types[cand_idx] != .CELL || w.ops[cand_idx] != .WRITE {
										continue
									}
									if !points_to_idx(w, cand_idx, w.dir_writes[cand_idx], n_w_idx) {
										continue
									}

									c_r_dir := w.dir_reads[cand_idx]
									c_r_off := dir_offsets[int(c_r_dir)]
									c_r_idx := idx_clamped(w, cx + c_r_off.x, cy + c_r_off.y)

									c_w_dir := w.dir_writes[cand_idx]
									c_w_off := dir_offsets[int(c_w_dir)]
									c_w_idx := idx_clamped(w, cx + c_w_off.x, cy + c_w_off.y)

									c_locked := (w.types[c_r_idx] != .ETHER) && (w.types[c_w_idx] != .ETHER)
									if !c_locked {
										continue
									}
									if w.vals[cand_idx] <= cost {
										continue
									}
									is_winner = cand_idx == n_idx
									break
								}
							}

							// Movement only happens after successful write, so require (VAL - cost) > 50.
							if is_winner && w.vals[n_idx] > cost+50.0 {
								invaded = true
								invader_idx = n_idx

								w.next_types[i] = .CELL
								w.next_ops[i]   = .WRITE
								// Harvest: moving into Ether absorbs half of the Ether's energy.
								w.next_vals[i]  = clamp_f32(w.vals[n_idx] + (w.vals[i] * 0.5), 0.0, 512.0)
								w.next_genes[i] = w.genes[n_idx]
								w.next_dir_moves[i]  = w.dir_moves[n_idx]
								w.next_dir_reads[i]  = w.dir_reads[n_idx]
								w.next_dir_writes[i] = w.dir_writes[n_idx]
								break // first invader wins
							}
						}
					}

					// GROW invasion (legacy)
					if w.types[n_idx] == .CELL && w.ops[n_idx] == .GROW {
						n_dir := w.dir_moves[n_idx]
						n_off := dir_offsets[int(n_dir)]
						tx, ty := clamp_coords(w, nx + n_off.x, ny + n_off.y)
						if tx == x && ty == y {
							// Only a sufficiently-energized head can invade.
							if w.vals[n_idx] >= GROW_STEP_COST {
								invaded = true
								invader_idx = n_idx
								break // first invader wins
							}
						}
					}
				}

				if invaded {
					// WRITE already populated next_* during the scan.
					if w.ops[invader_idx] == .GROW {
						w.next_types[i] = .CELL
						w.next_ops[i]   = .GROW
						w.next_genes[i] = w.genes[invader_idx]
						w.next_dir_moves[i]  = w.dir_moves[invader_idx]
						w.next_dir_reads[i]  = w.dir_reads[invader_idx]
						w.next_dir_writes[i] = w.dir_writes[invader_idx]
						w.next_vals[i]  = clamp_f32(w.vals[invader_idx]-GROW_STEP_COST, 0.0, 512.0)
					}
				} else {
					// Sample all 8 neighbors (equal weight), with CELL permeability rules
					sum: f32 = 0.0
					count: f32 = 0.0

					incl, v := sample_for_ether(w, x,   y-1); if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, x,   y+1); if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, x+1, y);   if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, x-1, y);   if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, x+1, y-1); if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, x-1, y-1); if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, x+1, y+1); if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, x-1, y+1); if incl { sum += v; count += 1 }

					current_val := w.vals[i]
					neighbor_avg := current_val
					if count > 0.0 {
						neighbor_avg = sum / count
					}

					new_val := current_val + (neighbor_avg - current_val) * spread_rate
					new_val = clamp_f32(new_val, 0.0, 512.0)

					w.next_types[i] = .ETHER
					w.next_ops[i]   = .IDLE
					w.next_genes[i] = 0
					w.next_dir_moves[i]  = 0
					w.next_dir_reads[i]  = 0
					w.next_dir_writes[i] = 0
					w.next_vals[i]  = new_val
				}
			}
		}
	}

	w.types, w.next_types = w.next_types, w.types
	w.vals,  w.next_vals  = w.next_vals,  w.vals
	w.ops,   w.next_ops   = w.next_ops,   w.ops
	w.genes, w.next_genes = w.next_genes, w.genes
	w.dir_moves,  w.next_dir_moves  = w.next_dir_moves,  w.dir_moves
	w.dir_reads,  w.next_dir_reads  = w.next_dir_reads,  w.dir_reads
	w.dir_writes, w.next_dir_writes = w.next_dir_writes, w.dir_writes
}

round_i32 :: proc(x: f32) -> i32 {
	if x >= 0 {
		return i32(x + 0.5)
	}
	return i32(x - 0.5)
}

min_f32 :: proc(a, b: f32) -> f32 {
	if a < b { return a }
	return b
}

max_f32 :: proc(a, b: f32) -> f32 {
	if a > b { return a }
	return b
}

get_mouse_cell :: proc(w: ^World, dst: rl.Rectangle, scale: f32) -> (ok: bool, x: int, y: int) {
	m := rl.GetMousePosition()
	if m.x < dst.x || m.y < dst.y || m.x >= dst.x+dst.width || m.y >= dst.y+dst.height {
		return false, 0, 0
	}
	x = int((m.x - dst.x) / scale)
	y = int((m.y - dst.y) / scale)
	if x < 0 || y < 0 || x >= w.width || y >= w.height {
		return false, 0, 0
	}
	return true, x, y
}

to_pixel :: proc(t: Cell_Type, v: f32, op: Op_Code) -> rl.Color {
	if t == .SOURCE {
		// Slight warm tint so vents read as "special", while still being bright.
		return rl.Color{255, 255, 220, 255}
	}
	if t == .CELL {
		if op == .GROW {
			// GROW: motile head
			return rl.Color{120, 180, 255, 255}
		}
		if op == .WRITE {
			// WRITE: scanner walker
			return rl.Color{220, 120, 255, 255}
		}
		// IDLE: wall
		return rl.Color{120, 255, 120, 255}
	}
	v_u8 := u8(round_i32(clamp_f32(v, 0.0, 255.0)))
	return rl.Color{v_u8, v_u8, v_u8, 255}
}

main :: proc() {
	rl.SetConfigFlags(rl.ConfigFlags{.WINDOW_RESIZABLE, .VSYNC_HINT})
	rl.InitWindow(WINDOW_W, WINDOW_H, "Chromatose 3.0 (Diffusion Engine)")
	defer rl.CloseWindow()
	rl.SetTargetFPS(60)

	world := world_make(SIM_W, SIM_H)
	world_seed(&world)

	image := rl.GenImageColor(i32(world.width), i32(world.height), rl.BLACK)
	texture_a := rl.LoadTextureFromImage(image)
	texture_b := rl.LoadTextureFromImage(image)
	rl.UnloadImage(image)
	defer rl.UnloadTexture(texture_a)
	defer rl.UnloadTexture(texture_b)

	rl.SetTextureFilter(texture_a, rl.TextureFilter.POINT)
	rl.SetTextureFilter(texture_b, rl.TextureFilter.POINT)

	read_tex  := texture_a
	write_tex := texture_b

	pixels := make([]rl.Color, world.width*world.height)

	paused := false
	zoom: f32 = 1.0
	pan := rl.Vector2{0, 0}
	pixel_perfect := true

	spread_f32: f32 = 1.0
		brush_cell_op: Op_Code = .WRITE
		paint_dir_move:  u8 = 0
		paint_dir_read:  u8 = 0
		paint_dir_write: u8 = 0
		paint_gene: u8 = u8((2 << 0) | (2 << 2) | (3 << 4) | (2 << 6))
	for !rl.WindowShouldClose() {
		if rl.IsKeyPressed(.SPACE) { paused = !paused }
		if rl.IsKeyPressed(.R)     { world_seed(&world) }
		if rl.IsKeyPressed(.C)     { world_clear(&world) }
		if rl.IsKeyPressed(.F)     { zoom = 1.0; pan = rl.Vector2{0, 0} }
		if rl.IsKeyPressed(.P)     { pixel_perfect = !pixel_perfect }
		if rl.IsKeyPressed(.ONE)   { brush_cell_op = .IDLE }
		if rl.IsKeyPressed(.TWO)   { brush_cell_op = .GROW }
		if rl.IsKeyPressed(.THREE) { brush_cell_op = .WRITE }
		if rl.IsKeyPressed(.EQUAL) || rl.IsKeyPressed(.KP_ADD) {
			spread_f32 = clamp_f32(spread_f32+0.01, 0.0, 1.0)
		}
		if rl.IsKeyPressed(.MINUS) || rl.IsKeyPressed(.KP_SUBTRACT) {
			spread_f32 = clamp_f32(spread_f32-0.01, 0.0, 1.0)
		}

		dt := rl.GetFrameTime()
		pan_speed := 600.0 * dt
		if rl.IsKeyDown(.LEFT)  { pan.x -= pan_speed }
		if rl.IsKeyDown(.RIGHT) { pan.x += pan_speed }
		if rl.IsKeyDown(.UP)    { pan.y -= pan_speed }
		if rl.IsKeyDown(.DOWN)  { pan.y += pan_speed }

		wheel_steps := int(rl.GetMouseWheelMove())
		// Mouse wheel: cycle the global paint direction (0..7).
		// Hold Ctrl to use wheel for zoom (keeps the old navigation affordance).
		if wheel_steps != 0 {
			ctrl_down := rl.IsKeyDown(.LEFT_CONTROL) || rl.IsKeyDown(.RIGHT_CONTROL)
			if ctrl_down {
				if wheel_steps > 0 {
					for _ in 0..<wheel_steps { zoom *= 1.1 }
				} else {
					for _ in 0..<(-wheel_steps) { zoom /= 1.1 }
				}
			} else {
				shift_down := rl.IsKeyDown(.LEFT_SHIFT) || rl.IsKeyDown(.RIGHT_SHIFT)
				alt_down := rl.IsKeyDown(.LEFT_ALT) || rl.IsKeyDown(.RIGHT_ALT)

				// No modifiers: move dir. Shift: read dir. Alt: write dir.
				if shift_down {
					if wheel_steps > 0 {
						for _ in 0..<wheel_steps { paint_dir_read = u8((int(paint_dir_read) + 1) % 8) }
					} else {
						for _ in 0..<(-wheel_steps) { paint_dir_read = u8((int(paint_dir_read) + 7) % 8) }
					}
				} else if alt_down {
					if wheel_steps > 0 {
						for _ in 0..<wheel_steps { paint_dir_write = u8((int(paint_dir_write) + 1) % 8) }
					} else {
						for _ in 0..<(-wheel_steps) { paint_dir_write = u8((int(paint_dir_write) + 7) % 8) }
					}
				} else {
					if wheel_steps > 0 {
						for _ in 0..<wheel_steps { paint_dir_move = u8((int(paint_dir_move) + 1) % 8) }
					} else {
						for _ in 0..<(-wheel_steps) { paint_dir_move = u8((int(paint_dir_move) + 7) % 8) }
					}
				}
			}
		}
		if zoom < 0.25 { zoom = 0.25 }
		if zoom > 64.0 { zoom = 64.0 }

		sw := rl.GetScreenWidth()
		sh := rl.GetScreenHeight()

		// Reserve a small HUD strip at the top.
		ui_top: i32 = 56
		if ui_top > sh-1 { ui_top = sh-1 }

		src := rl.Rectangle{0, 0, f32(world.width), f32(world.height)}
		view_w := sw
		view_h := sh - ui_top
		base_scale := min_f32(f32(view_w)/f32(world.width), f32(view_h)/f32(world.height))
		scale := base_scale * zoom
		if pixel_perfect {
			si := int(scale)
			if si < 1 { si = 1 }
			scale = f32(si)
		}

		dst_w := f32(world.width) * scale
		dst_h := f32(world.height) * scale
		dst_x := (f32(view_w) - dst_w) * 0.5 + pan.x
		dst_y := f32(ui_top) + (f32(view_h) - dst_h) * 0.5 + pan.y
		if dst_y < f32(ui_top)+2 { dst_y = f32(ui_top) + 2 }
		if pixel_perfect {
			dst_x = f32(round_i32(dst_x))
			dst_y = f32(round_i32(dst_y))
		}
		dst := rl.Rectangle{dst_x, dst_y, dst_w, dst_h}

		// Paint/erase sources with mouse in texture space.
		if ok, cx, cy := get_mouse_cell(&world, dst, scale); ok {
			if rl.IsMouseButtonDown(.LEFT) {
				world_set_cell(&world, cx, cy, .SOURCE, .IDLE, 0, 0, 0, 0)
			} else if rl.IsMouseButtonDown(.MIDDLE) {
				gene := u8(0)
				if brush_cell_op == .WRITE {
					gene = paint_gene
				}
				world_set_cell(&world, cx, cy, .CELL, brush_cell_op, paint_dir_move, paint_dir_read, paint_dir_write, gene)
			} else if rl.IsMouseButtonDown(.RIGHT) {
				world_set_cell(&world, cx, cy, .ETHER, .IDLE, 0, 0, 0, 0)
			}
		}

		if !paused {
			// // Run multiple substeps per frame so "bathtub filling" is visible even far from sources.
			// // This keeps the per-step update stable (accum_rate <= 1) while letting `spread` speed up time.
			// substeps := 1 + spread_i32/32
			// if substeps < 1  { substeps = 1 }
			// if substeps > 16 { substeps = 16 }
			// for _ in 0..<substeps {
				tick(&world, spread_f32)
			// }
		}

		for i in 0..<len(pixels) {
			pixels[i] = to_pixel(world.types[i], world.vals[i], world.ops[i])
		}
		rl.UpdateTexture(write_tex, raw_data(pixels))

		rl.BeginDrawing()
		rl.ClearBackground(rl.BLACK)

		rl.DrawRectangle(0, 0, sw, ui_top, rl.Color{0, 0, 0, 180})
		rl.DrawText("Chromatose 3.0: Diffusion Engine", 10, 8, 20, rl.RAYWHITE)
		rl.DrawText("LMB: paint SOURCE   MMB: paint CELL   1: CELL=IDLE(wall)   2: CELL=GROW(head)   3: CELL=WRITE(walker)   Wheel: dir_move   Shift+Wheel: dir_read   Alt+Wheel: dir_write   Ctrl+Wheel: zoom   RMB: erase to ETHER   SPACE: pause   R: reseed   C: clear   +/-: spread   P: pixel-perfect   F: reset view", 10, 30, 18, rl.RAYWHITE)
		rl.DrawText(rl.TextFormat("spread=%f   zoom=%.2f   sim=%dx%d   cell_op=%d   move=%d read=%d write=%d gene=%d", spread_f32, zoom, world.width, world.height, u8(brush_cell_op), paint_dir_move, paint_dir_read, paint_dir_write, paint_gene), 10, ui_top-20, 18, rl.RAYWHITE)

		origin := rl.Vector2{0, 0}
		rl.DrawTexturePro(read_tex, src, dst, origin, 0, rl.WHITE)
		rl.DrawFPS(10, ui_top + 10)

		rl.EndDrawing()

		tmp := read_tex
		read_tex = write_tex
		write_tex = tmp
	}
}
