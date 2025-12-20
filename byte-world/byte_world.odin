package main

import rl "vendor:raylib"

import "core:time"

// --------------------------------------------
// Byte-Physics World (Odin port of byte-world.md)
// --------------------------------------------

GRID_SIZE :: 100

WINDOW_W :: 1000
WINDOW_H :: 1000

// Value ranges (ontology)
RANGE_VOID_MAX  : u8 = 63   // Empty space / Passive data
RANGE_WALL_MAX  : u8 = 127  // Reflective matter (even=H-reflect, odd=V-reflect)
RANGE_SOLAR_MAX : u8 = 191  // Energy sources (metabolism)
// 192..255 are "active instructions" (ops)

// Metabolic costs
COST_MOVE   : f32 = 0.2   // Entropy: cost to exist/move per tick
COST_WRITE  : f32 = 5.0   // Work: cost to change a grid value
COST_SPLIT  : f32 = 25.0  // Reproduction: cost to create a child
COST_MATH   : f32 = 0.1   // Processing: cost to compute (INC/DEC)
PENALTY_HIT : f32 = 0.5   // Damage: cost when hitting a wall

// Metabolic gains
SOLAR_BASE_GAIN : f32 = 1.0 // Minimum energy from a solar tile
SOLAR_BONUS_MAX : f32 = 2.0 // Additional energy based on tile intensity

ENERGY_CAP : f32 = 250.0

// Op codes
OP_LOAD   : u8 = 200 // Register = Grid[Ahead]
OP_STORE  : u8 = 201 // Grid[Ahead] = Register
OP_SPLIT  : u8 = 202 // Divide energy, spawn orthogonal child
OP_LEFT   : u8 = 203 // Turn 90° counter-clockwise
OP_RIGHT  : u8 = 204 // Turn 90° clockwise
OP_INC    : u8 = 205 // Register++
OP_DEC    : u8 = 206 // Register--
OP_BRANCH : u8 = 207 // If Register < 128 -> LEFT else RIGHT

Spark :: struct {
	x, y: int,
	dx, dy: int,      // -1, 0, 1
	energy: f32,
	register: u8,     // 8-bit payload (0..255)
	age: int,
}

Byte_World :: struct {
	size: int,
	tick: u64,

	grid: []u8,

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

	// Allocate once; we’ll reuse these buffers every tick.
	grid := make([]u8, cell_count)

	// Upper bound is unknown (splits), but size² is a decent “big enough” default.
	spark_cap := size * size
	if spark_cap < 256 { spark_cap = 256 }
	sparks_a := make([dynamic]Spark, 0, spark_cap)
	sparks_b := make([dynamic]Spark, 0, spark_cap)

	w := Byte_World{
		size = size,
		tick = 0,
		grid = grid,
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

	// Base noise (void/data)
	for i in 0..<len(w.grid) {
		w.grid[i] = u8(rng_u32_bounded(&w.rng, 255)) // 0..255
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
	for _ in 0..<250 {
		spawn_spark_into(w, &w.sparks)
	}
}

spawn_spark_into :: proc(w: ^Byte_World, sparks: ^[dynamic]Spark) {
	s := Spark{
		x = rng_int_inclusive(&w.rng, 0, w.size-1),
		y = rng_int_inclusive(&w.rng, 0, w.size-1),
		dx = rng_choice_dir_3(&w.rng),
		dy = rng_choice_dir_3(&w.rng),
		energy = f32(rng_int_inclusive(&w.rng, 50, 80)),
		register = 0,
		age = 0,
	}
	// Ensure it’s moving.
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
		if s.energy > 0 {
			append(&w.sparks_next, s)
		}
	}

	// Extinction failsafe (panspermia): inject a new spark into the next generation.
	if len(w.sparks_next) < 5 {
		spawn_spark_into(w, &w.sparks_next)
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

color_from_cell_value :: proc(v: u8) -> rl.Color {
	if v <= RANGE_VOID_MAX {
		// Dark grey
		return rl.Color{26, 26, 26, 255}
	} else if v <= RANGE_WALL_MAX {
		// Blue shades
		brightness := f32(v-64) / 64.0
		b := u8_from_f32_01(0.4 + brightness*0.6)
		return rl.Color{0, 0, b, 255}
	} else if v <= RANGE_SOLAR_MAX {
		// Green/yellow-ish shades
		brightness := f32(v-128) / 64.0
		r := u8_from_f32_01(brightness * 0.8)
		g := u8_from_f32_01(0.4 + brightness*0.6)
		return rl.Color{r, g, 0, 255}
	}
	// Ops: magenta-ish
	return rl.Color{u8_from_f32_01(0.9), 0, u8_from_f32_01(0.5), 255}
}

render_world_pixels :: proc(w: ^Byte_World, pixels: []rl.Color) {
	assert(len(pixels) == len(w.grid))

	for i in 0..<len(w.grid) {
		pixels[i] = color_from_cell_value(w.grid[i])
	}

	// Sparks render on top (white).
	for s in w.sparks {
		pixels[idx_of(w.size, s.x, s.y)] = rl.Color{255, 255, 255, 255}
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
		ui_top: i32 = i32(8 + title_font_size + pad_y + (body_font_size+2)*3 + pad_y)
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
		rl.DrawText("SPACE: pause   N: step (paused)   R: reseed   +/-: steps/frame   Ctrl+Wheel: zoom   Arrows: pan   P: pixel-perfect   F: reset view", hud_x, hud_y, body_font_size, rl.RAYWHITE)
		hud_y += body_font_size + 2
		rl.DrawText("Ranges: 0-63(Void), 64-127(Wall), 128-191(Solar), 192+(Ops)   Ops: 200 Load, 201 Store, 202 Split, 203 Left, 204 Right, 205 Inc, 206 Dec, 207 Branch", hud_x, hud_y, body_font_size, rl.RAYWHITE)
		hud_y += body_font_size + 2
		rl.DrawText(rl.TextFormat("tick=%d   sparks=%d   steps/frame=%d   zoom=%.2f", world.tick, len(world.sparks), steps_per_frame, zoom), hud_x, hud_y, body_font_size, rl.RAYWHITE)

		origin := rl.Vector2{0, 0}
		rl.DrawTexturePro(texture, src, dst, origin, 0, rl.WHITE)
		rl.DrawFPS(10, ui_top + 10)

		rl.EndDrawing()
	}
}


