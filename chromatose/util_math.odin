package chromatose

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

abs_f32 :: proc(x: f32) -> f32 {
	if x < 0 { return -x }
	return x
}


