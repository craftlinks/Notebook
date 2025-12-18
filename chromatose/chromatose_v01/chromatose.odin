package chromatose

import rl   "vendor:raylib"
import rand "core:math/rand"

WINDOW_W :: 1024
WINDOW_H :: 1024

// Render a smaller simulation into a texture, then scale it up.
// This makes activity visible without needing a huge monitor.
SIM_W :: 256
SIM_H :: 256

// "Species" count: organism colors are restricted to IDs 1..SPECIES_COUNT.
// Keep this small (2..4) to encourage cohesive interaction/competition.
SPECIES_COUNT :: u8(4)

Instruction :: enum u8 {
	ETHER = 0,
	WIRE,
	WALL,
	DIODE_N,
	DIODE_S,
	DIODE_E,
	DIODE_W,
	CAP,
	WRITE,
	INJECT,
	PORE,
	PUMP,
	CLAIM,
}

Help_Mode :: enum u8 {
	OFF = 0,
	COMPACT,
	FULL,
}

// Debug/UI glyphs for showing per-cell instructions.
// (Matches enum layout: 0..12; also matches WRITE encoding `VAL & 0x0F`.)
OP_GLYPH :: [13]cstring{
	"~", "|", "=", "^", "v", "<", ">", "c", "w", "i", "p", "u", "l",
}

// --- Tuning Constants (Chromatose 2.0) ---
FIRING_THRESHOLD            :: u8(8)  // Minimum energy to emit signals (organisms)
REFRACTORY_PERIOD           :: u8(1)   // Ticks to rest after firing
// Ether decay is intentionally strong to avoid "background charge-up" and keep the soup dynamic.
ETHER_DECAY_SHIFT           :: u8(1)   // Ether output = Input >> shift
CROSS_COLOR_WRITE_THRESHOLD :: u8(10) // Strength needed to write/inject on enemy internals
WALL_WRITE_THRESHOLD        :: u8(10) // Strength needed to write/inject on enemy walls
CLAIM_TAKEOVER_THRESHOLD    :: u8(10) // Strength needed to CLAIM an enemy cell

// --- Ether-as-food tuning ---
// Ether is sustained by a small ambient floor (acts like an infinite bath),
// and can be drained by adjacent organism PORE cells.
ETHER_AMBIENT        :: u8(40)
ETHER_FEED_MAX_TOTAL :: u8(40) // Max energy an Ether cell can donate per tick (split across adjacent POREs)

// --- Constant turmoil / temperature ---
// External driving force to prevent the system from falling into a static attractor.
// Implemented as random energy injected into Ether each tick (added to pending_energy).
TURMOIL_EVENTS_PER_TICK :: int((SIM_W * SIM_H) / 128) // ~128 at 256x256
TURMOIL_MAX_DELTA       :: u8(40)  // injected energy per event (1..max)
TURMOIL_ETHER_CAP       :: u8(40)  // don't inject into Ether that's already bright (prevents whiteout)

// --- Evolution: instruction mutation (novelty injection) ---
// When enabled, a small fraction of successful WRITE commits will mutate the opcode being written.
// This creates new behavior without needing a separate "genome" representation.
WRITE_MUTATION_1_OVER :: u32(90) // Mutation probability = 1 / N per successful WRITE commit (0 disables)

// Controlled writer replication:
// A WRITE cell can occasionally write a new WRITE into a neighbor (instead of painting its program opcode),
// so growth fronts can *move* and compete without exponential blow-up.
WRITE_REPLICATE_1_OVER :: u32(4) // Probability = 1/N per WRITE emission (0 disables)

// Recycling: prevent permanent frozen worlds by slowly dissolving inactive organism tissue back into Ether.
// Note: tick() runs multiple times per frame, so 200 ticks is only a couple seconds of real time.
ORGANISM_STALE_TO_ETHER_TICKS :: u8(10)

// Weighted mutation target pool. Repeats increase abundance.
// Biased toward "active" ops that create richer time dynamics and structure changes.
MUTATION_POOL :: [24]Instruction{
	.WRITE, .WRITE, .WRITE, .WRITE,
	.INJECT, .INJECT, .INJECT,
	.PORE, .PORE,
	.CAP, .CAP, .CAP,
	.DIODE_N, .DIODE_S, .DIODE_E, .DIODE_W,
	.PUMP, .PUMP,
	.CLAIM,
	.WIRE, .WIRE,
	.WALL,
	// extra bias slots
	.CAP, .WRITE,
}

mutate_instruction :: proc(op: Instruction) -> Instruction {
	// Biased mutation: pick from a weighted pool (no .ETHER).
	// Retry a couple times to guarantee a change; fallback to a deterministic "next" op if needed.
	pool := MUTATION_POOL
	for _ in 0..<3 {
		mut := pool[rand.uint32() % u32(len(pool))]
		if mut != op {
			return mut
		}
	}
	// Fallback: deterministic step within non-ETHER range.
	non_ether_count := u32(len(Instruction)) - 1
	if non_ether_count <= 1 {
		return op
	}
	code := u8(1) + u8((u32(op)-1 + 1) % non_ether_count)
	return Instruction(code)
}

World :: struct {
	width, height: int,

	// Current state (read-only during Phase 1)
	ops:    []Instruction,
	vals:   []u8,
	colors: []u8, // 0 = Ether, 1..SPECIES_COUNT organism species ids
	refractory: []u8, // 0 = ready; >0 = cooldown ticks (organisms only)

	// CAP storage: adds an extra 1-tick delay (store -> output) compared to wires.
	cap_store:      []u8,

	// Next state (write-only during Phase 2)
	next_ops:    []Instruction,
	next_vals:   []u8,
	next_colors: []u8,
	next_refractory: []u8,
	next_cap_store: []u8,

	// Mailboxes (Phase 1 writes, Phase 2 reads)
	pending_energy: []u16,
	pending_drain:  []u16, // Ether donation amount this tick (Phase 1 writes, Phase 2 reads)

	// CLAIM mailbox (resolve by strength, deterministic tiebreak)
	pending_claim_color:    []u8,
	pending_claim_strength: []u8,

	// WRITE mailbox (resolve by strength, deterministic tiebreak)
	pending_write_op:       []Instruction,
	pending_write_color:    []u8,
	pending_write_strength: []u8,
	// For WRITE -> WRITE propagation, store the writer's "program" (target opcode) separately from energy.
	// We reuse `cap_store` as the per-cell program storage for .WRITE cells.
	pending_write_prog:     []u8,

	// INJECT mailbox (resolve by strength, deterministic tiebreak)
	pending_inject_val:      []u8,
	pending_inject_color:    []u8,
	pending_inject_strength: []u8,
}

idx_of :: proc(world: ^World, x, y: int) -> int {
	return y*world.width + x
}

in_bounds :: proc(world: ^World, x, y: int) -> bool {
	return x >= 0 && x < world.width && y >= 0 && y < world.height
}

world_make :: proc(width, height: int) -> World {
	assert(width > 0 && height > 0)
	n := width * height

	w := World{
		width  = width,
		height = height,

		ops    = make([]Instruction, n),
		vals   = make([]u8, n),
		colors = make([]u8, n),
		refractory = make([]u8, n),
		cap_store = make([]u8, n),

		next_ops    = make([]Instruction, n),
		next_vals   = make([]u8, n),
		next_colors = make([]u8, n),
		next_refractory = make([]u8, n),
		next_cap_store = make([]u8, n),

		pending_energy = make([]u16, n),
		pending_drain  = make([]u16, n),

		pending_claim_color    = make([]u8, n),
		pending_claim_strength = make([]u8, n),

		pending_write_op       = make([]Instruction, n),
		pending_write_color    = make([]u8, n),
		pending_write_strength = make([]u8, n),
		pending_write_prog     = make([]u8, n),

		pending_inject_val      = make([]u8, n),
		pending_inject_color    = make([]u8, n),
		pending_inject_strength = make([]u8, n),
	}

	// Default universe is Ether
	for i in 0..<n {
		w.ops[i] = .ETHER
		w.colors[i] = 0
		w.vals[i] = 0
		w.refractory[i] = 0
		w.cap_store[i] = 0
	}

	return w
}

world_clear :: proc(world: ^World) {
	n := world.width * world.height
	for i in 0..<n {
		world.ops[i] = .ETHER
		world.colors[i] = 0
		world.vals[i] = 0
		world.refractory[i] = 0
		world.cap_store[i] = 0
	}
}

world_seed_noise :: proc(world: ^World, amount: int, max_val: u8) {
	n := world.width * world.height
	if n == 0 || amount <= 0 {
		return
	}

	for i in 0..<amount {
		idx := int(rand.uint32() % u32(n))
		// Noise seeding rule:
		// - values < 32 become Ether
		// - values >= 32 map to a non-Ether instruction (never selects .ETHER)
		v := u8(rand.uint32() % (u32(max_val) + 1))
		world.vals[idx] = v
		op: Instruction
		if v < 230 {
			op = .ETHER
		} else {
			non_ether_count := u32(len(Instruction)) - 1 // excludes .ETHER at index 0
			code := u8(1) + u8((u32(v) - 230) % non_ether_count)
			op = Instruction(code)
		}
		world.ops[idx] = op
		if op == .ETHER {
			world.colors[idx] = 0
		} else {
			// Restrict organism colors to a small species set for clearer dynamics.
			world.colors[idx] = u8(1) + u8(rand.uint32() % u32(SPECIES_COUNT))
		}
		world.refractory[idx] = 0
		world.cap_store[idx] = 0
	}
}

// Ether-only noise (background speckle) without creating organisms or changing OPs.
// Useful for "warm soup" / slight texture in the field.
world_seed_ether_speckle :: proc(world: ^World, amount: int, max_val: u8) {
	n := world.width * world.height
	if n == 0 || amount <= 0 {
		return
	}
	for _ in 0..<amount {
		idx := int(rand.uint32() % u32(n))
		world.ops[idx] = .ETHER
		world.colors[idx] = 0
		world.vals[idx] = u8(rand.uint32() % (u32(max_val) + 1))
		world.refractory[idx] = 0
		world.cap_store[idx] = 0
	}
}

// Metabolic seed:
// - Mostly Ether background (food field).
// - A few contiguous organism blobs with boundary POREs (feed) and boundary WRITEs (growth into Ether).
// This is intended to actually demonstrate OP overwrites and "evolutionary opportunity"
// (as opposed to fully iid per-cell noise, which rarely forms coherent organisms).
world_seed_metabolic_noise :: proc(world: ^World) {
	world_clear(world)

	// Background Ether texture / energy.
	// Slightly richer initial soup so activity starts immediately (without just saturating to flat gray).
	world_seed_ether_speckle(world, amount = (world.width*world.height), max_val = 64)

	// A few organisms.
	blob_count := (world.width * world.height) / 1100
	if blob_count < 8 { blob_count = 8 }
	if blob_count > 28 { blob_count = 28 }

	for _ in 0..<blob_count {
		// Keep a margin so blobs don't clip out of bounds too often.
		cx := 6 + int(rand.uint32() % u32(world.width-12))
		cy := 6 + int(rand.uint32() % u32(world.height-12))
		r  := 4 + int(rand.uint32() % 9) // 4..12

		color := u8(1) + u8(rand.uint32() % u32(SPECIES_COUNT))

		// Fill blob as WIRE/CAP tissue.
		for dy in -r..=r {
			for dx in -r..=r {
				if dx*dx + dy*dy > r*r {
					continue
				}
				x := cx + dx
				y := cy + dy
				if !in_bounds(world, x, y) {
					continue
				}

				op := Instruction.WIRE
				// More CAPs -> richer timing (delay-lines / oscillators).
				if (rand.uint32() % 7) == 0 {
					op = .CAP
				}

				i := idx_of(world, x, y)
				world.ops[i] = op
				world.colors[i] = color
				world.vals[i] = 0
				world.refractory[i] = 0
				world.cap_store[i] = 0
			}
		}

		// Add boundary mouths + active tips to kickstart dynamics.
		// Put them on (approx) perimeter so they touch Ether and connect to interior of same color.
		tips := 10 + int(rand.uint32()%12) // 10..21
		for _ in 0..<tips {
			// Random direction around the circle.
			// (Cheap integer "angle": pick dx,dy then normalize-ish by scaling to radius.)
			dx := int(rand.uint32()%u32(2*r+1)) - r
			dy := int(rand.uint32()%u32(2*r+1)) - r
			if dx == 0 && dy == 0 {
				dx = r
			}
			// Snap to boundary-ish.
			// Prefer larger magnitude to push outward.
			if abs_int(dx) < abs_int(dy) {
				den := abs_int(dy)
				if den < 1 { den = 1 }
				dx = (dx * r) / den
			} else {
				den := abs_int(dx)
				if den < 1 { den = 1 }
				dy = (dy * r) / den
			}

			x := cx + dx
			y := cy + dy
			if !in_bounds(world, x, y) {
				continue
			}
			i := idx_of(world, x, y)

			// Ensure there is Ether right outside this boundary point so PORE can feed and WRITE can grow.
			// Use the (dx,dy) direction to pick the "outside" cell.
			sdx := 0
			sdy := 0
			if abs_int(dx) >= abs_int(dy) {
				sdx = 1
				if dx < 0 { sdx = -1 }
			} else {
				sdy = 1
				if dy < 0 { sdy = -1 }
			}
			ox := x + sdx
			oy := y + sdy
			if in_bounds(world, ox, oy) {
				oi := idx_of(world, ox, oy)
				world.ops[oi] = .ETHER
				world.colors[oi] = 0
				world.vals[oi] = u8(12 + (rand.uint32() % 28)) // 12..39
				world.refractory[oi] = 0
				world.cap_store[oi] = 0
			}

			// Weighted boundary specialization: increase abundance of "interesting" ops.
			roll := rand.uint32() % 100
			if roll < 45 {
				// PORE: feeding mouth
				world.ops[i] = .PORE
				world.colors[i] = color
				world.vals[i] = 0
				world.refractory[i] = 0
				world.cap_store[i] = 0
			} else if roll < 60 {
				// WRITE: growth / structure mutation
				world.ops[i] = .WRITE
				world.colors[i] = color
				// Strong write; program (target opcode) is stored in cap_store (VAL is energy).
				target := Instruction.CAP
				t2 := rand.uint32() % 10
				switch t2 {
				case 0, 1, 2, 3: target = .WIRE
				case 4, 5:       target = .CAP
				case 6:          target = .INJECT
				case 7:          target = .PORE
				case 8:          target = .DIODE_E
				case 9:          target = .PUMP
				case:
				}
				world.cap_store[i] = u8(target)
				world.vals[i] = u8(140 + (rand.uint32() % 80)) // enough energy to act without immediate saturation
				world.refractory[i] = 0
				// cap_store already set to the program above
			} else if roll < 75 {
				// INJECT: excitation source (creates waves + timing)
				world.ops[i] = .INJECT
				world.colors[i] = color
				world.vals[i] = u8(160 + (rand.uint32() % 80)) // 160..239
				world.refractory[i] = 0
				world.cap_store[i] = 0
			} else if roll < 86 {
				// CAP: delay element on the boundary
				world.ops[i] = .CAP
				world.colors[i] = color
				world.vals[i] = 0
				world.refractory[i] = 0
				world.cap_store[i] = 0
			} else if roll < 94 {
				// DIODES: directionality -> richer circuits
				world.ops[i] = Instruction(u8(Instruction.DIODE_N) + u8(rand.uint32()%4))
				world.colors[i] = color
				world.vals[i] = 0
				world.refractory[i] = 0
				world.cap_store[i] = 0
			} else if roll < 97 {
				// PUMP: cross-color permeability forcing (helps interactions)
				world.ops[i] = .PUMP
				world.colors[i] = color
				world.vals[i] = 0
				world.refractory[i] = 0
				world.cap_store[i] = 0
			} else {
				// CLAIM: occasional aggressive expansion
				world.ops[i] = .CLAIM
				world.colors[i] = color
				world.vals[i] = u8(32 + (rand.uint32() % 80)) // enough to act sometimes
				world.refractory[i] = 0
				world.cap_store[i] = 0
			}
		}
	}
}

abs_int :: proc(x: int) -> int {
	if x < 0 {
		return -x
	}
	return x
}

Seed_Preset :: enum u8 {
	NOISE_RANDOM,
	NOISE_METABOLIC,
}

seed_preset_name :: proc(p: Seed_Preset) -> string {
	#partial switch p {
	case .NOISE_RANDOM:
		return "noise: random ops/colors"
	case .NOISE_METABOLIC:
		return "noise: metabolic (pores + growth tips)"
	}
	return "unknown"
}

seed_preset_next :: proc(p: Seed_Preset) -> Seed_Preset {
	v := u8(p) + 1
	if v >= u8(Seed_Preset.NOISE_METABOLIC) + 1 {
		v = 0
	}
	return Seed_Preset(v)
}

world_set_cell :: proc(world: ^World, x, y: int, op: Instruction, color: u8, val: u8) {
	if !in_bounds(world, x, y) {
		return
	}
	i := idx_of(world, x, y)
	world.ops[i] = op
	world.colors[i] = color
	world.vals[i] = val
	world.refractory[i] = 0
	world.cap_store[i] = 0
}

world_seed_preset :: proc(world: ^World, p: Seed_Preset) {
	#partial switch p {
	case .NOISE_RANDOM:
		world_clear(world)
		world_seed_noise(world, amount = (world.width*world.height), max_val = 255)
	case .NOISE_METABOLIC:
		world_seed_metabolic_noise(world)
	}
}

mailbox_clear :: proc(world: ^World) {
	n := world.width * world.height
	for i in 0..<n {
		world.pending_energy[i] = 0
		world.pending_drain[i] = 0
		world.pending_claim_color[i] = 0
		world.pending_claim_strength[i] = 0
		world.pending_write_op[i] = .ETHER
		world.pending_write_color[i] = 0
		world.pending_write_strength[i] = 0
		world.pending_write_prog[i] = 0
		world.pending_inject_val[i] = 0
		world.pending_inject_color[i] = 0
		world.pending_inject_strength[i] = 0
	}
}

min_u16 :: proc(a, b: u16) -> u16 {
	if a < b {
		return a
	}
	return b
}

sub_floor_u16 :: proc(a, b: u16) -> u16 {
	if b >= a {
		return 0
	}
	return a - b
}

apply_turmoil :: proc(world: ^World) {
	n := world.width * world.height
	if n <= 0 {
		return
	}
	events := TURMOIL_EVENTS_PER_TICK
	if events <= 0 {
		return
	}

	for _ in 0..<events {
		idx := int(rand.uint32() % u32(n))
		// Drive only Ether; organisms must metabolize/transport.
		if world.colors[idx] == 0 && world.vals[idx] < TURMOIL_ETHER_CAP {
			add := u16(1 + (rand.uint32() % u32(TURMOIL_MAX_DELTA)))
			world.pending_energy[idx] += add
		}
	}
}

mailbox_try_claim :: proc(world: ^World, target_idx: int, color: u8, strength: u8) {
	if color == 0 || strength == 0 {
		return
	}
	cur_strength := world.pending_claim_strength[target_idx]
	cur_color := world.pending_claim_color[target_idx]

	// Strength wins; deterministic tiebreak: higher color id wins.
	if strength > cur_strength || (strength == cur_strength && color > cur_color) {
		world.pending_claim_strength[target_idx] = strength
		world.pending_claim_color[target_idx] = color
	}
}

mailbox_try_write :: proc(world: ^World, target_idx: int, op: Instruction, color: u8, strength: u8, prog: u8) {
	if strength == 0 {
		return
	}
	cur_strength := world.pending_write_strength[target_idx]
	cur_op := world.pending_write_op[target_idx]
	cur_color := world.pending_write_color[target_idx]
	cur_prog := world.pending_write_prog[target_idx]

	// Strength wins; deterministic tiebreak: higher color id wins, then higher op enum.
	if strength > cur_strength ||
	   (strength == cur_strength && (color > cur_color || (color == cur_color && (op > cur_op || (op == cur_op && prog > cur_prog))))) {
		world.pending_write_strength[target_idx] = strength
		world.pending_write_op[target_idx] = op
		world.pending_write_color[target_idx] = color
		world.pending_write_prog[target_idx] = prog
	}
}

mailbox_try_inject :: proc(world: ^World, target_idx: int, val: u8, color: u8, strength: u8) {
	if strength == 0 {
		return
	}
	cur_strength := world.pending_inject_strength[target_idx]
	cur_val := world.pending_inject_val[target_idx]
	cur_color := world.pending_inject_color[target_idx]

	// Strength wins; deterministic tiebreak: higher color id wins, then higher injected val.
	if strength > cur_strength ||
	   (strength == cur_strength && (color > cur_color || (color == cur_color && val > cur_val))) {
		world.pending_inject_strength[target_idx] = strength
		world.pending_inject_val[target_idx] = val
		world.pending_inject_color[target_idx] = color
	}
}

clamp_u16_to_u8 :: proc(x: u16) -> u8 {
	if x >= 255 {
		return 255
	}
	return u8(x)
}

// WRITE instruction encoding:
// - `VAL` is both the write strength and the "data" selecting the instruction.
// - Low 4 bits select the opcode (0..12 match the enum layout).
write_op_from_val :: proc(v: u8) -> Instruction {
	code := v & 0x0F
	if code <= u8(Instruction.CLAIM) {
		return Instruction(code)
	}
	return .WIRE
}

// Direction check helpers.
// `dx,dy` is the vector from source cell -> destination cell.
can_emit_towards :: proc(op: Instruction, dx, dy: int) -> bool {
	#partial switch op {
	case .DIODE_N:
		return dx == 0 && dy == -1
	case .DIODE_S:
		return dx == 0 && dy == 1
	case .DIODE_E:
		return dx == 1 && dy == 0
	case .DIODE_W:
		return dx == -1 && dy == 0
	case:
		return true
	}
}

can_receive_from :: proc(op: Instruction, dx, dy: int) -> bool {
	// Strict bidirectional blocking for diodes: the cell only accepts flow in its allowed direction.
	#partial switch op {
	case .DIODE_N:
		return dx == 0 && dy == -1
	case .DIODE_S:
		return dx == 0 && dy == 1
	case .DIODE_E:
		return dx == 1 && dy == 0
	case .DIODE_W:
		return dx == -1 && dy == 0
	case:
		return true
	}
}

// Energy permeability rules (Chromatose 2.0):
// - Same color: always permeable (Cohesion).
// - Ether (color 0): permeable to everyone (The Soup), BUT POREs must not leak outward into Ether.
// - Cross-color: blocked unless:
//    - source is PUMP (forces out), or
//    - destination is PORE (inbound-only sensor).
can_pass_energy :: proc(src_op: Instruction, src_color: u8, dst_op: Instruction, dst_color: u8) -> bool {
	if src_color == dst_color {
		return true
	}

	// PORE is inbound-only across colors: never leaks outward (including into Ether).
	if src_op == .PORE {
		return false
	}

	// Ether is permeable to everyone (except PORE outbound above).
	if src_color == 0 || dst_color == 0 {
		return true
	}

	// PUMP forces energy out to foreign colors.
	if src_op == .PUMP {
		return true
	}

	// PORE allows energy in from foreign colors.
	if dst_op == .PORE {
		return true
	}

	// Otherwise, hull integrity blocks flow.
	return false
}

write_threshold_for_target :: proc(src_color: u8, dst_op: Instruction, dst_color: u8) -> u8 {
	if dst_color == 0 || dst_color == src_color {
		return 0
	}
	if dst_op == .WALL {
		return WALL_WRITE_THRESHOLD
	}
	return CROSS_COLOR_WRITE_THRESHOLD
}

// Phase 1: Read current arrays -> write mailboxes.
interaction_phase :: proc(world: ^World) {
	w := world.width
	h := world.height

	for y in 0..<h {
		row := y*w
		for x in 0..<w {
			i := row + x

			op := world.ops[i]
			val := world.vals[i]
			color := world.colors[i]
			refr := world.refractory[i]

			// Walls are inert.
			if op == .WALL {
				continue
			}

			// --- Feeding: Ether -> adjacent organism PORE cells ---
			// Organisms gain energy by placing PORE "mouths" next to Ether.
			// Ether itself is sustained by a small ambient baseline (see resolution_phase).
			if color == 0 && op == .ETHER && val != 0 {
				n_pores := 0

				if x > 0 {
					j := i - 1
					if world.ops[j] == .PORE && world.colors[j] != 0 && world.refractory[j] == 0 {
						n_pores += 1
					}
				}
				if x+1 < w {
					j := i + 1
					if world.ops[j] == .PORE && world.colors[j] != 0 && world.refractory[j] == 0 {
						n_pores += 1
					}
				}
				if y > 0 {
					j := i - w
					if world.ops[j] == .PORE && world.colors[j] != 0 && world.refractory[j] == 0 {
						n_pores += 1
					}
				}
				if y+1 < h {
					j := i + w
					if world.ops[j] == .PORE && world.colors[j] != 0 && world.refractory[j] == 0 {
						n_pores += 1
					}
				}

				if n_pores != 0 {
					drain_total := min_u16(u16(val), u16(ETHER_FEED_MAX_TOTAL))
					// Distribute without truncating to zero at low drain_total.
					share := drain_total / u16(n_pores)
					rem  := int(drain_total % u16(n_pores))

					if x > 0 {
						j := i - 1
						if world.ops[j] == .PORE && world.colors[j] != 0 && world.refractory[j] == 0 {
							give := share
							if rem > 0 { give += 1; rem -= 1 }
							if give != 0 {
								world.pending_energy[j] += give
								world.pending_drain[i]  += give
							}
						}
					}
					if x+1 < w {
						j := i + 1
						if world.ops[j] == .PORE && world.colors[j] != 0 && world.refractory[j] == 0 {
							give := share
							if rem > 0 { give += 1; rem -= 1 }
							if give != 0 {
								world.pending_energy[j] += give
								world.pending_drain[i]  += give
							}
						}
					}
					if y > 0 {
						j := i - w
						if world.ops[j] == .PORE && world.colors[j] != 0 && world.refractory[j] == 0 {
							give := share
							if rem > 0 { give += 1; rem -= 1 }
							if give != 0 {
								world.pending_energy[j] += give
								world.pending_drain[i]  += give
							}
						}
					}
					if y+1 < h {
						j := i + w
						if world.ops[j] == .PORE && world.colors[j] != 0 && world.refractory[j] == 0 {
							give := share
							if rem > 0 { give += 1; rem -= 1 }
							if give != 0 {
								world.pending_energy[j] += give
								world.pending_drain[i]  += give
							}
						}
					}
				}
			}

			// --- Energy emission (Excitable Medium) ---
			should_fire := false
			if color == 0 {
				// Ether is passive/resistive: always accepts and emits (dissipative).
				should_fire = val != 0
			} else {
				// Organisms conduct at any non-zero energy when not refractory.
				// The FIRING_THRESHOLD still matters for "spikes" (full-strength emission + refractory)
				// and for WRITE/INJECT/CLAIM intent broadcasts below.
				should_fire = (refr == 0 && val != 0)
			}

			if should_fire {
				out_total: u16 = 0
				if op == .ETHER {
					out_total = u16(val >> ETHER_DECAY_SHIFT)
				} else if color != 0 && val < FIRING_THRESHOLD {
					// Sub-threshold conduction: weaker bleed so organisms can transport "food" internally.
					out_total = u16(val >> 1)
				} else {
					out_total = u16(val)
				}

				if out_total != 0 {
					// Count valid receivers (4-neighborhood) to split energy.
					n_count := 0

					if x > 0 {
						j := i - 1
						dst_op := world.ops[j]
						dst_color := world.colors[j]
						dst_refr := world.refractory[j]

						dst_receptive := dst_op != .WALL && ((dst_color == 0) || (dst_refr == 0))
						if dst_receptive &&
						   can_emit_towards(op, -1, 0) &&
						   can_receive_from(dst_op, -1, 0) &&
						   can_pass_energy(op, color, dst_op, dst_color) &&
						   (op != .PUMP || dst_color != color) {
							n_count += 1
						}
					}
					if x+1 < w {
						j := i + 1
						dst_op := world.ops[j]
						dst_color := world.colors[j]
						dst_refr := world.refractory[j]

						dst_receptive := dst_op != .WALL && ((dst_color == 0) || (dst_refr == 0))
						if dst_receptive &&
						   can_emit_towards(op, 1, 0) &&
						   can_receive_from(dst_op, 1, 0) &&
						   can_pass_energy(op, color, dst_op, dst_color) &&
						   (op != .PUMP || dst_color != color) {
							n_count += 1
						}
					}
					if y > 0 {
						j := i - w
						dst_op := world.ops[j]
						dst_color := world.colors[j]
						dst_refr := world.refractory[j]

						dst_receptive := dst_op != .WALL && ((dst_color == 0) || (dst_refr == 0))
						if dst_receptive &&
						   can_emit_towards(op, 0, -1) &&
						   can_receive_from(dst_op, 0, -1) &&
						   can_pass_energy(op, color, dst_op, dst_color) &&
						   (op != .PUMP || dst_color != color) {
							n_count += 1
						}
					}
					if y+1 < h {
						j := i + w
						dst_op := world.ops[j]
						dst_color := world.colors[j]
						dst_refr := world.refractory[j]

						dst_receptive := dst_op != .WALL && ((dst_color == 0) || (dst_refr == 0))
						if dst_receptive &&
						   can_emit_towards(op, 0, 1) &&
						   can_receive_from(dst_op, 0, 1) &&
						   can_pass_energy(op, color, dst_op, dst_color) &&
						   (op != .PUMP || dst_color != color) {
							n_count += 1
						}
					}

					if n_count != 0 {
						// Distribute without truncating to zero at low out_total.
						share := out_total / u16(n_count)
						rem  := int(out_total % u16(n_count))

						// Broadcast in a deterministic order (L, R, U, D), distributing remainder.
						if x > 0 {
							j := i - 1
							dst_op := world.ops[j]
							dst_color := world.colors[j]
							dst_refr := world.refractory[j]
							dst_receptive := dst_op != .WALL && ((dst_color == 0) || (dst_refr == 0))

							if dst_receptive &&
							   can_emit_towards(op, -1, 0) &&
							   can_receive_from(dst_op, -1, 0) &&
							   can_pass_energy(op, color, dst_op, dst_color) &&
							   (op != .PUMP || dst_color != color) {
								give := share
								if rem > 0 { give += 1; rem -= 1 }
								if give != 0 {
									world.pending_energy[j] += give
								}
							}
						}
						if x+1 < w {
							j := i + 1
							dst_op := world.ops[j]
							dst_color := world.colors[j]
							dst_refr := world.refractory[j]
							dst_receptive := dst_op != .WALL && ((dst_color == 0) || (dst_refr == 0))

							if dst_receptive &&
							   can_emit_towards(op, 1, 0) &&
							   can_receive_from(dst_op, 1, 0) &&
							   can_pass_energy(op, color, dst_op, dst_color) &&
							   (op != .PUMP || dst_color != color) {
								give := share
								if rem > 0 { give += 1; rem -= 1 }
								if give != 0 {
									world.pending_energy[j] += give
								}
							}
						}
						if y > 0 {
							j := i - w
							dst_op := world.ops[j]
							dst_color := world.colors[j]
							dst_refr := world.refractory[j]
							dst_receptive := dst_op != .WALL && ((dst_color == 0) || (dst_refr == 0))

							if dst_receptive &&
							   can_emit_towards(op, 0, -1) &&
							   can_receive_from(dst_op, 0, -1) &&
							   can_pass_energy(op, color, dst_op, dst_color) &&
							   (op != .PUMP || dst_color != color) {
								give := share
								if rem > 0 { give += 1; rem -= 1 }
								if give != 0 {
									world.pending_energy[j] += give
								}
							}
						}
						if y+1 < h {
							j := i + w
							dst_op := world.ops[j]
							dst_color := world.colors[j]
							dst_refr := world.refractory[j]
							dst_receptive := dst_op != .WALL && ((dst_color == 0) || (dst_refr == 0))

							if dst_receptive &&
							   can_emit_towards(op, 0, 1) &&
							   can_receive_from(dst_op, 0, 1) &&
							   can_pass_energy(op, color, dst_op, dst_color) &&
							   (op != .PUMP || dst_color != color) {
								give := share
								if rem > 0 { give += 1; rem -= 1 }
								if give != 0 {
									world.pending_energy[j] += give
								}
							}
						}
					}
				}
			}

			// Broadcast CLAIM/WRITE/INJECT intentions into the same 4-neighborhood.
			if val >= FIRING_THRESHOLD && color != 0 {
				// For WRITE cells, `cap_store[i]` holds the stable target opcode to write.
				// (We no longer rely on VAL low bits for program selection because VAL is energy.)
				write_prog := world.cap_store[i]
				write_op := write_op_from_val(val)
				if op == .WRITE {
					// Base "program" opcode (what this writer paints when not replicating).
					prog := write_prog
					if prog > u8(Instruction.CLAIM) || prog == u8(Instruction.WRITE) {
						prog = u8(Instruction.WIRE)
					}
					write_prog = prog
					write_op = Instruction(prog)

					// Occasionally bud a new WRITE head carrying the same program, so fronts can propagate.
					if WRITE_REPLICATE_1_OVER != 0 && val >= (FIRING_THRESHOLD*4) {
						if (rand.uint32() % WRITE_REPLICATE_1_OVER) == 0 {
							write_op = .WRITE
						}
					}
				}

				if x > 0 {
					j := i - 1
					dst_op := world.ops[j]
					dst_color := world.colors[j]
					thr := write_threshold_for_target(color, dst_op, dst_color)

					if op == .WRITE && val >= thr {
						mailbox_try_write(world, j, write_op, color, val, write_prog)
					} else if op == .INJECT && val >= thr {
						mailbox_try_inject(world, j, val, color, val)
					} else if op == .CLAIM {
						claim_thr := u8(0)
						if dst_color != 0 && dst_color != color {
							claim_thr = CLAIM_TAKEOVER_THRESHOLD
						}
						if val >= claim_thr {
							mailbox_try_claim(world, j, color, val)
						}
					}
				}
				if x+1 < w {
					j := i + 1
					dst_op := world.ops[j]
					dst_color := world.colors[j]
					thr := write_threshold_for_target(color, dst_op, dst_color)

					if op == .WRITE && val >= thr {
						mailbox_try_write(world, j, write_op, color, val, write_prog)
					} else if op == .INJECT && val >= thr {
						mailbox_try_inject(world, j, val, color, val)
					} else if op == .CLAIM {
						claim_thr := u8(0)
						if dst_color != 0 && dst_color != color {
							claim_thr = CLAIM_TAKEOVER_THRESHOLD
						}
						if val >= claim_thr {
							mailbox_try_claim(world, j, color, val)
						}
					}
				}
				if y > 0 {
					j := i - w
					dst_op := world.ops[j]
					dst_color := world.colors[j]
					thr := write_threshold_for_target(color, dst_op, dst_color)

					if op == .WRITE && val >= thr {
						mailbox_try_write(world, j, write_op, color, val, write_prog)
					} else if op == .INJECT && val >= thr {
						mailbox_try_inject(world, j, val, color, val)
					} else if op == .CLAIM {
						claim_thr := u8(0)
						if dst_color != 0 && dst_color != color {
							claim_thr = CLAIM_TAKEOVER_THRESHOLD
						}
						if val >= claim_thr {
							mailbox_try_claim(world, j, color, val)
						}
					}
				}
				if y+1 < h {
					j := i + w
					dst_op := world.ops[j]
					dst_color := world.colors[j]
					thr := write_threshold_for_target(color, dst_op, dst_color)

					if op == .WRITE && val >= thr {
						mailbox_try_write(world, j, write_op, color, val, write_prog)
					} else if op == .INJECT && val >= thr {
						mailbox_try_inject(world, j, val, color, val)
					} else if op == .CLAIM {
						claim_thr := u8(0)
						if dst_color != 0 && dst_color != color {
							claim_thr = CLAIM_TAKEOVER_THRESHOLD
						}
						if val >= claim_thr {
							mailbox_try_claim(world, j, color, val)
						}
					}
				}
			}
		}
	}
}

// Phase 2: Read mailboxes -> write next arrays (no neighbor writes).
resolution_phase :: proc(world: ^World, mutation: bool) {
	n := world.width * world.height

	for i in 0..<n {
		op := world.ops[i]
		color := world.colors[i]
		val := world.vals[i]
		refr := world.refractory[i]

		next_op := op
		next_color := color
		next_refr := u8(0)

		next_val := u8(0)

		// --- Refractory / integration ---
		if op == .WALL {
			next_val = 0
			next_refr = 0
			world.next_cap_store[i] = 0
		} else if color == 0 {
			// Ether: integrates incoming, loses some via decay, can be drained by PORE feeding,
			// and is kept alive by an ambient floor.
			base     := u16(val)
			incoming := world.pending_energy[i]
			drain    := world.pending_drain[i]
			decay    := base >> ETHER_DECAY_SHIFT

			total := base + incoming
			total = sub_floor_u16(total, decay)
			total = sub_floor_u16(total, drain)
			if total < u16(ETHER_AMBIENT) {
				total = u16(ETHER_AMBIENT)
			}
			next_val = clamp_u16_to_u8(total)
			next_refr = 0
			world.next_cap_store[i] = 0
		} else {
			// Organisms: excitable medium with refractory.
			if refr != 0 {
				next_refr = refr - 1
				next_val = 0
				// Preserve per-cell state: CAP delay, or WRITE program.
				if op == .WRITE {
					world.next_cap_store[i] = world.cap_store[i]
				} else if op == .CAP {
					world.next_cap_store[i] = world.cap_store[i]
				} else {
					world.next_cap_store[i] = 0
				}
			} else if val >= FIRING_THRESHOLD {
				// We fired during Phase 1; now enter refractory.
				next_refr = REFRACTORY_PERIOD
				next_val = 0
				// Preserve per-cell state: CAP delay, or WRITE program.
				if op == .WRITE {
					world.next_cap_store[i] = world.cap_store[i]
				} else if op == .CAP {
					world.next_cap_store[i] = world.cap_store[i]
				} else {
					world.next_cap_store[i] = 0
				}
			} else {
				incoming := clamp_u16_to_u8(world.pending_energy[i])
				if op == .CAP {
					// Delay line: output previous store, store current input.
					next_val = world.cap_store[i]
					world.next_cap_store[i] = incoming
				} else if op == .WRITE {
					// WRITE: val is pure energy; program is in cap_store.
					next_val = incoming
					world.next_cap_store[i] = world.cap_store[i]
				} else {
					next_val = incoming
					// Use cap_store as an "age" counter for non-CAP/non-WRITE tissue.
					// If the cell has no energy and receives none for long enough, it dissolves back to Ether.
					age_next: u8 = 0
					if world.pending_write_strength[i] == 0 &&
					   world.pending_claim_strength[i] == 0 &&
					   world.pending_inject_strength[i] == 0 {
						if incoming == 0 && val == 0 {
							age := world.cap_store[i]
							if age < 255 {
								age_next = age + 1
							} else {
								age_next = 255
							}
						}
					}
					world.next_cap_store[i] = age_next
				}
			}
		}

		// --- WRITE (opcode overwrite; auto-claim only when targeting true Ether) ---
		if world.pending_write_strength[i] != 0 {
			wo := world.pending_write_op[i]
			wc := world.pending_write_color[i]
			wp := world.pending_write_prog[i]

			// Evolution hook: occasional point mutation on successful writes.
			if mutation && wo != .ETHER {
				if WRITE_MUTATION_1_OVER != 0 && (rand.uint32() % WRITE_MUTATION_1_OVER) == 0 {
					wo = mutate_instruction(wo)
				}
			}

			next_op = wo

			if wo == .ETHER {
				next_color = 0
				next_val = 0
				next_refr = 0
				world.next_cap_store[i] = 0
			} else {
				// Auto-claim on Ether (color 0) only.
				if op == .ETHER && color == 0 {
					next_color = wc
				}
				// If we wrote a wall, it becomes inert.
				if wo == .WALL {
					next_val = 0
					next_refr = 0
					world.next_cap_store[i] = 0
				} else if wo == .WRITE {
					// If we wrote a WRITE cell, its program comes from the writer's program.
					// If not provided, default to WIRE so it still does something deterministic.
					if wp == 0 {
						wp = u8(Instruction.WIRE)
					}
					// Program must be a non-WRITE opcode; WRITEs replicate via `wo==.WRITE`, not via program.
					if wp > u8(Instruction.CLAIM) || wp == u8(Instruction.WRITE) {
						wp = u8(Instruction.WIRE)
					}
					world.next_cap_store[i] = wp
				} else if wo == .CAP {
					// CAP delay-line state starts empty (will fill on next tick).
					world.next_cap_store[i] = 0
				} else {
					// Other ops don't carry extra per-cell state.
					world.next_cap_store[i] = 0
				}
			}
		}

		// --- CLAIM (color overwrite) ---
		if world.pending_claim_strength[i] != 0 {
			next_color = world.pending_claim_color[i]
		}

		// --- INJECT (VAL overwrite) ---
		if world.pending_inject_strength[i] != 0 {
			iv := world.pending_inject_val[i]
			if next_op == .CAP {
				world.next_cap_store[i] = iv
			} else {
				next_val = iv
			}
		}

		// Structural integrity: walls are always inert.
		if next_op == .WALL {
			next_val = 0
			next_refr = 0
			world.next_cap_store[i] = 0
		}

		// If non-active organism tissue has been stale for long enough, recycle it to Ether.
		if next_color != 0 &&
		   next_op != .CAP && next_op != .WRITE && next_op != .WALL &&
		   next_refr == 0 && next_val == 0 &&
		   world.next_cap_store[i] >= ORGANISM_STALE_TO_ETHER_TICKS {
			next_op = .ETHER
			next_color = 0
			next_val = 0
			next_refr = 0
			world.next_cap_store[i] = 0
		}

		world.next_ops[i] = next_op
		world.next_colors[i] = next_color
		world.next_vals[i] = next_val
		world.next_refractory[i] = next_refr
	}
}

swap_buffers :: proc(world: ^World) {
	world.ops, world.next_ops = world.next_ops, world.ops
	world.vals, world.next_vals = world.next_vals, world.vals
	world.colors, world.next_colors = world.next_colors, world.colors
	world.refractory, world.next_refractory = world.next_refractory, world.refractory
	world.cap_store, world.next_cap_store = world.next_cap_store, world.cap_store
}

tick :: proc(world: ^World, turmoil: bool, mutation: bool) {
	mailbox_clear(world)
	if turmoil {
		apply_turmoil(world)
	}
	interaction_phase(world)
	resolution_phase(world, mutation)
	swap_buffers(world)
}

make_palette :: proc() -> [256]rl.Color {
	pal: [256]rl.Color
	pal[0] = rl.Color{0, 0, 0, 255}
	for i in 1..<256 {
		// Spread the first few species across the hue wheel so 2..4 species are visually distinct.
		hue := f32(i) * 360.0 / 255.0
		if i <= int(SPECIES_COUNT) {
			hue = f32(i-1) * 360.0 / f32(SPECIES_COUNT)
		}
		c := rl.ColorFromHSV(hue, 0.85, 1.0)
		c.a = 255
		pal[i] = c
	}
	return pal
}

mul8 :: proc(a, b: u8) -> u8 {
	return u8((u16(a) * u16(b)) / 255)
}

to_pixel :: proc(op: Instruction, val: u8, color: u8, refr: u8, pal: ^[256]rl.Color) -> rl.Color {
	if op == .WALL {
		return rl.Color{18, 18, 18, 255}
	}

	if color == 0 {
		return rl.Color{val, val, val, 255}
	}

	base := pal[color]

	// Refractory cells look "burnt out"/dim.
	if refr != 0 {
		return rl.Color{base.r/4, base.g/4, base.b/4, 255}
	}

	// Visualize *activity* even when energy values are small (e.g. Ether ambient < 32).
	// We keep a small "body" brightness so organisms remain visible, then add a scaled activity term.
	body: u16 = 24
	act := u16(val) * 4
	if act > 231 { act = 231 } // leave headroom for body
	br := u8(body + act)

	#partial switch op {
	case .WRITE:
		// Only highlight active writers; otherwise show normal species shading so the view
		// doesn't become a solid magenta carpet once structures spread.
		if val >= FIRING_THRESHOLD {
			return rl.Color{255, 0, 255, 255}
		}
		return rl.Color{mul8(base.r, br), mul8(base.g, br), mul8(base.b, br), 255}
	case .CLAIM:
		return rl.Color{0, 255, 255, 255}
	case .INJECT:
		return rl.Color{255, 64, 64, 255}
	case .PORE:
		return rl.Color{64, 255, 64, 255}
	case .PUMP:
		return rl.Color{255, 160, 48, 255}
	case .CAP:
		return rl.Color{64, 128, 255, 255}
	case .DIODE_N, .DIODE_S, .DIODE_E, .DIODE_W:
		return rl.Color{255, 255, 64, 255}
	case:
		return rl.Color{mul8(base.r, br), mul8(base.g, br), mul8(base.b, br), 255}
	}
}

min_f32 :: proc(a, b: f32) -> f32 {
	if a < b {
		return a
	}
	return b
}

max_f32 :: proc(a, b: f32) -> f32 {
	if a > b {
		return a
	}
	return b
}

min_i32 :: proc(a, b: i32) -> i32 {
	if a < b {
		return a
	}
	return b
}

round_i32 :: proc(x: f32) -> i32 {
	// Deterministic "round to nearest int" that behaves sensibly for negatives too.
	if x >= 0 {
		return i32(x + 0.5)
	}
	return i32(x - 0.5)
}

clamp_u8_from_f32 :: proc(x: f32) -> u8 {
	xi := round_i32(x)
	if xi <= 0 {
		return 0
	}
	if xi >= 255 {
		return 255
	}
	return u8(xi)
}

instruction_name :: proc(op: Instruction) -> cstring {
	#partial switch op {
	case .ETHER:   return "ETHER"
	case .WIRE:    return "WIRE"
	case .WALL:    return "WALL"
	case .DIODE_N: return "DIODE_N"
	case .DIODE_S: return "DIODE_S"
	case .DIODE_E: return "DIODE_E"
	case .DIODE_W: return "DIODE_W"
	case .CAP:     return "CAP"
	case .WRITE:   return "WRITE"
	case .INJECT:  return "INJECT"
	case .PORE:    return "PORE"
	case .PUMP:    return "PUMP"
	case .CLAIM:   return "CLAIM"
	case:          return "?"
	}
}

help_reserved_h :: proc(mode: Help_Mode) -> i32 {
	#partial switch mode {
	case .OFF:     return 0
	case .COMPACT: return 92
	case .FULL:    return 202
	case:          return 0
	}
}

Hover_Info :: struct {
	ok: bool,
	x, y: int,
	op: Instruction,
	val, color, refr: u8,
	cap: u8,
}

get_hover_info :: proc(world: ^World, dst: rl.Rectangle, scale: f32) -> Hover_Info {
	m := rl.GetMousePosition()
	if m.x < dst.x || m.y < dst.y || m.x >= dst.x+dst.width || m.y >= dst.y+dst.height {
		return Hover_Info{}
	}

	x := int((m.x - dst.x) / scale)
	y := int((m.y - dst.y) / scale)
	if x < 0 || y < 0 || x >= world.width || y >= world.height {
		return Hover_Info{}
	}
	i := idx_of(world, x, y)

	return Hover_Info{
		ok = true,
		x = x,
		y = y,
		op = world.ops[i],
		val = world.vals[i],
		color = world.colors[i],
		refr = world.refractory[i],
		cap = world.cap_store[i],
	}
}

draw_help :: proc(preset: Seed_Preset, zoom: f32, pixel_perfect: bool, show_op_overlay: bool, paused: bool, turmoil: bool, mutation: bool, mode: Help_Mode, hover: Hover_Info) {
	if mode == .OFF {
		return
	}

	sw := rl.GetScreenWidth()
	panel_w := min_i32(i32(sw)-16, 1100)
	panel_h := help_reserved_h(mode) - 8
	if panel_h < 40 {
		panel_h = 40
	}

	// Dedicated top HUD region (the sim is rendered below this, so no overlap).
	bg_a: u8 = 150
	if mode == .FULL { bg_a = 175 }
	rl.DrawRectangle(8, 8, panel_w, panel_h, rl.Color{0, 0, 0, bg_a})

	pp: cstring = "OFF"
	if pixel_perfect { pp = "ON" }
	opov: cstring = "OFF"
	if show_op_overlay { opov = "ON" }
	tm: cstring = "OFF"
	if turmoil { tm = "ON" }
	mu: cstring = "OFF"
	if mutation { mu = "ON" }

	x: i32 = 14
	y: i32 = 12

	if mode == .COMPACT {
		rl.DrawText("H: help (cycle)   I: op overlay   G: grid   SPACE: pause   TAB: next   R: reseed   T: turmoil   U: mutation   N/M: demos", x, y, 18, rl.RAYWHITE); y += 20
		rl.DrawText("Colors: Ether=gray(VAL)  Organism=hue(COLOR)*VAL  WALL=dark  REFR=dim  (WRITE/CLAIM/INJECT/PORE/PUMP/CAP/DIODE highlighted)", x, y, 18, rl.RAYWHITE); y += 20
		rl.DrawText(rl.TextFormat("preset: %s   zoom: %.2f   pixel-perfect: %s   op-overlay: %s   turmoil: %s   mutation: %s", seed_preset_name(preset), zoom, pp, opov, tm, mu), x, y, 18, rl.RAYWHITE); y += 20
		if hover.ok {
			rl.DrawText(
				rl.TextFormat("hover (%d,%d): OP=%s(%d)  VAL=%d  COLOR=%d  REFR=%d  CAP=%d   (CAP means: CAP delay | WRITE program | else stale-age)",
					hover.x, hover.y,
					instruction_name(hover.op), int(hover.op),
					int(hover.val), int(hover.color), int(hover.refr), int(hover.cap),
				),
				x, y, 18, rl.RAYWHITE,
			)
		} else {
			rl.DrawText("Hover a cell to see OP/VAL/COLOR/REFR. (Full legend: press H again)", x, y, 18, rl.RAYWHITE)
		}
		return
	}

	rl.DrawText("Chromatose renderer legend (H cycles: off/compact/full)", x, y, 18, rl.RAYWHITE); y += 22
	rl.DrawText("Ether (COLOR=0): grayscale = VAL (0..255).", x, y, 18, rl.RAYWHITE); y += 20
	rl.DrawText(rl.TextFormat("Organism (COLOR=1..%d): species hue by COLOR id, brightness by VAL (min 32).", int(SPECIES_COUNT)), x, y, 18, rl.RAYWHITE); y += 20
	rl.DrawText("WALL: dark gray. Refractory (REFR>0): dimmed organism color.", x, y, 18, rl.RAYWHITE); y += 20
	rl.DrawText("Special OP highlight colors: WRITE=magenta, CLAIM=cyan, INJECT=red, PORE=green, PUMP=orange, CAP=blue, DIODE=yellow.", x, y, 18, rl.RAYWHITE); y += 22
	rl.DrawText(rl.TextFormat("preset: %s    zoom: %.2f    pixel-perfect: %s", seed_preset_name(preset), zoom, pp), x, y, 18, rl.RAYWHITE); y += 22
	rl.DrawText(rl.TextFormat("turmoil: %s", tm), x, y, 18, rl.RAYWHITE); y += 20
	rl.DrawText(rl.TextFormat("mutation: %s", mu), x, y, 18, rl.RAYWHITE); y += 20
	rl.DrawText(rl.TextFormat("Keys: SPACE pause  TAB next preset  R reseed  N/M demos  P pixel-perfect  F reset view  I op-overlay(%s)  G grid  U mutation", opov), x, y, 18, rl.RAYWHITE); y += 20
	rl.DrawText("T: toggle constant turmoil (external energy injected into Ether)", x, y, 18, rl.RAYWHITE); y += 20
	if hover.ok {
		rl.DrawText(
			rl.TextFormat("hover (%d,%d): OP=%s(%d)  VAL=%d  COLOR=%d  REFR=%d  CAP=%d   (CAP means: CAP delay | WRITE program | else stale-age)",
				hover.x, hover.y,
				instruction_name(hover.op), int(hover.op),
				int(hover.val), int(hover.color), int(hover.refr), int(hover.cap),
			),
			x, y, 18, rl.RAYWHITE,
		)
	} else if show_op_overlay && !paused {
		rl.DrawText("Tip: pause to read per-cell op overlay; when running it can be too dense.", x, y, 18, rl.RAYWHITE)
	}
}

draw_op_overlay :: proc(world: ^World, dst: rl.Rectangle, scale: f32) {
	// Only draw when zoomed enough that text is legible.
	if scale < 8.0 {
		return
	}

	sw := rl.GetScreenWidth()
	sh := rl.GetScreenHeight()

	sx0 := max_f32(dst.x, 0)
	sy0 := max_f32(dst.y, 0)
	sx1 := min_f32(dst.x+dst.width,  f32(sw))
	sy1 := min_f32(dst.y+dst.height, f32(sh))
	if sx1 <= sx0 || sy1 <= sy0 {
		return
	}

	x0 := int((sx0 - dst.x) / scale)
	y0 := int((sy0 - dst.y) / scale)
	x1 := int((sx1 - dst.x) / scale)
	y1 := int((sy1 - dst.y) / scale)

	if x0 < 0 { x0 = 0 }
	if y0 < 0 { y0 = 0 }
	if x1 > world.width  { x1 = world.width }
	if y1 > world.height { y1 = world.height }

	// If the visible region is huge, decimate so we don't blow up draw calls.
	visible_cells := (x1-x0) * (y1-y0)
	step := 1
	if visible_cells > 30000 {
		step = 4
	} else if visible_cells > 12000 {
		step = 2
	}

	font_size := int(scale * 0.55)
	if font_size < 8 { font_size = 8 }
	if font_size > 24 { font_size = 24 }

	op_glyph := OP_GLYPH

	y := y0
	for y < y1 {
		x := x0
		for x < x1 {
			i := idx_of(world, x, y)
			op := world.ops[i]
			oi := int(op)
			if oi < 0 || oi >= len(op_glyph) {
				x += step
				continue
			}
			label := op_glyph[oi]
			px := int(dst.x + f32(x)*scale)
			py := int(dst.y + f32(y)*scale)

			// Simple "stroke": draw shadow then bright text, so it's readable on any cell color.
			tx := px + int(scale*0.30)
			ty := py + int(scale*0.18)
			rl.DrawText(label, i32(tx+1), i32(ty+1), i32(font_size), rl.BLACK)
			rl.DrawText(label, i32(tx),   i32(ty),   i32(font_size), rl.RAYWHITE)

			x += step
		}
		y += step
	}
}

draw_grid :: proc(world: ^World, dst: rl.Rectangle, scale: f32) {
	if scale < 6.0 {
		return
	}
	sw := rl.GetScreenWidth()
	sh := rl.GetScreenHeight()

	sx0 := max_f32(dst.x, 0)
	sy0 := max_f32(dst.y, 0)
	sx1 := min_f32(dst.x+dst.width,  f32(sw))
	sy1 := min_f32(dst.y+dst.height, f32(sh))
	if sx1 <= sx0 || sy1 <= sy0 {
		return
	}

	x0 := int((sx0 - dst.x) / scale)
	y0 := int((sy0 - dst.y) / scale)
	x1 := int((sx1 - dst.x) / scale)
	y1 := int((sy1 - dst.y) / scale)
	if x0 < 0 { x0 = 0 }
	if y0 < 0 { y0 = 0 }
	if x1 > world.width  { x1 = world.width }
	if y1 > world.height { y1 = world.height }

	col := rl.Color{255, 255, 255, 35}
	for x in x0..=x1 {
		px := int(dst.x + f32(x)*scale)
		rl.DrawLine(i32(px), i32(int(sy0)), i32(px), i32(int(sy1)), col)
	}
	for y in y0..=y1 {
		py := int(dst.y + f32(y)*scale)
		rl.DrawLine(i32(int(sx0)), i32(py), i32(int(sx1)), i32(py), col)
	}
}

main_v01 :: proc() {
	rand.reset(u64(1))

	// VSYNC reduces tearing (often perceived as flicker for fast pixel sims).
	rl.SetConfigFlags(rl.ConfigFlags{.WINDOW_RESIZABLE, .VSYNC_HINT})
	rl.InitWindow(WINDOW_W, WINDOW_H, "Chromatose 2.0 (prototype)")
	defer rl.CloseWindow()

	rl.SetTargetFPS(60)

	world := world_make(SIM_W, SIM_H)
	preset := Seed_Preset.NOISE_METABOLIC
	world_seed_preset(&world, preset)

	pal := make_palette()

	image := rl.GenImageColor(i32(world.width), i32(world.height), rl.BLACK)
	texture_a := rl.LoadTextureFromImage(image)
	texture_b := rl.LoadTextureFromImage(image)
	rl.UnloadImage(image)
	defer rl.UnloadTexture(texture_a)
	defer rl.UnloadTexture(texture_b)

	// Make scaling crisp (nearest-neighbor) so individual cells stay readable.
	rl.SetTextureFilter(texture_a, rl.TextureFilter.POINT)
	rl.SetTextureFilter(texture_b, rl.TextureFilter.POINT)

	// Stream-to-GPU textures can "flicker" on some drivers if you update and draw the same texture
	// in the same frame (async upload / hazard). Double-buffering avoids that.
	read_tex  := texture_a
	write_tex := texture_b

	pixels := make([]rl.Color, world.width*world.height)

	paused := false
	turmoil := true
	mutation := true
	zoom: f32 = 1.0
	pan := rl.Vector2{0, 0}
	pixel_perfect := true
	smoothing := false
	help_mode := Help_Mode.COMPACT
	show_op_overlay := true
	show_grid_overlay := false

	// Optional temporal smoothing (EMA in RGB) to reduce sparkle / harsh flicker.
	accum := make([][3]f32, world.width*world.height)
	accum_init := false

	for !rl.WindowShouldClose() {
		if rl.IsKeyPressed(.SPACE) {
			paused = !paused
		}
		if rl.IsKeyPressed(.H) {
			help_mode = Help_Mode((u8(help_mode) + 1) % 3)
		}
		if rl.IsKeyPressed(.I) {
			show_op_overlay = !show_op_overlay
		}
		if rl.IsKeyPressed(.G) {
			show_grid_overlay = !show_grid_overlay
		}
		if rl.IsKeyPressed(.T) {
			turmoil = !turmoil
		}
		if rl.IsKeyPressed(.U) {
			mutation = !mutation
		}
		if rl.IsKeyPressed(.TAB) {
			preset = seed_preset_next(preset)
			world_seed_preset(&world, preset)
		}
		if rl.IsKeyPressed(.R) {
			world_seed_preset(&world, preset)
		}
		if rl.IsKeyPressed(.N) {
			preset = .NOISE_RANDOM
			world_seed_preset(&world, preset)
		}
		if rl.IsKeyPressed(.M) {
			preset = .NOISE_METABOLIC
			world_seed_preset(&world, preset)
		}
		if rl.IsKeyPressed(.F) {
			zoom = 1.0
			pan = rl.Vector2{0, 0}
		}
		if rl.IsKeyPressed(.P) {
			pixel_perfect = !pixel_perfect
		}
		if rl.IsKeyPressed(.S) {
			smoothing = !smoothing
			accum_init = false
		}

		dt := rl.GetFrameTime()
		pan_speed := 600.0 * dt
		if rl.IsKeyDown(.LEFT)  { pan.x -= pan_speed }
		if rl.IsKeyDown(.RIGHT) { pan.x += pan_speed }
		if rl.IsKeyDown(.UP)    { pan.y -= pan_speed }
		if rl.IsKeyDown(.DOWN)  { pan.y += pan_speed }

		wheel_steps := int(rl.GetMouseWheelMove())
		if wheel_steps > 0 {
			for _ in 0..<wheel_steps { zoom *= 1.1 }
		} else if wheel_steps < 0 {
			for _ in 0..<(-wheel_steps) { zoom /= 1.1 }
		}
		if zoom < 0.25 { zoom = 0.25 }
		if zoom > 64.0 { zoom = 64.0 }

		if !paused {
			// A few substeps makes the soup feel more "continuous".
			for _ in 0..<2 {
				tick(&world, turmoil, mutation)
			}
		}

		if smoothing {
			// Fixed per-frame alpha tuned for ~60fps. Higher = smoother but blurrier.
			alpha: f32 = 0.35
			for i in 0..<len(pixels) {
				cur := to_pixel(world.ops[i], world.vals[i], world.colors[i], world.refractory[i], &pal)
				if !accum_init {
					accum[i][0] = f32(cur.r)
					accum[i][1] = f32(cur.g)
					accum[i][2] = f32(cur.b)
				} else {
					accum[i][0] += alpha * (f32(cur.r) - accum[i][0])
					accum[i][1] += alpha * (f32(cur.g) - accum[i][1])
					accum[i][2] += alpha * (f32(cur.b) - accum[i][2])
				}
				pixels[i] = rl.Color{clamp_u8_from_f32(accum[i][0]), clamp_u8_from_f32(accum[i][1]), clamp_u8_from_f32(accum[i][2]), 255}
			}
			accum_init = true
		} else {
			for i in 0..<len(pixels) {
				pixels[i] = to_pixel(world.ops[i], world.vals[i], world.colors[i], world.refractory[i], &pal)
			}
		}
		rl.UpdateTexture(write_tex, raw_data(pixels))

		rl.BeginDrawing()
		rl.ClearBackground(rl.BLACK)

		sw := rl.GetScreenWidth()
		sh := rl.GetScreenHeight()

		ui_top := help_reserved_h(help_mode)
		if ui_top > sh-1 {
			ui_top = sh-1
		}

		// Fit sim texture into window with optional zoom/pan.
		// NOTE: When help is visible, we reserve a dedicated HUD region at the top
		// and render the simulation below it so the HUD never overlaps the sim.
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
		dst_w := f32(world.width)  * scale
		dst_h := f32(world.height) * scale
		dst_x := (f32(view_w) - dst_w) * 0.5 + pan.x
		dst_y := f32(ui_top) + (f32(view_h) - dst_h) * 0.5 + pan.y
		// Keep it out of the HUD region even if pan/zoom tries to move it upward.
		if dst_y < f32(ui_top)+2 {
			dst_y = f32(ui_top) + 2
		}
		// With POINT sampling, sub-pixel destination coords shimmer. Snap when pixel-perfect is enabled.
		if pixel_perfect {
			dst_x = f32(round_i32(dst_x))
			dst_y = f32(round_i32(dst_y))
		}
		dst := rl.Rectangle{dst_x, dst_y, dst_w, dst_h}
		origin := rl.Vector2{0, 0}
		rl.DrawTexturePro(read_tex, src, dst, origin, 0, rl.WHITE)

		rl.DrawFPS(10, ui_top + 10)
		if help_mode == .OFF {
			rl.DrawText("H: help/legend   I: op overlay   G: grid   SPACE: pause   TAB: next preset   R: reseed   T: turmoil   U: mutation   N/M: demos", 10, 30, 18, rl.RAYWHITE)
			rl.DrawText(rl.TextFormat("preset: %s", seed_preset_name(preset)), 10, 52, 18, rl.RAYWHITE)
			rl.DrawText(rl.TextFormat("sim: %dx%d   zoom: %.2f", world.width, world.height, zoom), 10, 74, 18, rl.RAYWHITE)
			sm: cstring = "OFF"
			if smoothing { sm = "ON" }
			rl.DrawText(rl.TextFormat("smoothing (S): %s", sm), 10, 96, 18, rl.RAYWHITE)
			mu: cstring = "OFF"
			if mutation { mu = "ON" }
			rl.DrawText(rl.TextFormat("mutation (U): %s", mu), 10, 118, 18, rl.RAYWHITE)
		}

		if show_grid_overlay {
			draw_grid(&world, dst, scale)
		}
		if show_op_overlay {
			// Note: this is a debug overlay; it intentionally trades perf for clarity when zoomed in.
			draw_op_overlay(&world, dst, scale)
		}
		hover := get_hover_info(&world, dst, scale)
		draw_help(preset, zoom, pixel_perfect, show_op_overlay, paused, turmoil, mutation, help_mode, hover)
		rl.EndDrawing()

		// Swap the texture roles after presenting.
		tmp := read_tex
		read_tex = write_tex
		write_tex = tmp
	}
}

