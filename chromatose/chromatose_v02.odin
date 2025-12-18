package chromatose

import rl "vendor:raylib"

WINDOW_W :: 1024
WINDOW_H :: 1024

SIM_W :: 256
SIM_H :: 256

Cell_Type :: enum u8 {
	ETHER  = 0,
	SOURCE = 1,
	CONSUMER = 2,
}

World :: struct {
	width, height: int,
	types: []Cell_Type,
	vals:  []f32,

	next_types: []Cell_Type,
	next_vals:  []f32,
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
		next_types = make([]Cell_Type, n),
		next_vals  = make([]f32, n),
	}

	for i in 0..<n {
		w.types[i] = .ETHER
		w.vals[i] = 0.0
	}
	return w
}

world_clear :: proc(w: ^World) {
	n := w.width * w.height
	for i in 0..<n {
		w.types[i] = .ETHER
		w.vals[i] = 0.0
	}
}

world_set_cell :: proc(w: ^World, x, y: int, t: Cell_Type) {
	if !in_bounds(w, x, y) {
		return
	}
	i := idx_of(w, x, y)
	w.types[i] = t
	if t == .SOURCE {
		w.vals[i] = 512.0
	} else if t == .CONSUMER {
		w.vals[i] = 0.0
	} else {
		// Ether value is left as-is (useful when erasing a source back to Ether without nuking gradient)
	}
}

world_seed :: proc(w: ^World) {
	world_clear(w)

	// A simple deterministic starter layout: a single source in the center.
	// (The whole point is you can paint sources interactively too.)
	world_set_cell(w, w.width/2,  w.height/2,  .SOURCE)
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
sample_val :: proc(w: ^World, x, y: int) -> f32 {
	xx := x
	yy := y
	if xx < 0 { xx = 0 }
	if yy < 0 { yy = 0 }
	if xx >= w.width  { xx = w.width-1 }
	if yy >= w.height { yy = w.height-1 }

	i := idx_of(w, xx, yy)
	if w.types[i] == .SOURCE {
		return 512.0
	}
	if w.types[i] == .CONSUMER {
		return 0.0
	}
	return w.vals[i]
}

tick :: proc(w: ^World, spread_rate: f32) {
	// Synchronous update:
	// - SOURCE: VAL_next = 255 (always emits maximum energy)
// - ETHER: Diffuses energy but leaves a small leak so a gradient can form
//   Takes average of 8 neighbors and nudges toward it each tick
//   Spread rate controls how quickly the cell moves toward its neighbors
	ww := w.width
	hh := w.height

	// Spread rate: controls how quickly the cell moves toward the average of its neighbors.
	// IMPORTANT: This is an explicit relaxation step; if the step size > 1.0 it overshoots and
	// the field "explodes" (rapid saturation/instability). Keep it in [0, 1].

	for y in 0..<hh {
		row := y*ww
		for x in 0..<ww {
			i := row + x
			t := w.types[i]

			if t == .SOURCE {
				w.next_types[i] = .SOURCE
				w.next_vals[i]  = 512.0
				continue
			}
			if t == .CONSUMER {
				w.next_types[i] = .CONSUMER
				w.next_vals[i]  = 0.0
				continue
			}

			// Sample all 8 neighbors (equal weight)
			n  := sample_val(w, x,   y-1)
			s  := sample_val(w, x,   y+1)
			e  := sample_val(w, x+1, y)
			wv := sample_val(w, x-1, y)
			ne := sample_val(w, x+1, y-1)
			nw := sample_val(w, x-1, y-1)
			se := sample_val(w, x+1, y+1)
			sw := sample_val(w, x-1, y+1)

			// Average of neighbors
			sum := n + s + e + wv + ne + nw + se + sw
			neighbor_avg := sum / 8.0
			
			// Accumulate toward neighbor average (pure diffusion).
			// With no dissipation, a lone SOURCE will eventually fill the whole grid ("bathtub").
			current_val := w.vals[i]
			new_val := current_val + (neighbor_avg - current_val) * spread_rate
			
			// Clamp to valid range
			new_val = clamp_f32(new_val, 0.0, 512.0)

			w.next_types[i] = .ETHER
			w.next_vals[i]  = new_val
		}
	}

	w.types, w.next_types = w.next_types, w.types
	w.vals,  w.next_vals  = w.next_vals,  w.vals
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

to_pixel :: proc(t: Cell_Type, v: f32) -> rl.Color {
	if t == .SOURCE {
		// Slight warm tint so vents read as "special", while still being bright.
		return rl.Color{255, 255, 220, 255}
	}
	if t == .CONSUMER {
		// Cool tint so drains stand out.
		return rl.Color{80, 120, 255, 255}
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
	for !rl.WindowShouldClose() {
		if rl.IsKeyPressed(.SPACE) { paused = !paused }
		if rl.IsKeyPressed(.R)     { world_seed(&world) }
		if rl.IsKeyPressed(.C)     { world_clear(&world) }
		if rl.IsKeyPressed(.F)     { zoom = 1.0; pan = rl.Vector2{0, 0} }
		if rl.IsKeyPressed(.P)     { pixel_perfect = !pixel_perfect }
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
		if wheel_steps > 0 {
			for _ in 0..<wheel_steps { zoom *= 1.1 }
		} else if wheel_steps < 0 {
			for _ in 0..<(-wheel_steps) { zoom /= 1.1 }
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
				world_set_cell(&world, cx, cy, .SOURCE)
			} else if rl.IsMouseButtonDown(.MIDDLE) {
				world_set_cell(&world, cx, cy, .CONSUMER)
			} else if rl.IsMouseButtonDown(.RIGHT) {
				world_set_cell(&world, cx, cy, .ETHER)
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
			pixels[i] = to_pixel(world.types[i], world.vals[i])
		}
		rl.UpdateTexture(write_tex, raw_data(pixels))

		rl.BeginDrawing()
		rl.ClearBackground(rl.BLACK)

		rl.DrawRectangle(0, 0, sw, ui_top, rl.Color{0, 0, 0, 180})
		rl.DrawText("Chromatose 3.0: Diffusion Engine", 10, 8, 20, rl.RAYWHITE)
		rl.DrawText("LMB: paint SOURCE   MMB: paint CONSUMER   RMB: erase to ETHER   SPACE: pause   R: reseed   C: clear   +/-: spread   P: pixel-perfect   F: reset view", 10, 30, 18, rl.RAYWHITE)
		rl.DrawText(rl.TextFormat("spread=%f   zoom=%.2f   sim=%dx%d", spread_f32, zoom, world.width, world.height), 10, ui_top-20, 18, rl.RAYWHITE)

		origin := rl.Vector2{0, 0}
		rl.DrawTexturePro(read_tex, src, dst, origin, 0, rl.WHITE)
		rl.DrawFPS(10, ui_top + 10)

		rl.EndDrawing()

		tmp := read_tex
		read_tex = write_tex
		write_tex = tmp
	}
}
