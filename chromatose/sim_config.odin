package chromatose

// Simulation-wide tuning and constants.

ENERGY_MIN :: 0.0
ENERGY_MAX :: 512.0

// Default gene for WRITE (2 bits per observed OP):
// - read IDLE   -> write GROW
// - read GROW   -> write WRITE
// - read WRITE  -> write GROW
// Note: Op_Code=1 is unused.
DEFAULT_WRITE_GENE :: u8((2 << 0) | (3 << 4) | (2 << 6))

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

	// Starvation:
	// If a CELL is not adjacent to any ETHER with VAL > 0 (or a SOURCE),
	// its VAL drains toward 0. When VAL reaches 0, the CELL dies and becomes
	// either ETHER(VAL=0) or (rarely) SOURCE.
	cell_starve_ticks: int,         // time to drain ~ENERGY_MAX to 0 (linear)
	cell_death_source_1_in: u32,    // probability denominator (e.g. 10000 => 1/10000)
}

sim_config_default :: proc() -> Sim_Config {
	return Sim_Config{
		energy_min = ENERGY_MIN,
		energy_max = ENERGY_MAX,

		spread_rate = 1.0,

		grow_step_cost   = 100.0,
		grow_charge_rate = 0.1,

		write_cost_idle         = 10.0,
		write_cost_solid        = 100.0,
		write_move_threshold    = 50.0,
		write_ether_absorb_frac = 0.5,

		cell_starve_ticks       = 2048,
		cell_death_source_1_in  = 10000,
	}
}


