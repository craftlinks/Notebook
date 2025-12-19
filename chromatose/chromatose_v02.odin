package chromatose

import rl "vendor:raylib"

WINDOW_W :: 1024
WINDOW_H :: 1024

SIM_W :: 256
SIM_H :: 256

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
	if t == .CODE && op == .PORE {
		// PORE op-cell: permeable red wall that allows energy diffusion
		return rl.Color{255, 80, 80, 255}
	}
	if t == .CODE {
		if op == .GROW {
			// GROW: motile head
			return rl.Color{120, 180, 255, 255}
		}
		if op == .WRITE {
			// WRITE: scanner walker
			return rl.Color{220, 120, 255, 255}
		}
		if op == .SWAP {
			// SWAP: swapper cell
			return rl.Color{255, 180, 120, 255}
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
	cfg := sim_config_default()
	world_seed(&world, u32(rl.GetTime()*1000.0), cfg)

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

	spread_f32 := cfg.spread_rate
	brush_cell_op: Op_Code = .WRITE
	paint_dir_move:  u8 = 0
	paint_dir_read:  u8 = 0
	paint_dir_write: u8 = 0
	paint_gene: u16 = DEFAULT_WRITE_GENE

	for !rl.WindowShouldClose() {
		if rl.IsKeyPressed(.SPACE) { paused = !paused }
		if rl.IsKeyPressed(.R)     { world_seed(&world, u32(rl.GetTime()*1000.0), cfg) }
		if rl.IsKeyPressed(.C)     { world_clear(&world) }
		if rl.IsKeyPressed(.F)     { zoom = 1.0; pan = rl.Vector2{0, 0} }
		if rl.IsKeyPressed(.P)     { pixel_perfect = !pixel_perfect }
		if rl.IsKeyPressed(.ONE)   { brush_cell_op = .IDLE }
		if rl.IsKeyPressed(.TWO)   { brush_cell_op = .GROW }
		if rl.IsKeyPressed(.THREE) { brush_cell_op = .WRITE }
		if rl.IsKeyPressed(.FOUR)  { brush_cell_op = .SWAP }
		
		// FIVE key paints PORE op-cells directly
		paint_pore := false
		if rl.IsKeyPressed(.FIVE) { paint_pore = true }
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

		// HUD layout (screen-space). Keep this self-contained so it can't overlap itself.
		title_font_size :: 20
		body_font_size  :: 18
		pad_y           :: 6

		// Compute how much vertical space we need for the HUD.
		// Title + 2 help lines + status line + padding.
		ui_top: i32 = i32(8 + title_font_size + pad_y + (body_font_size+2)*3 + pad_y)
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
			if paint_pore {
				world_set_cell(&world, cx, cy, .CODE, .PORE, 0, 0, 0, 0)
			} else if rl.IsMouseButtonDown(.LEFT) {
				world_set_cell(&world, cx, cy, .SOURCE, .IDLE, 0, 0, 0, 0)
				// Maintain SOURCE cap even while paused (sim_tick won't run).
				world_enforce_source_cap(&world, cfg)
			} else if rl.IsMouseButtonDown(.MIDDLE) {
				gene := u16(0)
				if brush_cell_op == .WRITE {
					gene = paint_gene
				}
				// For SWAP cells, generate a random second read direction (different from first).
				dir_read2: u8 = 255 // default (will use fallback in world_set_cell)
				if brush_cell_op == .SWAP {
					// Simple RNG based on time and position for randomness when painting
					seed := u32(rl.GetTime()*1000.0) ~ u32(cx*73856093) ~ u32(cy*19349663)
					seed ~= seed << 13
					seed ~= seed >> 17
					seed ~= seed << 5
					dir_read2 = u8(seed % 8)
					// Ensure dir_read2 is different from paint_dir_read
					for dir_read2 == paint_dir_read {
						seed ~= seed << 13
						seed ~= seed >> 17
						seed ~= seed << 5
						dir_read2 = u8(seed % 8)
					}
				}
				world_set_cell(&world, cx, cy, .CODE, brush_cell_op, paint_dir_move, paint_dir_read, paint_dir_write, gene, dir_read2)
			} else if rl.IsMouseButtonDown(.RIGHT) {
				world_set_cell(&world, cx, cy, .ETHER, .IDLE, 0, 0, 0, 0)
			}
		}

		if !paused {
			cfg.spread_rate = spread_f32
			sim_tick(&world, cfg)
		}

		for i in 0..<len(pixels) {
			pixels[i] = to_pixel(world.types[i], world.vals[i], world.ops[i])
		}
		rl.UpdateTexture(write_tex, raw_data(pixels))

		rl.BeginDrawing()
		rl.ClearBackground(rl.BLACK)

		rl.DrawRectangle(0, 0, sw, ui_top, rl.Color{0, 0, 0, 180})
		hud_x: i32 = 10
		hud_y: i32 = 8
		rl.DrawText("Chromatose 3.0: Diffusion Engine", hud_x, hud_y, title_font_size, rl.RAYWHITE)
		hud_y += title_font_size + pad_y
		rl.DrawText("LMB: paint SOURCE   MMB: paint CODE   RMB: erase to ETHER   SPACE: pause   R: reseed   C: clear   +/-: spread   P: pixel-perfect   F: reset view", hud_x, hud_y, body_font_size, rl.RAYWHITE)
		hud_y += body_font_size + 2
		rl.DrawText("1: CODE=IDLE(wall)   2: CODE=GROW(head)   3: CODE=WRITE(walker)   4: CODE=SWAP(swapper)   5: CODE/PORE(red wall)   Wheel: dir_move   Shift+Wheel: dir_read   Alt+Wheel: dir_write   Ctrl+Wheel: zoom", hud_x, hud_y, body_font_size, rl.RAYWHITE)
		hud_y += body_font_size + 2
		rl.DrawText(rl.TextFormat("spread=%.2f   zoom=%.2f   sim=%dx%d   cell_op=%d   move=%d read=%d write=%d gene=%d", spread_f32, zoom, world.width, world.height, u8(brush_cell_op), paint_dir_move, paint_dir_read, paint_dir_write, paint_gene), hud_x, hud_y, body_font_size, rl.RAYWHITE)

		origin := rl.Vector2{0, 0}
		rl.DrawTexturePro(read_tex, src, dst, origin, 0, rl.WHITE)
		rl.DrawFPS(10, ui_top + 10)

		rl.EndDrawing()

		tmp := read_tex
		read_tex = write_tex
		write_tex = tmp
	}
}

 