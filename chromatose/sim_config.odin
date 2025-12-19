package chromatose

// Simulation-wide tuning and constants.

ENERGY_MIN :: 0.0
ENERGY_MAX :: 512.0

// Default gene for WRITE (3 bits per observed type/OP):
// Gene encoding maps 3-bit index (0-4) to action: 0=IDLE, 1=GROW, 2=WRITE, 3=SWAP, 4=PORE
// Bit layout: [14:12]=slot4, [11:9]=slot3, [8:6]=slot2, [5:3]=slot1, [2:0]=slot0
// Each slot corresponds to observed type: IDLE, GROW, WRITE, SWAP, PORE
// Default behavior:
// - read IDLE  (bits 2:0)   -> write GROW (idx 1)
// - read GROW  (bits 5:3)   -> write WRITE (idx 2)
// - read WRITE (bits 8:6)   -> write GROW (idx 1)
// - read SWAP  (bits 11:9)  -> write SWAP (idx 3)
// - read PORE  (bits 14:12) -> write PORE (idx 4)
DEFAULT_WRITE_GENE :: u16((1 << 0) | (2 << 3) | (1 << 6) | (3 << 9) | (4 << 12))

Sim_Config :: struct {
	// Energy range clamp applied by rules.
	energy_min, energy_max: f32,

	// Ether diffusion relaxation coefficient (explicit).
	// Keep in [0, 1] to avoid overshoot instability.
	spread_rate: f32,

	// Directional growth tuning.
	grow_step_cost:   f32,
	grow_charge_rate: f32, // per-tick gain factor from neighborhood energy

	// GROW wall interaction:
	// When a GROW head "hits" an IDLE wall (i.e. its move direction points at an IDLE CODE cell),
	// that wall cell has a small chance to convert into a PORE.
	// Set to 0 to disable.
	grow_hit_idle_to_pore_1_in: u32,

	// GROW collision interaction:
	// When 2+ GROW heads contend for the same ETHER cell in the same tick,
	// the destination becomes a PORE with probability weight/8 (deterministic hash).
	// Set to 0 to disable.
	grow_collision_pore_weight_8: u32,

	// Energy bias for PORE conversions:
	// For probabilistic "turn into PORE" events, we optionally add an extra bonus
	// proportional to the *target cell's* normalized energy:
	//
	//   bonus_weight_8 = round(clamp(VAL/energy_max, 0, 1) * pore_energy_bonus_weight_8)
	//
	// For weight/8 events, this bonus is added (capped to 8). For 1-in-N events,
	// an additional independent bonus check is performed using bonus_weight_8/8.
	//
	// Range: 0..8
	// - 0 => no energy bias (preserve previous behavior)
	// - 8 => very strong bias (high-energy targets almost always become PORE when eligible)
	pore_energy_bonus_weight_8: u32,

	// High-energy "pressure" against confinement:
	// If a solid IDLE wall is adjacent to very high energy (e.g. a SOURCE at energy_max),
	// it can rupture, either dissolving back into ETHER or becoming a PORE (permeable wall).
	//
	// - wall_overheat_min_neighbor_val: minimum neighbor energy required before any rupture chance.
	// - wall_overheat_break_weight_8: base rupture chance in units of weight/8 at full pressure.
	// - wall_overheat_pore_weight_8: conditional chance (weight/8) that a rupture becomes PORE
	//   rather than ETHER.
	wall_overheat_min_neighbor_val: f32,
	wall_overheat_break_weight_8:    u32,
	wall_overheat_pore_weight_8:     u32,

	// PORE lifespan:
	// PORE cells are permeable walls; to avoid permanent "holes", they can decay back into
	// a random non-PORE op after some time.
	//
	// Lifespan is deterministic per-cell:
	//   lifespan = pore_lifespan_ticks + hash(i)% (pore_lifespan_jitter_ticks+1)
	//
	// Set pore_lifespan_ticks to 0 to disable.
	pore_lifespan_ticks:        u32,
	pore_lifespan_jitter_ticks: u32,

	// WRITE tuning.
	write_cost_idle:        f32,
	write_cost_solid:       f32,
	write_move_threshold:   f32,
	write_ether_absorb_frac: f32,

	// SWAP tuning.
	swap_cost: f32,

	// Gene decode tuning (WRITE):
	// When a gene slot contains an out-of-range 3-bit value (5..7), we map it back into
	// a valid action deterministically. This parameter biases that mapping toward PORE.
	//
	// Range: 0..8
	// - 0 => never map junk DNA to PORE
	// - 8 => always map junk DNA to PORE
	write_junk_pore_weight_8: u32,

	// Evolution hooks (WRITE):
	// Optional, deterministic novelty injection.
	// - write_action_mutation_1_in: mutates the decoded action (0..4) on successful writes.
	// - write_gene_mutation_1_in: mutates the propagated gene when a WRITE writes a WRITE.
	// Set to 0 to disable.
	write_action_mutation_1_in: u32,
	write_gene_mutation_1_in:   u32,

	// Wall-breaking bias (WRITE):
	// On a successful write, optionally override the decoded action to PORE
	// depending on the *current* target op. This is a coarse "break walls" lever.
	//
	// Range: 0..8
	// Probability = weight/8 each successful write attempt (deterministic hash).
	// Defaults are 0 to preserve existing behavior.
	write_break_idle_to_pore_weight_8:  u32, // when target op == IDLE
	write_break_solid_to_pore_weight_8: u32, // when target op != IDLE && target op != PORE

	// Ether depletion: small decay when ether is at equilibrium (unchanged).
	ether_depletion_rate: f32,

	// Starvation:
	// If a CELL is not adjacent to any ETHER with VAL > 0 (or a SOURCE),
	// its VAL drains toward 0. When VAL reaches 0, the CELL dies and becomes
	// either ETHER(VAL=0) or (rarely) SOURCE.
	cell_starve_ticks: int,         // time to drain ~ENERGY_MAX to 0 (linear)
	cell_death_source_1_in: u32,    // probability denominator (e.g. 5000 => 1/5000)

	// Initialization:
	initial_source_count: int,      // number of SOURCE cells to place during world_seed
	// SOURCE controls:
	// - source_min_count: ensure at least this many SOURCE cells exist (0 disables).
	//   If the count drops below this floor, new sources are spawned into ETHER cells deterministically.
	// - source_max_count: hard cap on number of SOURCE cells in the world (0 disables cap).
	//   If exceeded, the oldest sources (by age) are converted into ETHER to restore the cap.
	// - source_lifespan_ticks: after this many ticks, a SOURCE decays into ETHER (0 disables lifespan).
	// - source_lifespan_jitter_ticks: deterministic per-source age offset in [0..jitter] applied at creation
	//   (0 disables). This prevents all initial sources from expiring on the same tick.
	source_min_count:            u32,
	source_max_count:            u32,
	source_lifespan_ticks:       u32,
	source_lifespan_jitter_ticks: u32,

	// IDLE cell transformation:
	idle_transform_ticks: u32,      // number of ticks an IDLE cell waits before randomly transforming
}

sim_config_default :: proc() -> Sim_Config {
	return Sim_Config{
		energy_min = ENERGY_MIN,
		energy_max = ENERGY_MAX,

		spread_rate = 1.0,

		grow_step_cost   = 10.0,
		grow_charge_rate = 0.1,

		grow_hit_idle_to_pore_1_in    = 64, // small chance
		grow_collision_pore_weight_8  = 6,  // 50% on collisions
		pore_energy_bonus_weight_8    = 2,  // modest energy bias toward becoming PORE

		wall_overheat_min_neighbor_val = 400.0,
		wall_overheat_break_weight_8   = 3, // ~3/8 per tick when adjacent to SOURCE
		wall_overheat_pore_weight_8    = 5, // ~5/8 of ruptures become PORE; else ETHER

		pore_lifespan_ticks        = 240,
		pore_lifespan_jitter_ticks = 120,

		write_cost_idle         = 5.0,
		write_cost_solid        = 5.0,
		write_move_threshold    = 5.0,
		write_ether_absorb_frac = 1.0,

		swap_cost               = 10.0,

		write_junk_pore_weight_8 = 3, // 75% PORE from junk DNA (WRITE-driven)

		write_action_mutation_1_in = 2,
		write_gene_mutation_1_in   = 2,

		write_break_idle_to_pore_weight_8  = 2,
		write_break_solid_to_pore_weight_8 = 2,

		ether_depletion_rate    = 0.02,

		cell_starve_ticks       = 512,
		cell_death_source_1_in  = 5000,

		initial_source_count    = 10,
		source_min_count            = 10,
		source_max_count            = 16,
		source_lifespan_ticks       = 2048,
		source_lifespan_jitter_ticks = 512,

		idle_transform_ticks    = 100,
	}
}


