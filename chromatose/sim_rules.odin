package chromatose

// Simulation rules (pure-ish): deterministic state transition.

// Neighbor sampling for ETHER updates:
// - SOURCE -> include cfg.energy_max
// - ETHER  -> include neighbor val
// - CELL   -> ignore (wall)
sample_for_ether :: proc(w: ^World, cfg: Sim_Config, x, y: int) -> (include: bool, v: f32) {
	xx, yy := clamp_coords(w, x, y)
	i := idx_of(w, xx, yy)
	switch w.types[i] {
	case .SOURCE:
		return true, cfg.energy_max
	case .ETHER:
		return true, w.vals[i]
	case .CELL:
		return false, 0.0
	}
	return true, w.vals[i]
}

write_cost_for_target :: proc(target_op: Op_Code, cfg: Sim_Config) -> f32 {
	if target_op != .IDLE {
		return cfg.write_cost_solid
	}
	return cfg.write_cost_idle
}

hash_u32 :: proc(x: u32) -> u32 {
	// Simple deterministic integer hash (good enough for 1-in-N rare events).
	h := x
	h ~= h >> 16
	h *= 0x7feb352d
	h ~= h >> 15
	h *= 0x846ca68b
	h ~= h >> 16
	return h
}

cell_has_energy_connection :: proc(w: ^World, x, y: int) -> bool {
	// "Connected" here means adjacent (8-neighborhood) to an energy-bearing medium:
	// - SOURCE always counts (it is effectively VAL=energy_max)
	// - ETHER counts only if VAL > 0
	dir_offsets := DIR_OFFSETS
	for off in dir_offsets {
		ni := idx_clamped(w, x + off.x, y + off.y)
		nt := w.types[ni]
		if nt == .SOURCE {
			return true
		}
		if nt == .ETHER && w.vals[ni] > 0.0 {
			return true
		}
	}
	return false
}

sim_tick :: proc(w: ^World, cfg: Sim_Config) {
	ww := w.width
	hh := w.height
	dir_offsets := DIR_OFFSETS

	for y in 0..<hh {
		row := y*ww
		for x in 0..<ww {
			i := row + x
			t := w.types[i]

			switch t {
			case .SOURCE:
				w.next_types[i] = .SOURCE
				w.next_vals[i]  = cfg.energy_max
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
					cost := write_cost_for_target(w.ops[i], cfg)
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
					
					// Randomize directions when a new OP is written.
					// Use deterministic hash based on cell index and tick for reproducibility.
					rng_seed := hash_u32(u32(i) ~ u32(w.tick) ~ 0x9e3779b9)
					w.next_dir_moves[i]  = u8(hash_u32(rng_seed) % 8)
					w.next_dir_reads[i]  = u8(hash_u32(rng_seed ~ 0x517cc1b7) % 8)
					w.next_dir_writes[i] = u8(hash_u32(rng_seed ~ 0x6a09e667) % 8)
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
					if w.types[ti] == .ETHER && current_val >= cfg.grow_step_cost {
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
								energy_sum += cfg.energy_max
							} else if nt == .ETHER {
								energy_sum += w.vals[ni]
							}
						}
						current_val += energy_sum * cfg.grow_charge_rate
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
							cost := write_cost_for_target(w.ops[w_idx], cfg)

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
							if did_write && w.types[m_idx] == .ETHER && current_val > cfg.write_move_threshold {
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
						// Starvation: if disconnected from energised Ether, drain toward 0.
						if !cell_has_energy_connection(w, x, y) {
							if cfg.cell_starve_ticks > 0 {
								drain := cfg.energy_max / f32(cfg.cell_starve_ticks)
								current_val = max_f32(0.0, current_val - drain)
							} else {
								current_val = 0.0
							}

							if current_val <= 0.0 {
								// Death -> Ether(0) or rare Source.
								make_source := false
								if cfg.cell_death_source_1_in > 0 {
									r := hash_u32(u32(w.tick) ~ (u32(i) * 0x9e3779b9))
									make_source = (r % cfg.cell_death_source_1_in) == 0
								}

								if make_source {
									w.next_types[i] = .SOURCE
									w.next_vals[i]  = cfg.energy_max
								} else {
									w.next_types[i] = .ETHER
									w.next_vals[i]  = 0.0
								}
								w.next_ops[i]   = .IDLE
								w.next_genes[i] = 0
								w.next_dir_moves[i]  = 0
								w.next_dir_reads[i]  = 0
								w.next_dir_writes[i] = 0
							}
						}

						// Save updated VAL (if still a CELL; otherwise it was overwritten above).
						if w.next_types[i] == .CELL {
							current_val = clamp_f32(current_val, cfg.energy_min, cfg.energy_max)
							w.next_vals[i] = current_val
						}
					}
				}

				// Clamp (WRITE handles its own VAL write because it can depart as ETHER)
				if w.ops[i] != .WRITE {
					// Starvation (non-WRITE ops): apply after OP logic, before clamping.
					if !cell_has_energy_connection(w, x, y) {
						if cfg.cell_starve_ticks > 0 {
							drain := cfg.energy_max / f32(cfg.cell_starve_ticks)
							current_val = max_f32(0.0, current_val - drain)
						} else {
							current_val = 0.0
						}

						if current_val <= 0.0 {
							make_source := false
							if cfg.cell_death_source_1_in > 0 {
								r := hash_u32(u32(w.tick) ~ (u32(i) * 0x9e3779b9))
								make_source = (r % cfg.cell_death_source_1_in) == 0
							}
							if make_source {
								w.next_types[i] = .SOURCE
								w.next_vals[i]  = cfg.energy_max
							} else {
								w.next_types[i] = .ETHER
								w.next_vals[i]  = 0.0
							}
							w.next_ops[i]   = .IDLE
							w.next_genes[i] = 0
							w.next_dir_moves[i]  = 0
							w.next_dir_reads[i]  = 0
							w.next_dir_writes[i] = 0
						}
					}

					// Save updated VAL (if still a CELL; otherwise it was overwritten above).
					if w.next_types[i] == .CELL {
						current_val = clamp_f32(current_val, cfg.energy_min, cfg.energy_max)
						w.next_vals[i] = current_val
					}
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
							cost := write_cost_for_target(w.ops[n_w_idx], cfg)

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

							// Movement only happens after successful write, so require (VAL - cost) > threshold.
							if is_winner && w.vals[n_idx] > cost+cfg.write_move_threshold {
								invaded = true
								invader_idx = n_idx

								w.next_types[i] = .CELL
								w.next_ops[i]   = .WRITE
								// Harvest: moving into Ether absorbs a fraction of the Ether's energy.
								w.next_vals[i]  = clamp_f32(w.vals[n_idx] + (w.vals[i] * cfg.write_ether_absorb_frac), cfg.energy_min, cfg.energy_max)
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
							if w.vals[n_idx] >= cfg.grow_step_cost {
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
						w.next_vals[i]  = clamp_f32(w.vals[invader_idx]-cfg.grow_step_cost, cfg.energy_min, cfg.energy_max)
					}
				} else {
					// Sample all 8 neighbors (equal weight), with CELL permeability rules.
					sum: f32 = 0.0
					count: f32 = 0.0

					incl, v := sample_for_ether(w, cfg, x,   y-1); if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, cfg, x,   y+1); if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, cfg, x+1, y);   if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, cfg, x-1, y);   if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, cfg, x+1, y-1); if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, cfg, x-1, y-1); if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, cfg, x+1, y+1); if incl { sum += v; count += 1 }
					incl, v  = sample_for_ether(w, cfg, x-1, y+1); if incl { sum += v; count += 1 }

					current_val := w.vals[i]
					neighbor_avg := current_val
					if count > 0.0 {
						neighbor_avg = sum / count
					}

					new_val := current_val + (neighbor_avg - current_val) * cfg.spread_rate
					new_val = clamp_f32(new_val, cfg.energy_min, cfg.energy_max)

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

	w.tick += 1
}


