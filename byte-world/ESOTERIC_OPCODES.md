# Esoteric Opcodes - Chaos & Emergence

These 4 new opcodes introduce **non-determinism**, **action-at-a-distance**, and **information contagion** to the byte_world simulation, enabling unexpected complexity and emergent behaviors.

---

## OP_TUNNEL (211) - Quantum Leap
**Color:** Electric Purple (200, 0, 255)  
**Cost:** 4× COST_MOVE (0.8 energy)

### Mechanics
- Attempts to move **2 cells forward**, skipping the immediate neighbor
- Only succeeds if landing spot is permeable and unoccupied
- If blocked or landing on wall, fizzles with small energy penalty

### Emergent Behaviors
- **Containment Breach:** Closed ecosystems are no longer safe; walls must be 2+ thick
- **Island Hopping:** Lineages can evolve to hop between isolated regions
- **Hit-and-Run Tactics:** Invade colonies, steal energy via vampirism, retreat before defenders react
- **Maze Navigation:** Evolve to bypass simple barriers that trap normal sparks

---

## OP_MEME (212) - Information Contagion
**Color:** Neon Green (0, 255, 100)  
**Cost:** COST_MATH (0.1 energy)

### Mechanics
- If spark ahead exists, XOR both their registers bidirectionally
- Changes other spark's behavior **without killing them**
- Cheap operation encourages frequent use

### Emergent Behaviors
- **Ideologies:** Specific instruction patterns spread through populations like viruses
- **Behavior Infection:** A hunter catches "SPLIT virus" from prey, becomes erratic breeder
- **Hive-Mind Synchronization:** Colonies develop shared register states
- **Memetic Warfare:** Strategic "infection" of competing lineages with destructive behaviors
- **Cultural Transmission:** Successful strategies propagate without genetic inheritance

---

## OP_RAND (213) - The Oracle
**Color:** White/Silver (220, 220, 220)  
**Cost:** COST_MATH (0.1 energy)

### Mechanics
- Sets register to random value (0-255)
- Pure stochasticity injected into deterministic system

### Emergent Behaviors
- **Loop Breaking:** Escape oscillator traps and static patterns
- **Brownian Motion:** Random walk when stuck, enabling exploration
- **Probabilistic Branching:** Combined with OP_BRANCH creates "50% fight, 50% flee" behaviors
- **Simulated Annealing:** Random perturbations help escape local evolutionary minima
- **Genetic Diversity:** Prevents convergence to single dominant strategy
- **Risk-Taking:** Enables "gambling" strategies that occasionally pay off

---

## OP_MARK (214) - Pheromones/Stigmergy
**Color:** Deep Orange (255, 80, 0)  
**Cost:** COST_WRITE (1.0 energy) or COST_WRITE_WALL (2.0 for walls)

### Mechanics
- Writes register value to **current cell** (where spark is standing)
- Leaves trail behind as spark moves
- Subject to same solar write limits as OP_STORE

### Emergent Behaviors
- **Ant Colony Optimization:** Mark trails from food sources back to "home"
- **Pheromone Following:** Other sparks load trail markers and follow paths
- **Territory Marking:** Mark borders with specific values to signal ownership
- **Breadcrumb Navigation:** Leave trails to find way back to high-value regions
- **Self-Organizing Highways:** Well-traveled paths become reinforced
- **Dead-End Detection:** Mark explored areas to avoid revisiting
- **Recruitment:** "Follow me to food!" signals left in environment

---

## Synergistic Combinations

### 1. Trail-Following Food Scouts
```
OP_SENSE → detect solar
OP_MARK → leave "food found" trail
Return path: OP_TUNNEL to move fast
Followers: OP_LOAD trails, then follow
```

### 2. Stochastic Evasion
```
OP_SENSE → detect predator (spark ahead)
OP_RAND → randomize decision
OP_BRANCH → 50% flee, 50% fight
OP_TUNNEL → emergency escape hop
```

### 3. Memetic Warfare
```
OP_RAND → generate chaos payload
OP_MEME → infect enemy with junk instructions
Enemy behavior corrupted, lineage weakened
```

### 4. Adaptive Exploration
```
OP_MARK → mark dead ends with unique value
OP_LOAD → check if area already explored
OP_RAND + OP_BRANCH → probabilistic path choice
OP_TUNNEL → skip over known barriers
```

---

## Expected World Dynamics

### Before (Deterministic System)
- Sparks fall into loops and oscillators
- Walls create absolute barriers
- Populations freeze into static crystals
- Single dominant strategy emerges
- Islands never interact

### After (Chaotic System)
- **Dynamic Equilibrium:** Populations constantly adapt
- **Arms Races:** Counter-strategies to TUNNEL, MEME defenses
- **Emergence of Protocols:** Complex multi-step behaviors evolve
- **Spatial Structures:** Pheromone-based highways and territories
- **Information Economy:** Memes as valuable as energy
- **Unpredictable Patterns:** No two runs identical

---

## Implementation Notes

### OP_TUNNEL
- Must check `occ_stamp` at landing spot to avoid collision
- Updates `res.dest_x/dest_y/dest_idx` directly
- Main simulation loop handles actual position update

### OP_MEME
- Accesses `w.sparks_next.data[owner_id]` for victim
- Uses XOR for symmetric, reversible information mixing
- Safe in double-buffered system

### OP_RAND
- Uses world RNG state for deterministic replay
- Bounded to 0-255 to fit register size

### OP_MARK
- Reuses solar write tracking to prevent infinite solar generation
- Applies to current position, not ahead position
- Enables "where I've been" vs OP_STORE's "where I'm going"

---

## Tuning for Maximum Chaos

To amplify emergent complexity:

1. **Lower COST_MOVE** → Longer-lived sparks explore more
2. **Increase SPARK_CAP** → More interactions = more meme spread
3. **Reduce ENERGY_CAP** → Forces efficiency, rewards clever strategies
4. **Increase SOLAR_REGROWTH_RATE** → More resources = more competition
5. **Add OP_TUNNEL/MEME-rich patterns** → Seed advanced behaviors

---

## What to Watch For

### Successful Emergence
- **Pheromone trails** visible in alpha heat map
- **Waves of behavior** spreading through populations
- **Defensive walls** getting thicker (anti-TUNNEL)
- **Synchronized colonies** moving in coordination
- **Boom-bust cycles** as strategies counter each other

### Pathological Cases
- **Memetic collapse:** Everyone infected with junk, extinction
- **Tunnel spam:** Everything hopping randomly, no stable patterns
- **RAND addiction:** Population gets "lucky" but unsustainable
- **Marker pollution:** World filled with MARK debris, unreadable

---

*"The point of these opcodes isn't to make the simulation easier to understand—it's to make it impossible to predict, but endlessly fascinating to observe."*

