# Survival of the Fittest - Implementation Summary

## Overview
Two critical evolutionary mechanics have been injected into the byte-world simulation to transform it from a passive "growing mold" system into an active battleground with true survival-of-the-fittest dynamics.

---

## 1. Predatory Energy Transfer (Vampirism)

### The Problem
Previously, when a spark took over an occupied cell, the victim's energy simply vanished. There was no incentive for conflict - destroying another spark was purely incidental and actually cost the aggressor energy.

### The Solution
**Energy Absorption:** When a spark defeats another (different color + strictly higher energy), the victor now absorbs **50% of the victim's remaining energy**.

### Implementation Details

#### Modified Function: `occ_claim_or_takeover`
```odin
occ_claim_or_takeover :: proc(w: ^Byte_World, cell_idx: int, s_new: Spark) 
    -> (ok: bool, did_takeover: bool, loot: f32)
```

**Key Change:** The function now returns a third value `loot` - the energy gained from defeating a victim.

**Logic:**
```odin
if !color_equal(occupant.color, s_new.color) && s_new.energy > occupant.energy {
    // The victor absorbs 50% of the victim's remaining energy
    loot := occupant.energy * 0.5
    w.sparks_next.data[owner_idx] = s_new
    return true, true, loot
}
```

#### Updated Call Sites in `byte_world_step`

**1. Normal Movement (Line ~924):**
```odin
if ok, _, loot := occ_claim_or_takeover(w, attempt.dest_idx, s_move); ok {
    s = s_move
    
    // Apply the predatory gain (Vampirism)
    s.energy += loot
    if s.energy > ENERGY_CAP { s.energy = ENERGY_CAP }
    
    // ... rest of logic ...
}
```

**2. Blocked Stay-in-Place (Line ~983):**
```odin
if stay_survives {
    if ok, _, loot := occ_claim_or_takeover(w, current_idx, s_stay); ok {
        // Apply loot even when staying in place
        s_stay.energy += loot
        if s_stay.energy > ENERGY_CAP { s_stay.energy = ENERGY_CAP }
    }
}
```

### Evolutionary Impact
- **Other colors become a food source** - sparks actively benefit from hunting
- **Aggressive movement patterns** are rewarded with energy
- **Efficient hunters** gain competitive advantage over passive growers
- **Color diversity** becomes strategically important

---

## 2. Lineage Mutation (Speciation)

### The Problem
Child sparks were exact clones of their parents' color. This created static "teams" with no genetic drift. A successful color would simply expand indefinitely with no internal variation or sub-species evolution.

### The Solution
**Color Drift:** Each child spark now has a **10% chance per RGB channel** to mutate slightly (±15 units), creating gradual color variation across generations.

### Implementation Details

#### New Helper Functions

**Clamp Function:**
```odin
clamp :: proc(v, min_v, max_v: i32) -> i32 {
    if v < min_v { return min_v }
    if v > max_v { return max_v }
    return v
}
```

**Mutation Function:**
```odin
mutate_color :: proc(c: rl.Color, rng: ^u32) -> rl.Color {
    r := c.r
    g := c.g
    b := c.b
    
    // 10% chance to drift each channel
    drift :: 15
    if rng_u32_bounded(rng, 100) < 10 {
        delta := i32(rng_u32_bounded(rng, drift*2 + 1)) - drift
        new_r := clamp(i32(r) + delta, 50, 255) // Keep visible (>50)
        r = u8(new_r)
    }
    // ... same for green and blue channels ...
    
    return rl.Color{r, g, b, 255}
}
```

**Design Choices:**
- **10% chance per channel** - frequent enough for evolution, rare enough to preserve lineage
- **±15 drift range** - small enough for gradual change, large enough to be visible
- **Minimum brightness 50** - prevents invisible/black mutations
- **Maximum brightness 255** - prevents color overflow

#### Modified OP_SPLIT Case (Line ~790)
```odin
case OP_SPLIT:
    if res.s.energy > COST_SPLIT {
        half_energy := res.s.energy * 0.5
        half_age := res.s.age / 2
        
        // --- INJECTED MECHANIC: MUTATION ---
        new_color := mutate_color(res.s.color, &w.rng)
        
        child := Spark{
            x = nx,
            y = ny,
            dx = -res.s.dy,
            dy = res.s.dx,
            energy = half_energy,
            register = res.s.register,
            age = half_age,
            solar_writes = 0,
            color = new_color, // Use the mutated color
            inventory = res.s.inventory,
        }
        // ...
    }
```

### Evolutionary Impact
- **Sub-species emergence** - successful lineages fracture into variants
- **Color gradients** - you'll see "family trees" of related colors
- **Beneficial mutations** - if a mutation leads to better code patterns, it spreads
- **Speciation events** - eventually mutated colors become distinct enough to prey on ancestors

---

## Combined Effect: True Darwinian Evolution

### Feedback Loop
1. **Mutation** creates variation within a successful lineage
2. **Predation** tests which variants are most efficient
3. **Energy transfer** amplifies the success of superior variants
4. **Repeat** - the cycle accelerates evolution

### Expected Behaviors

#### Short Term (100-1000 ticks)
- Initial color diversity from random spawning
- Emergence of "winning" code patterns
- Formation of monolithic color blocks

#### Medium Term (1000-10000 ticks)
- Color gradients within dominant blocks (mutation accumulation)
- First "civil wars" as mutants prey on ancestors
- Fragmentation of monolithic blocks

#### Long Term (10000+ ticks)
- Continuous arms race between color lineages
- Rapid turnover of dominant species
- Complex predator-prey dynamics
- No stable equilibrium - constant evolution

### Visual Indicators of Success

**Before these changes:**
- Uniform color blocks
- Slow expansion
- Peaceful coexistence

**After these changes:**
- Color gradients and halos
- Sharp boundaries (battle lines)
- Rapid color turnover
- Visible "invasions" and "extinctions"

---

## Tuning Parameters

If you want to adjust the evolutionary dynamics:

### Mutation Rate
In `mutate_color`:
```odin
if rng_u32_bounded(rng, 100) < 10  // Change 10 to adjust (0-100)
```
- **Lower (5):** Slower evolution, more stable lineages
- **Higher (20):** Faster evolution, more chaotic

### Mutation Magnitude
```odin
drift :: 15  // Change 15 to adjust (1-50)
```
- **Lower (5):** Subtle color changes, gradual evolution
- **Higher (30):** Dramatic color shifts, rapid speciation

### Vampirism Percentage
In `occ_claim_or_takeover`:
```odin
loot := occupant.energy * 0.5  // Change 0.5 (0.0-1.0)
```
- **Lower (0.25):** Weaker predation incentive
- **Higher (0.75):** Stronger predation incentive
- **1.0:** Full energy transfer (maximum aggression)

### Color Visibility Threshold
```odin
new_r := clamp(i32(r) + delta, 50, 255)  // Change 50 to adjust
```
- **Lower (0):** Allow dark colors (harder to see)
- **Higher (100):** Force bright colors only

---

## Testing the Changes

### Quick Verification
1. **Compile:** `odin build byte_world.odin -file -out:byte-world`
2. **Run:** `./byte-world`
3. **Load a pattern:** Press `L` (or middle-click) to spawn an organism
4. **Watch for:**
   - Color gradients forming around the organism
   - Energy spikes when colors collide
   - Rapid color changes in contested areas

### What Success Looks Like
- **Spark count stability:** Population should remain healthy (not crash to 0)
- **Color diversity:** Multiple color families competing
- **Dynamic boundaries:** Battle lines that shift over time
- **Energy accumulation:** High-energy sparks (>200) from successful predation

### What Failure Looks Like
- **Extinction:** All sparks die (mutation too strong or predation too weak)
- **Monoculture:** One color dominates forever (mutation too weak)
- **Stagnation:** No visible change after 10000 ticks

---

## Code Quality Notes

### Changes Made
1. ✅ Modified `occ_claim_or_takeover` signature (backward incompatible)
2. ✅ Updated all call sites to handle loot parameter
3. ✅ Added `clamp` and `mutate_color` helper functions
4. ✅ Modified `OP_SPLIT` to apply mutation
5. ✅ No linter errors
6. ✅ Successful compilation

### Potential Future Enhancements
- **Mutation history tracking:** Store "family tree" for visualization
- **Adaptive mutation rate:** Higher mutation under stress
- **Color-coded strategies:** Certain color ranges prefer certain behaviors
- **Sexual reproduction:** Combine colors from two parents
- **Immunity:** Sparks become resistant to similar colors

---

## Conclusion

These two simple changes inject genuine evolutionary pressure into your simulation:

1. **Vampirism** turns passive coexistence into active competition
2. **Mutation** ensures that competition never settles into stasis

The result: A living, evolving digital ecosystem where colors war for dominance, species rise and fall, and the "fittest" code patterns naturally emerge through pure selection pressure.

**The universe is no longer a garden. It's a battlefield.**


