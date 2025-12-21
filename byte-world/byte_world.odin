package main

import rl "vendor:raylib"

import "core:time"

// --------------------------------------------
// Byte-Physics World (Odin port of byte-world.md)
// --------------------------------------------

GRID_SIZE :: 512

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
COST_SPLIT  : f32 = 25.0  // Reproduction: cost to create a child
COST_MATH   : f32 = 0.1   // Processing: cost to compute (INC/DEC)
PENALTY_HIT : f32 = 0.5   // Damage: cost when hitting a wall

// Metabolic gains
SOLAR_BASE_GAIN : f32 = 0.0 // Minimum energy from a solar tile
SOLAR_BONUS_MAX : f32 = 16.0 // Additional energy based on tile intensity
SOLAR_DRAIN_PER_HARVEST  : u8 = 4 // When a spark steps onto solar

ENERGY_CAP : f32 = 350.0

// Op codes
OP_LOAD   : u8 = 200 // Register = Grid[Ahead]
OP_STORE  : u8 = 201 // Grid[Ahead] = Register
OP_SPLIT  : u8 = 202 // Divide energy, spawn orthogonal child
OP_LEFT   : u8 = 203 // Turn 90° counter-clockwise
OP_RIGHT  : u8 = 204 // Turn 90° clockwise
OP_INC    : u8 = 205 // Register++
OP_DEC    : u8 = 206 // Register--
OP_BRANCH : u8 = 207 // If Register < 128 -> LEFT else RIGHT

SPARK_COUNT_MIN : int = 40000

SPARK_MAX_AGE_TICKS : int = 500

Spark :: struct {
	x, y: int,
	dx, dy: int,      // -1, 0, 1
	energy: f32,
	register: u8,     // 8-bit payload (0..255)
	age: int,
	color: rl.Color,  // Lineage color (inherited from parent)
}

Byte_World :: struct {
	size: int,
	tick: u64,

	grid: []u8,
	alpha: []f32,  // Alpha channel per cell (0.0 to 1.0)

	// Two buffers to avoid per-tick allocations.
	sparks: [dynamic]Spark,
	sparks_next: [dynamic]Spark,

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

	// Upper bound is unknown (splits), but size² is a decent "big enough" default.
	spark_cap := size * size
	if spark_cap < 256 { spark_cap = 256 }
	sparks_a := make([dynamic]Spark, 0, spark_cap)
	sparks_b := make([dynamic]Spark, 0, spark_cap)

	w := Byte_World{
		size = size,
		tick = 0,
		grid = grid,
		alpha = alpha,
		sparks = sparks_a,
		sparks_next = sparks_b,
		rng = seed,
	}
	byte_world_reseed(&w, seed)
	return w
}

byte_world_reseed :: proc(w: ^Byte_World, seed: u32) {
	w.tick = 0
	w.rng = seed ~ u32(w.size*73856093) ~ 0x9E37_79B9

	clear(&w.sparks)
	clear(&w.sparks_next)

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
		spawn_spark_into(w, &w.sparks)
	}
}

spawn_spark_into :: proc(w: ^Byte_World, sparks: ^[dynamic]Spark) {
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
	append(sparks, s)
}

// -----------------
// Simulation update
// -----------------

byte_world_step :: proc(w: ^Byte_World) {
	shuffle_sparks(w.sparks[:], &w.rng)

	clear(&w.sparks_next)

	for s0 in w.sparks {
		s := s0
		s.age += 1

		// Mark current cell as visited
		current_idx := idx_of(w.size, s.x, s.y)
		w.alpha[current_idx] = min_f32(w.alpha[current_idx] + 0.01, 1.0)

		// Potential next coordinates (toroidal wrap)
		nx := wrap_i(s.x + s.dx, w.size)
		ny := wrap_i(s.y + s.dy, w.size)
		val := w.grid[idx_of(w.size, nx, ny)]

		// --- Physics interpreter ---
		if val <= RANGE_VOID_MAX {
			// Void/data: permeable
			s.x, s.y = nx, ny

		} else if val <= RANGE_WALL_MAX {
			// Wall/mirror: impermeable + reflective
			if (val % 2) == 0 {
				s.dx = -s.dx
			} else {
				s.dy = -s.dy
			}
			s.energy -= PENALTY_HIT

		} else if val <= RANGE_SOLAR_MAX {
			// Solar: permeable + energy gain
			s.x, s.y = nx, ny
			efficiency := (f32(val) - 128.0) / 64.0
			gain := SOLAR_BASE_GAIN + efficiency*SOLAR_BONUS_MAX
			s.energy += gain

			// Drain solar energy: reduce value, eventually becoming a wall (<= 127)
			w.grid[idx_of(w.size, nx, ny)] -= SOLAR_DRAIN_PER_HARVEST

		} else {
			// Operators: permeable + execution
			s.x, s.y = nx, ny

			// Look-ahead (for read/write), relative to the *current* direction.
			ax := wrap_i(s.x + s.dx, w.size)
			ay := wrap_i(s.y + s.dy, w.size)
			ahead_idx := idx_of(w.size, ax, ay)

			switch val {
			case OP_LOAD:
				s.register = w.grid[ahead_idx]

			case OP_STORE:
				if s.energy > COST_WRITE {
					w.grid[ahead_idx] = s.register
					s.energy -= COST_WRITE
				}

			case OP_SPLIT:
				if s.energy > COST_SPLIT {
					child := Spark{
						x = s.x,
						y = s.y,
						dx = -s.dy,
						dy = s.dx,
						energy = s.energy * 0.5,
						register = s.register,
						age = 0,
						color = s.color,  // Inherit parent's lineage color
					}
					append(&w.sparks_next, child)
					s.energy *= 0.5
				}

			case OP_LEFT:
				s.dx, s.dy = s.dy, -s.dx

			case OP_RIGHT:
				s.dx, s.dy = -s.dy, s.dx

			case OP_INC:
				s.register = u8((int(s.register) + 1) & 255)
				s.energy -= COST_MATH

			case OP_DEC:
				s.register = u8((int(s.register) + 255) & 255)
				s.energy -= COST_MATH

			case OP_BRANCH:
				if s.register < 128 {
					s.dx, s.dy = s.dy, -s.dx
				} else {
					s.dx, s.dy = -s.dy, s.dx
				}
			case:
				// Unknown op tile: treated as permeable no-op.
			}
		}

		// Entropy + cap
		s.energy -= COST_MOVE
		if s.energy > ENERGY_CAP { s.energy = ENERGY_CAP }

		// Survival
		if s.energy > 0 && s.age < SPARK_MAX_AGE_TICKS {
			append(&w.sparks_next, s)
		}
	}

	// Extinction failsafe (panspermia): inject a new spark into the next generation.
	if len(w.sparks_next) == 0 {
		for _ in 0..<SPARK_COUNT_MIN {
			spawn_spark_into(w, &w.sparks_next)
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
	for s in w.sparks {
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
				spawn_spark_into(&world, &world.sparks)
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
		
		rl.DrawText(rl.TextFormat("tick=%d   sparks=%d   steps/frame=%d   zoom=%.2f", world.tick, len(world.sparks), steps_per_frame, zoom), hud_x, hud_y, body_font_size, rl.RAYWHITE)

		origin := rl.Vector2{0, 0}
		rl.DrawTexturePro(texture, src, dst, origin, 0, rl.WHITE)
		rl.DrawFPS(10, ui_top + 10)

		rl.EndDrawing()
	}
}


