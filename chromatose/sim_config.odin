package chromatose

// Simulation-wide tuning and constants.

ENERGY_MIN :: 0.0
ENERGY_MAX :: 512.0

// Default gene for WRITE (2 bits per observed OP):
// Gene encoding maps 2-bit index (0-3) to Op_Code: 0=IDLE, 1=GROW, 2=WRITE, 3=SWAP
// Bit layout: [7:6]=SWAP, [5:4]=WRITE, [3:2]=GROW, [1:0]=IDLE
// Default behavior:
// - read IDLE  (bits 1:0) -> write GROW  (idx 1)
// - read GROW  (bits 3:2) -> write WRITE (idx 2)
// - read WRITE (bits 5:4) -> write GROW  (idx 1)
// - read SWAP  (bits 7:6) -> write SWAP  (idx 3)
DEFAULT_WRITE_GENE :: u8((1 << 0) | (2 << 2) | (1 << 4) | (3 << 6))

Sim_Config :: struct {
	// Energy range clamp applied by rules.
	energy_min, energy_max: f32,

	// Ether diffusion relaxation coefficient (explicit).
	// Keep in [0, 1] to avoid overshoot instability.
	spread_rate: f32,

	// Directional growth tuning.
	grow_step_cost:   f32,
	grow_charge_rate: f32, // per-tick gain factor from neighborhood energy

	// WRITE tuning.
	write_cost_idle:        f32,
	write_cost_solid:       f32,
	write_move_threshold:   f32,
	write_ether_absorb_frac: f32,

	// SWAP tuning.
	swap_cost: f32,

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

	// IDLE cell transformation:
	idle_transform_ticks: u32,      // number of ticks an IDLE cell waits before randomly transforming
}

sim_config_default :: proc() -> Sim_Config {
	return Sim_Config{
		energy_min = ENERGY_MIN,
		energy_max = ENERGY_MAX,

		spread_rate = 1.0,

		grow_step_cost   = 100.0,
		grow_charge_rate = 0.1,

		write_cost_idle         = 5.0,
		write_cost_solid        = 5.0,
		write_move_threshold    = 5.0,
		write_ether_absorb_frac = 1.0,

		swap_cost               = 15.0,

		ether_depletion_rate    = 0.02,

		cell_starve_ticks       = 1024,
		cell_death_source_1_in  = 5000,

		initial_source_count    = 10,

		idle_transform_ticks    = 500,
	}
}


