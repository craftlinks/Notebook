package chromatose

// Simulation rules (pure-ish): deterministic state transition.

// Neighbor sampling for ETHER updates:
// - SOURCE -> include cfg.energy_max
// - ETHER  -> include neighbor val
// - CODE/PORE(op) -> include neighbor val (allows energy to pass through)
// - CODE (other ops) -> ignore (wall)
sample_for_ether :: proc(w: ^World, cfg: Sim_Config, x, y: int) -> (include: bool, v: f32) {
	xx, yy := clamp_coords(w, x, y)
	i := idx_of(w, xx, yy)
	switch w.types[i] {
	case .SOURCE:
		return true, cfg.energy_max
	case .ETHER:
		return true, w.vals[i]
	case .CODE:
		if w.ops[i] == .PORE {
			return true, w.vals[i]
		}
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

pore_energy_bonus_weight_8_for_val :: proc(val: f32, cfg: Sim_Config) -> u32 {
	// Returns a bonus weight in 0..8, scaled by normalized energy (VAL/energy_max).
	// This lets higher-energy targets be more likely to become PORE when a rule is eligible.
	bonus := cfg.pore_energy_bonus_weight_8
	if bonus == 0 { return 0 }
	if bonus > 8 { bonus = 8 }
	if cfg.energy_max <= 0 { return 0 }

	norm := clamp_f32(val/cfg.energy_max, 0.0, 1.0)
	bw := round_i32(norm * f32(bonus))
	if bw <= 0 { return 0 }
	if bw >= 8 { return 8 }
	return u32(bw)
}

mutate_write_gene :: proc(gene: u16, seed: u32) -> u16 {
	// Mutate a single 3-bit slot (0..4) to a new 3-bit value (0..7).
	// This keeps the gene compact and preserves the "junk DNA" path (5..7).
	slot := u32(hash_u32(seed ~ 0xC001D00D) % 5)
	new_val := u16(hash_u32(seed ~ 0xBADC0FFE) % 8)
	shift := u16(slot * 3)
	mask := u16(0b111) << shift
	cleared := gene & ~mask
	return cleared | (new_val << shift)
}

cell_has_energy_connection :: proc(w: ^World, x, y: int) -> bool {
	// "Connected" here means adjacent (8-neighborhood) to an energy-bearing medium:
	// - SOURCE always counts (it is effectively VAL=energy_max)
	// - ETHER counts only if VAL > 0
	// - PORE(op) counts only if VAL > 0 (conducts energy like ETHER)
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
		if nt == .CODE && w.ops[ni] == .PORE && w.vals[ni] > 0.0 {
			return true
		}
	}
	return false
}

max_neighbor_energy :: proc(w: ^World, cfg: Sim_Config, x, y: int) -> (max_v: f32, max_idx: int) {
	// Deterministically returns the maximum "pressure" energy among adjacent cells.
	// SOURCE counts as cfg.energy_max. ETHER counts if VAL > 0. PORE counts if VAL > 0.
	dir_offsets := DIR_OFFSETS
	max_v = 0.0
	max_idx = -1
	for off in dir_offsets {
		ni := idx_clamped(w, x + off.x, y + off.y)
		nt := w.types[ni]
		v: f32 = 0.0
		switch nt {
		case .SOURCE:
			v = cfg.energy_max
		case .ETHER:
			if w.vals[ni] > 0.0 { v = w.vals[ni] }
		case .CODE:
			if w.ops[ni] == .PORE && w.vals[ni] > 0.0 { v = w.vals[ni] }
		}
		if v > max_v {
			max_v = v
			max_idx = ni
		}
	}
	return
}

maybe_overheat_rupture :: proc(w: ^World, cfg: Sim_Config, x, y: int, i: int, current_val: f32) -> (ruptured: bool) {
	// High-energy "pressure" rupture:
	// If adjacent to very high energy (notably SOURCE), a solid CODE cell can rupture.
	// Outcome is either ETHER (dissolve) or PORE (permeable wall).
	if cfg.wall_overheat_break_weight_8 == 0 {
		return false
	}
	if cfg.energy_max <= 0 {
		return false
	}
	if cfg.wall_overheat_min_neighbor_val >= cfg.energy_max {
		return false
	}

	max_v, max_i := max_neighbor_energy(w, cfg, x, y)
	if max_i < 0 || max_v < cfg.wall_overheat_min_neighbor_val {
		return false
	}

	denom := max_f32(1.0, cfg.energy_max - cfg.wall_overheat_min_neighbor_val)
	norm := clamp_f32((max_v - cfg.wall_overheat_min_neighbor_val)/denom, 0.0, 1.0)

	bw := cfg.wall_overheat_break_weight_8
	if bw > 8 { bw = 8 }
	w8 := round_i32(norm * f32(bw))
	if w8 <= 0 {
		return false
	}
	if w8 > 8 { w8 = 8 }

	rp := hash_u32(u32(w.tick) ~ u32(i) ~ u32(max_i) ~ 0x0F3E1347)
	if (rp % 8) >= u32(w8) {
		return false
	}

	// Decide rupture outcome: PORE vs ETHER.
	pw := cfg.wall_overheat_pore_weight_8
	if pw > 8 { pw = 8 }
	rr := hash_u32(rp ~ 0x0B10B007)
	become_pore := (pw > 0) && ((rr % 8) < pw)

	if become_pore {
		// Become PORE (permeable wall); keep VAL as-is (will diffuse next tick).
		w.next_types[i] = .CODE
		w.next_ops[i]   = .PORE
		w.next_genes[i] = 0
		w.next_dir_moves[i]  = 0
		w.next_dir_reads[i]  = 0
		w.next_dir_reads2[i] = 0
		w.next_dir_writes[i] = 0
		w.next_idle_ticks[i] = 0
		w.next_vals[i]       = clamp_f32(current_val, cfg.energy_min, cfg.energy_max)
		return true
	}

	// Dissolve to ETHER: preserve energy so it can immediately diffuse outward.
	w.next_types[i] = .ETHER
	w.next_vals[i]  = clamp_f32(current_val, cfg.energy_min, cfg.energy_max)
	w.next_ops[i]   = .IDLE
	w.next_genes[i] = 0
	w.next_dir_moves[i]  = 0
	w.next_dir_reads[i]  = 0
	w.next_dir_reads2[i] = 0
	w.next_dir_writes[i] = 0
	w.next_idle_ticks[i] = 0
	return true
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
			w.next_dir_reads2[i] = 0
			w.next_dir_writes[i] = 0
			w.next_idle_ticks[i] = 0

		case .CODE:
				// Persist state
				w.next_types[i] = .CODE
				w.next_ops[i]   = w.ops[i]
				w.next_genes[i] = w.genes[i]
				w.next_dir_moves[i]  = w.dir_moves[i]
				w.next_dir_reads[i]  = w.dir_reads[i]
				w.next_dir_reads2[i] = w.dir_reads2[i]
				w.next_dir_writes[i] = w.dir_writes[i]
				w.next_idle_ticks[i] = w.idle_ticks[i]
				current_val := w.vals[i]

				if w.ops[i] == .PORE {
					// PORE op-cells are walls that allow energy diffusion.
					// They diffuse energy like ETHER but can also starve and die.
					w.next_ops[i]   = .PORE
					w.next_genes[i] = 0
					w.next_dir_moves[i]  = 0
					w.next_dir_reads[i]  = 0
					w.next_dir_reads2[i] = 0
					w.next_dir_writes[i] = 0
					pore_age := w.idle_ticks[i] + 1
					w.next_idle_ticks[i] = pore_age

					// Sample all 8 neighbors for energy diffusion (same as ETHER)
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

					neighbor_avg := current_val
					if count > 0.0 {
						neighbor_avg = sum / count
					}

					new_val := current_val + (neighbor_avg - current_val) * cfg.spread_rate

					// Starvation: if disconnected from energised Ether, drain toward 0
					if !cell_has_energy_connection(w, x, y) {
						if cfg.cell_starve_ticks > 0 {
							drain := cfg.energy_max / f32(cfg.cell_starve_ticks)
							new_val = max_f32(0.0, new_val - drain)
						} else {
							new_val = 0.0
						}

						if new_val <= 0.0 {
							// Death -> Ether(0) or rare Source
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
							w.next_dir_reads2[i] = 0
							w.next_dir_writes[i] = 0
							w.next_idle_ticks[i] = 0
						}
					}

					// Save updated VAL (if still a CODE cell; otherwise it was overwritten above)
					if w.next_types[i] == .CODE {
						new_val = clamp_f32(new_val, cfg.energy_min, cfg.energy_max)
						w.next_vals[i] = new_val

						// Lifespan: after a while, a PORE turns back into a random non-PORE op.
						if cfg.pore_lifespan_ticks > 0 {
							jitter := cfg.pore_lifespan_jitter_ticks
							extra: u32 = 0
							if jitter > 0 {
								// Salt with ASCII "PORE"
								extra = hash_u32(u32(i) ~ 0x504F5245) % (jitter + 1)
							}
							lifespan := cfg.pore_lifespan_ticks + extra
							if pore_age >= lifespan {
								rng_seed := hash_u32(u32(i) ~ u32(w.tick) ~ u32(pore_age) ~ 0xDEC0DE01)
								ops := [4]Op_Code{.IDLE, .GROW, .WRITE, .SWAP}
								new_op := ops[hash_u32(rng_seed) % u32(len(ops))]

								w.next_ops[i] = new_op
								w.next_dir_moves[i]  = u8(hash_u32(rng_seed ~ 0x11111111) % 8)
								w.next_dir_reads[i]  = u8(hash_u32(rng_seed ~ 0x22222222) % 8)
								w.next_dir_reads2[i] = u8(hash_u32(rng_seed ~ 0x33333333) % 8)
								w.next_dir_writes[i] = u8(hash_u32(rng_seed ~ 0x44444444) % 8)
								w.next_idle_ticks[i] = 0

								// Maintain invariant: only WRITE cells carry genes.
								if new_op == .WRITE {
									gene_val := hash_u32(rng_seed ~ 0x55555555) & 0xFFFF
									w.next_genes[i] = u16(gene_val)
									if w.next_genes[i] == 0 {
										w.next_genes[i] = DEFAULT_WRITE_GENE
									}
								} else {
									w.next_genes[i] = 0
								}

								// For SWAP, ensure read2 differs from read (fallback to opposite).
								if new_op == .SWAP && w.next_dir_reads2[i] == w.next_dir_reads[i] {
									w.next_dir_reads2[i] = u8((int(w.next_dir_reads[i]) + 4) % 8)
								}
							}
						}
					}
					continue
				}

				// Overheat rupture applies to any solid CODE cell (any op except PORE).
				if maybe_overheat_rupture(w, cfg, x, y, i, current_val) {
					continue
				}

				// Track IDLE cells and transform them after a threshold
				if w.ops[i] == .IDLE {
					// GROW -> IDLE wall hit: if any energized GROW head is pointing at this IDLE cell,
					// the wall has a small chance to convert into a PORE (permeable break).
					if cfg.grow_hit_idle_to_pore_1_in > 0 {
						for off in dir_offsets {
							nx, ny := clamp_coords(w, x + off.x, y + off.y)
							n_idx := idx_of(w, nx, ny)
							if w.types[n_idx] != .CODE || w.ops[n_idx] != .GROW {
								continue
							}
							// Does the GROW head point to me?
							if !points_to_idx(w, n_idx, w.dir_moves[n_idx], i) {
								continue
							}
							// Require enough energy that the head would be able to step.
							if w.vals[n_idx] < cfg.grow_step_cost {
								continue
							}
							rp := hash_u32(u32(w.tick) ~ u32(i) ~ u32(n_idx) ~ 0xB16B00B5)
							// Energy bias: higher-energy target walls are more likely to become PORE.
							// Preserve the existing 1-in-N chance, then add an independent bonus check.
							base_hit := (rp % cfg.grow_hit_idle_to_pore_1_in) == 0
							bonus_hit := false
							if !base_hit {
								bonus_w := pore_energy_bonus_weight_8_for_val(current_val, cfg)
								if bonus_w > 0 {
									rb := hash_u32(rp ~ 0x51A71E5)
									bonus_hit = (rb % 8) < bonus_w
								}
							}
							if base_hit || bonus_hit {
								w.next_ops[i] = .PORE
								w.next_genes[i] = 0
								w.next_dir_moves[i] = 0
								w.next_dir_reads[i] = 0
								w.next_dir_reads2[i] = 0
								w.next_dir_writes[i] = 0
								w.next_idle_ticks[i] = 0
								// Keep VAL as-is; PORE will diffuse/starve under its own rules next tick.
								break
							}
						}
						if w.next_ops[i] == .PORE {
							continue
						}
					}

					w.next_idle_ticks[i] = w.idle_ticks[i] + 1
					
					// Transform if threshold reached
					if w.idle_ticks[i] >= cfg.idle_transform_ticks {
						// Generate deterministic random op and directions using hash
						rng_seed := hash_u32(u32(i) ~ u32(w.tick) ~ 0xdeadbeef)
						
						// Choose random transformation (GROW, WRITE, SWAP).
						// NOTE: This only changes OP; it never creates a PORE op here.
						active_ops := [3]Op_Code{.GROW, .WRITE, .SWAP}
						transform_choice := hash_u32(rng_seed ~ 0x12345678) % u32(len(active_ops))
						new_op := active_ops[transform_choice]
						
						w.next_ops[i] = new_op
						w.next_dir_moves[i]  = u8(hash_u32(rng_seed ~ 0x11111111) % 8)
						w.next_dir_reads[i]  = u8(hash_u32(rng_seed ~ 0x22222222) % 8)
						w.next_dir_reads2[i] = u8(hash_u32(rng_seed ~ 0x33333333) % 8)
						w.next_dir_writes[i] = u8(hash_u32(rng_seed ~ 0x44444444) % 8)
						w.next_idle_ticks[i] = 0
						
						// Generate random gene for WRITE cells
						if new_op == .WRITE {
							gene_val := hash_u32(rng_seed ~ 0x55555555) & 0xFFFF
							w.next_genes[i] = u16(gene_val)
						} else {
							w.next_genes[i] = 0
						}
					}
				} else {
					// Reset idle ticks for non-IDLE cells
					w.next_idle_ticks[i] = 0
				}

				// Accept external writes (mutation) from locked WRITE neighbors.
				// Deterministic: first qualifying writer in DIR_OFFSETS order wins.
				for off in dir_offsets {
					nx, ny := clamp_coords(w, x + off.x, y + off.y)
					n_idx := idx_of(w, nx, ny)
					if w.types[n_idx] != .CODE || w.ops[n_idx] != .WRITE {
						continue
					}
					// Does neighbor's write head point to me?
					if !points_to_idx(w, n_idx, w.dir_writes[n_idx], i) {
						continue
					}

					// Writer must be locked: must be writing a solid CODE cell (this cell).
					// Note: we intentionally do NOT require the read head to be solid; if the read head is ETHER,
					// gene decode treats it as IDLE (slot 0). This makes WRITE less inert in sparse soups.
					n_r_dir := w.dir_reads[n_idx]
					n_r_off := dir_offsets[int(n_r_dir)]
					n_r_idx := idx_clamped(w, nx + n_r_off.x, ny + n_r_off.y)

					n_w_dir := w.dir_writes[n_idx]
					n_w_off := dir_offsets[int(n_w_dir)]
					n_w_idx := idx_clamped(w, nx + n_w_off.x, ny + n_w_off.y)

					is_locked := (w.types[n_w_idx] == .CODE)
					if !is_locked {
						continue
					}

					// Writer must afford the cost (based on my current OP).
					cost := write_cost_for_target(w.ops[i], cfg)
					if w.vals[n_idx] <= cost {
						continue
					}

					// Decode gene -> target action (3 bits per observed type).
					// Gene encoding: 3-bit index (0-4) maps to IDLE/GROW/WRITE/SWAP/PORE
					// Determine what the writer is observing at its read head
					n_r_type := w.types[n_r_idx]
					gene_idx := u8(0)
					
					if n_r_type == .CODE {
						// Observing CODE: use Op_Code to determine slot
						n_r_op := w.ops[n_r_idx]
						switch n_r_op {
						case .IDLE:  gene_idx = 0
						case .GROW:  gene_idx = 1
						case .WRITE: gene_idx = 2
						case .SWAP:  gene_idx = 3
						case .PORE:  gene_idx = 4
						}
					} else {
						// Observing SOURCE or ETHER: treat as IDLE
						gene_idx = 0
					}
					
				shift := gene_idx * 3
				target_idx := (w.genes[n_idx] >> shift) & 0b111
				// Decode 3-bit index to action: 0-3 = Op_Code, 4 = PORE op
				// If target_idx >= 5, map randomly to 0-4
				if target_idx >= 5 {
					// Use deterministic hash for reproducible randomness
					rng_seed := hash_u32(u32(i) ~ u32(w.tick) ~ u32(target_idx) ~ 0xdeadbeef)
					// Bias towards PORE (4) to increase PORE probability from junk DNA (WRITE-driven).
					weight := cfg.write_junk_pore_weight_8
					if weight > 8 { weight = 8 }
					rand_val := hash_u32(rng_seed) % 8
					if rand_val < weight {
						target_idx = 4
					} else {
						// Non-PORE junk maps uniformly to 0..3
						target_idx = u16(hash_u32(rng_seed ~ 0x6d2b79f5) % 4)
					}
				}

					// Optional novelty injection: mutate decoded action on successful writes.
					if cfg.write_action_mutation_1_in > 0 {
						r := hash_u32(u32(w.tick) ~ u32(i) ~ u32(n_idx) ~ 0x13579BDF)
						if (r % cfg.write_action_mutation_1_in) == 0 {
							target_idx = u16(hash_u32(r ~ 0x2468ACE0) % 5) // 0..4
						}
					}

					// Wall-break bias: on successful writes, optionally force PORE depending on target's current op.
					// This makes it easier for writers to punch permeable holes through "walls".
					if target_idx != 4 {
						target_op := w.ops[i]
						weight: u32 = 0
						if target_op == .IDLE {
							weight = cfg.write_break_idle_to_pore_weight_8
						} else if target_op != .PORE {
							weight = cfg.write_break_solid_to_pore_weight_8
						}
						// Energy bias: only amplify existing wall-break bias; do not introduce PORE breaks when disabled.
						if weight > 0 {
							bonus_w := pore_energy_bonus_weight_8_for_val(current_val, cfg)
							weight += bonus_w
						}
						if weight > 8 { weight = 8 }
						if weight > 0 {
							rp := hash_u32(u32(w.tick) ~ u32(i) ~ u32(n_idx) ~ 0xA5A5A5A5)
							if (rp % 8) < weight {
								target_idx = 4
							}
						}
					}
				
				if target_idx == 4 {
					// Write PORE: keep CODE type, switch op to PORE
					w.next_ops[i] = .PORE
					w.next_genes[i] = 0
					w.next_dir_moves[i] = 0
					w.next_dir_reads[i] = 0
					w.next_dir_reads2[i] = 0
					w.next_dir_writes[i] = 0
					w.next_idle_ticks[i] = 0
					break
				} else {
					// Write Op_Code: keep as CODE, change op
					target_ops := [4]Op_Code{.IDLE, .GROW, .WRITE, .SWAP}
						new_op := target_ops[target_idx]
						w.next_ops[i] = new_op

						// Maintain invariant: only WRITE cells carry genes.
						if new_op == .WRITE {
							// Propagate writer's gene so "write gene" is heritable.
							ng := w.genes[n_idx]
							if ng == 0 {
								ng = DEFAULT_WRITE_GENE
							}
							if cfg.write_gene_mutation_1_in > 0 {
								rg := hash_u32(u32(w.tick) ~ u32(i) ~ u32(n_idx) ~ 0xFEEDFACE)
								if (rg % cfg.write_gene_mutation_1_in) == 0 {
									ng = mutate_write_gene(ng, rg)
								}
							}
							w.next_genes[i] = ng
						} else {
							w.next_genes[i] = 0
						}
					
					// Randomize directions when a new OP is written.
					// Use deterministic hash based on cell index and tick for reproducibility.
					rng_seed := hash_u32(u32(i) ~ u32(w.tick) ~ 0x9e3779b9)
					w.next_dir_moves[i]  = u8(hash_u32(rng_seed) % 8)
					w.next_dir_reads[i]  = u8(hash_u32(rng_seed ~ 0x517cc1b7) % 8)
					w.next_dir_reads2[i] = u8(hash_u32(rng_seed ~ 0x243f6a88) % 8)
					w.next_dir_writes[i] = u8(hash_u32(rng_seed ~ 0x6a09e667) % 8)

						// SWAP is much more reliable if its two read heads aren't identical.
						if new_op == .SWAP && w.next_dir_reads2[i] == w.next_dir_reads[i] {
							w.next_dir_reads2[i] = u8((int(w.next_dir_reads[i]) + 4) % 8)
						}
					w.next_idle_ticks[i] = 0 // Reset idle counter when op changes
					break
				}
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
						w.next_idle_ticks[i] = 0 // Reset idle counter when becoming IDLE
						current_val = 0.0
					} else {
						// Motility constraint:
						// If this head has *no adjacent ETHER at all*, it can never move again -> die to free space.
						open_dirs: [8]u8
						open_count: int = 0

						for di in 0..<8 {
							off3 := dir_offsets[di]
							mi := idx_clamped(w, x + off3.x, y + off3.y)
							if w.types[mi] == .ETHER {
								open_dirs[open_count] = u8(di)
								open_count += 1
							}
						}

						if open_count == 0 {
							w.next_types[i] = .ETHER
							w.next_vals[i]  = 0.0
							w.next_ops[i]   = .IDLE
							w.next_genes[i] = 0
							w.next_dir_moves[i]  = 0
							w.next_dir_reads[i]  = 0
							w.next_dir_reads2[i] = 0
							w.next_dir_writes[i] = 0
							w.next_idle_ticks[i] = 0
							continue
						}

						// If the head is "stuck" (i.e. it could afford a step, but its move direction is blocked),
						// pick a new direction that points at an ETHER neighbor.
						if w.types[ti] != .ETHER && current_val >= cfg.grow_step_cost {
							rng_seed := hash_u32(u32(i) ~ u32(w.tick) ~ u32(my_dir) ~ 0x6A09E667)
							new_dir := my_dir
							pick := int(hash_u32(rng_seed) % u32(open_count))
							new_dir = open_dirs[pick]
							// Ensure we actually change direction.
							if new_dir == my_dir {
								new_dir = u8((int(my_dir) + 1 + int(hash_u32(rng_seed ~ 0xBB67AE85) % 7)) % 8)
							}
							w.next_dir_moves[i] = new_dir
						}

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
					// Motility constraint:
					// If this walker has no adjacent ETHER, it cannot ever move again -> die to free space.
					has_open_ether := false
					for off0 in dir_offsets {
						mi := idx_clamped(w, x + off0.x, y + off0.y)
						if w.types[mi] == .ETHER {
							has_open_ether = true
							break
						}
					}
					if !has_open_ether {
						w.next_types[i] = .ETHER
						w.next_vals[i]  = 0.0
						w.next_ops[i]   = .IDLE
						w.next_genes[i] = 0
						w.next_dir_moves[i]  = 0
						w.next_dir_reads[i]  = 0
						w.next_dir_reads2[i] = 0
						w.next_dir_writes[i] = 0
						w.next_idle_ticks[i] = 0
						continue
					}

					leaving := false

					// Phase 1: SENSE (Read head)
					r_dir := w.dir_reads[i]
					r_off := dir_offsets[int(r_dir)]
					r_idx := idx_clamped(w, x + r_off.x, y + r_off.y)
					r_type := w.types[r_idx]
					r_op: Op_Code = .IDLE

					// Phase 2: REFLEX (Read Scan)
					if r_type == .ETHER {
						// When reading ETHER, keep scanning, but still allow write attempts this tick.
						// (The target-side gene decode treats ETHER as IDLE, slot 0.)
						w.next_dir_reads[i] = u8((int(r_dir) + 1) % 8) // rotate CW
					} else if r_type == .CODE {
						r_op = w.ops[r_idx]
					} else if r_type == .SOURCE {
						r_op = .IDLE
					}

					// Phase 2b: REFLEX (Write Align)
					w_dir := w.dir_writes[i]
					w_off := dir_offsets[int(w_dir)]
					w_idx := idx_clamped(w, x + w_off.x, y + w_off.y)
					w_type := w.types[w_idx]

					// Only CODE is a valid write target (SOURCE is solid but isn't meaningfully writable here).
					if w_type != .CODE {
						w.next_dir_writes[i] = u8((int(w_dir) + 7) % 8) // rotate CCW
					} else {
						// Phase 3: EXECUTION (Write-locked: write head must point to solid CODE)
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
								if w.types[cand_idx] != .CODE || w.ops[cand_idx] != .WRITE {
									continue
								}
								if !points_to_idx(w, cand_idx, w.dir_writes[cand_idx], w_idx) {
									continue
								}

								// Candidate must be write-locked (write head points to a solid CODE cell).
								c_w_dir := w.dir_writes[cand_idx]
								c_w_off := dir_offsets[int(c_w_dir)]
								c_w_idx := idx_clamped(w, cx + c_w_off.x, cy + c_w_off.y)
								if w.types[c_w_idx] != .CODE {
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
							// Gene decoding happens in target's acceptance logic
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
							w.next_dir_reads2[i] = 0
							w.next_dir_writes[i] = 0
							w.next_idle_ticks[i] = 0
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
								w.next_dir_reads2[i] = 0
								w.next_dir_writes[i] = 0
							}
						}

						// Save updated VAL (if still a CODE cell; otherwise it was overwritten above).
						if w.next_types[i] == .CODE {
							current_val = clamp_f32(current_val, cfg.energy_min, cfg.energy_max)
							w.next_vals[i] = current_val
						}
					}
				}

			// OP execution: SWAP
			if w.ops[i] == .SWAP {
				// Read two directions
				r1_dir := w.dir_reads[i]
				r2_dir := w.dir_reads2[i]
				r1_off := dir_offsets[int(r1_dir)]
				r2_off := dir_offsets[int(r2_dir)]
				r1_idx := idx_clamped(w, x + r1_off.x, y + r1_off.y)
				r2_idx := idx_clamped(w, x + r2_off.x, y + r2_off.y)
				
				// Check if the two positions are not equal (different types or different ops if both CODE)
				r1_type := w.types[r1_idx]
				r2_type := w.types[r2_idx]
				not_equal := false
				
				// Only SOURCE cells cannot be swapped (PORE op-cells can be swapped)
				can_swap := (r1_type != .SOURCE) && (r2_type != .SOURCE)
				
				if r1_type != r2_type {
					not_equal = true
				} else if r1_type == .CODE {
					// Both are CODE, compare ops
					if w.ops[r1_idx] != w.ops[r2_idx] {
						not_equal = true
					}
				}
				
				// If not equal AND has enough energy AND both can be swapped, perform swap
				if not_equal && can_swap && current_val >= cfg.swap_cost {
						// Pay the energy cost
						current_val -= cfg.swap_cost
						
						// Swap all attributes
						w.next_types[r1_idx], w.next_types[r2_idx] = w.types[r2_idx], w.types[r1_idx]
						w.next_vals[r1_idx], w.next_vals[r2_idx] = w.vals[r2_idx], w.vals[r1_idx]
						w.next_ops[r1_idx], w.next_ops[r2_idx] = w.ops[r2_idx], w.ops[r1_idx]
						w.next_genes[r1_idx], w.next_genes[r2_idx] = w.genes[r2_idx], w.genes[r1_idx]
						w.next_dir_moves[r1_idx], w.next_dir_moves[r2_idx] = w.dir_moves[r2_idx], w.dir_moves[r1_idx]
						w.next_dir_reads[r1_idx], w.next_dir_reads[r2_idx] = w.dir_reads[r2_idx], w.dir_reads[r1_idx]
						w.next_dir_reads2[r1_idx], w.next_dir_reads2[r2_idx] = w.dir_reads2[r2_idx], w.dir_reads2[r1_idx]
						w.next_dir_writes[r1_idx], w.next_dir_writes[r2_idx] = w.dir_writes[r2_idx], w.dir_writes[r1_idx]
						
						// After successful swap, move SWAP cell in its move direction (only into ETHER)
						m_dir := w.dir_moves[i]
						m_off := dir_offsets[int(m_dir)]
						m_idx := idx_clamped(w, x + m_off.x, y + m_off.y)
						
						if w.types[m_idx] == .ETHER {
							// Move SWAP cell to the ETHER position
							w.next_types[m_idx] = .CODE
							w.next_ops[m_idx] = .SWAP
							w.next_vals[m_idx] = current_val
							w.next_genes[m_idx] = w.genes[i]
							w.next_dir_moves[m_idx] = w.dir_moves[i]
							w.next_dir_reads[m_idx] = w.dir_reads[i]
							w.next_dir_reads2[m_idx] = w.dir_reads2[i]
							w.next_dir_writes[m_idx] = w.dir_writes[i]
							w.next_idle_ticks[m_idx] = 0
							
							// Current position becomes ETHER
							w.next_types[i] = .ETHER
							w.next_vals[i] = 0.0
							w.next_ops[i] = .IDLE
							w.next_genes[i] = 0
							w.next_dir_moves[i] = 0
							w.next_dir_reads[i] = 0
							w.next_dir_reads2[i] = 0
							w.next_dir_writes[i] = 0
							w.next_idle_ticks[i] = 0
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
							w.next_dir_reads2[i] = 0
							w.next_dir_writes[i] = 0
							w.next_idle_ticks[i] = 0
						}
					}

					// Save updated VAL (if still a CODE cell; otherwise it was overwritten above).
					if w.next_types[i] == .CODE {
						current_val = clamp_f32(current_val, cfg.energy_min, cfg.energy_max)
						w.next_vals[i] = current_val
					}
				}

			case .ETHER:
				// First: invasion "pull" checks.
				// Priority: WRITE walker invasion (Scanner Walker) > GROW invasion.
				invaded := false
				invader_idx := -1
				grow_collision_to_pore := false
				grow_count := 0
				grow_candidates: [8]int

				for ni in 0..<8 {
					off := dir_offsets[ni]
					nx, ny := clamp_coords(w, x + off.x, y + off.y)
					n_idx := idx_of(w, nx, ny)

					// WRITE invasion: neighbor must be locked and moving into ME.
					if w.types[n_idx] == .CODE && w.ops[n_idx] == .WRITE {
						if points_to_idx(w, n_idx, w.dir_moves[n_idx], i) {
							// Locked: write head must be pointing to a solid CODE cell (not necessarily me).
							n_r_dir := w.dir_reads[n_idx]
							n_r_off := dir_offsets[int(n_r_dir)]
							n_r_idx := idx_clamped(w, nx + n_r_off.x, ny + n_r_off.y)

							n_w_dir := w.dir_writes[n_idx]
							n_w_off := dir_offsets[int(n_w_dir)]
							n_w_idx := idx_clamped(w, nx + n_w_off.x, ny + n_w_off.y)

							// Write target must be a CODE cell (see WRITE align rule).
							is_locked := (w.types[n_w_idx] == .CODE)

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
									if w.types[cand_idx] != .CODE || w.ops[cand_idx] != .WRITE {
										continue
									}
									if !points_to_idx(w, cand_idx, w.dir_writes[cand_idx], n_w_idx) {
										continue
									}

									c_w_dir := w.dir_writes[cand_idx]
									c_w_off := dir_offsets[int(c_w_dir)]
									c_w_idx := idx_clamped(w, cx + c_w_off.x, cy + c_w_off.y)

									c_locked := (w.types[c_w_idx] == .CODE)
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

								w.next_types[i] = .CODE
								w.next_ops[i]   = .WRITE
								// Harvest: moving into Ether absorbs a fraction of the Ether's energy.
								w.next_vals[i]  = clamp_f32(w.vals[n_idx] + (w.vals[i] * cfg.write_ether_absorb_frac), cfg.energy_min, cfg.energy_max)
								w.next_genes[i] = w.genes[n_idx]
								w.next_dir_moves[i]  = w.dir_moves[n_idx]
								w.next_dir_reads[i]  = w.dir_reads[n_idx]
								w.next_dir_reads2[i] = w.dir_reads2[n_idx]
								w.next_dir_writes[i] = w.dir_writes[n_idx]
								w.next_idle_ticks[i] = 0 // Reset idle counter for newly created cell
								break // first invader wins
							}
						}
					}

					// GROW invasion (legacy)
					if w.types[n_idx] == .CODE && w.ops[n_idx] == .GROW {
						n_dir := w.dir_moves[n_idx]
						n_off := dir_offsets[int(n_dir)]
						tx, ty := clamp_coords(w, nx + n_off.x, ny + n_off.y)
						if tx == x && ty == y {
							// Only a sufficiently-energized head can invade.
							if w.vals[n_idx] >= cfg.grow_step_cost {
								if !invaded && grow_count < len(grow_candidates) {
									grow_candidates[grow_count] = n_idx
									grow_count += 1
								}
							}
						}
					}
				}

				// Resolve GROW invasion after scanning all neighbors so we can detect collisions.
				if !invaded && grow_count > 0 {
					if grow_count == 1 || cfg.grow_collision_pore_weight_8 == 0 {
						invaded = true
						invader_idx = grow_candidates[0]
					} else {
						weight := cfg.grow_collision_pore_weight_8
						if weight > 8 { weight = 8 }
						// Energy bias: only amplify existing collision->PORE chance; do not introduce when disabled.
						if weight > 0 {
							bonus_w := pore_energy_bonus_weight_8_for_val(w.vals[i], cfg)
							weight += bonus_w
							if weight > 8 { weight = 8 }
						}
						rp := hash_u32(u32(w.tick) ~ u32(i) ~ u32(grow_candidates[0]) ~ u32(grow_candidates[1]) ~ 0xC0111DE)
						if (rp % 8) < weight {
							invaded = true
							grow_collision_to_pore = true
						} else {
							invaded = true
							invader_idx = grow_candidates[0] // deterministic winner
						}
					}
				}

				if invaded {
					// WRITE already populated next_* during the scan.
					if grow_collision_to_pore {
						w.next_types[i] = .CODE
						w.next_ops[i]   = .PORE
						w.next_genes[i] = 0
						w.next_dir_moves[i]  = 0
						w.next_dir_reads[i]  = 0
						w.next_dir_reads2[i] = 0
						w.next_dir_writes[i] = 0
						w.next_idle_ticks[i] = 0
						// Preserve current ETHER energy at this location.
						w.next_vals[i]  = clamp_f32(w.vals[i], cfg.energy_min, cfg.energy_max)
					} else if w.ops[invader_idx] == .GROW {
						w.next_types[i] = .CODE
						w.next_ops[i]   = .GROW
						w.next_genes[i] = w.genes[invader_idx]
						w.next_dir_moves[i]  = w.dir_moves[invader_idx]
						w.next_dir_reads[i]  = w.dir_reads[invader_idx]
						w.next_dir_reads2[i] = w.dir_reads2[invader_idx]
						w.next_dir_writes[i] = w.dir_writes[invader_idx]
						w.next_vals[i]  = clamp_f32(w.vals[invader_idx]-cfg.grow_step_cost, cfg.energy_min, cfg.energy_max)
						w.next_idle_ticks[i] = 0 // Reset idle counter for newly created cell
					}
				} else {
					// Sample all 8 neighbors (equal weight), with CODE permeability rules.
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
					
					// Apply small depletion when ether would otherwise be unchanged (at equilibrium).
					// This allows ether to slowly decay, killing cells and making space.
					if abs_f32(new_val - current_val) < 0.01 && new_val > cfg.energy_min {
						new_val = max_f32(cfg.energy_min, new_val - cfg.ether_depletion_rate)
					}
					
					new_val = clamp_f32(new_val, cfg.energy_min, cfg.energy_max)

					w.next_types[i] = .ETHER
					w.next_ops[i]   = .IDLE
					w.next_genes[i] = 0
					w.next_dir_moves[i]  = 0
					w.next_dir_reads[i]  = 0
					w.next_dir_reads2[i] = 0
					w.next_dir_writes[i] = 0
					w.next_idle_ticks[i] = 0
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
	w.dir_reads2, w.next_dir_reads2 = w.next_dir_reads2, w.dir_reads2
	w.dir_writes, w.next_dir_writes = w.next_dir_writes, w.dir_writes
	w.idle_ticks, w.next_idle_ticks = w.next_idle_ticks, w.idle_ticks

	w.tick += 1
}


