Here is the complete, consolidated Python implementation of the **Byte-Physics World**.

This script includes the simulation engine, the physics rules, the refined OpCodes (`LEFT`, `RIGHT`, `BRANCH`, `INC`, `DEC`), and a live Matplotlib visualization.

### How to Run
Simply run this script in any Python environment with `numpy` and `matplotlib` installed.

```python
import numpy as np
import matplotlib.pyplot as plt
import random

# --- 1. CONFIGURATION & CONSTANTS ---

GRID_SIZE = 100

# Value Ranges (The Ontology)
RANGE_VOID_MAX  = 63   # Empty space / Passive Data
RANGE_WALL_MAX  = 127  # Reflective matter (Even=H-Reflect, Odd=V-Reflect)
RANGE_SOLAR_MAX = 191  # Energy sources (Metabolism)
# 192 - 255 are "Active Instructions" (Ops)

# Metabolic Costs
COST_MOVE   = 0.2     # Entropy: Cost to exist/move per tick
COST_WRITE  = 5.0     # Work: Cost to change a grid value
COST_SPLIT  = 25.0    # Reproduction: Cost to create a child
COST_MATH   = 0.1     # Processing: Cost to compute (INC/DEC)
PENALTY_HIT = 0.5     # Damage: Cost when hitting a wall

# Metabolic Gains
SOLAR_BASE_GAIN = 1.0 # Minimum energy from a solar tile
SOLAR_BONUS_MAX = 2.0 # Additional energy based on tile intensity

# Op Codes
OP_LOAD   = 200 # Register = Grid[Ahead]
OP_STORE  = 201 # Grid[Ahead] = Register
OP_SPLIT  = 202 # Divide energy, spawn orthogonal child
OP_LEFT   = 203 # Turn 90 degrees Counter-Clockwise
OP_RIGHT  = 204 # Turn 90 degrees Clockwise
OP_INC    = 205 # Register++
OP_DEC    = 206 # Register--
OP_BRANCH = 207 # If Register < 128 Left, Else Right

# --- 2. THE AGENT ---

class Spark:
    def __init__(self, x, y, dx, dy, energy=50.0):
        self.x = int(x)
        self.y = int(y)
        self.dx = int(dx) # -1, 0, or 1
        self.dy = int(dy) # -1, 0, or 1
        self.energy = energy
        self.register = 0 # 8-bit payload (0-255)
        self.age = 0

# --- 3. THE WORLD & PHYSICS ENGINE ---

class BytePhysicsWorld:
    def __init__(self, size=GRID_SIZE):
        self.size = size
        
        # Initialize Grid with Low-Value Noise (Void/Data)
        self.grid = np.random.randint(0, 40, (size, size))
        self.sparks = []
        
        # --- GENESIS: Seeding the Primordial Soup ---
        # 1. Create clusters of Solar Energy (Food)
        for _ in range(30):
            cx, cy = np.random.randint(0, size), np.random.randint(0, size)
            radius = np.random.randint(2, 6)
            for y in range(cy-radius, cy+radius):
                for x in range(cx-radius, cx+radius):
                    if 0 <= x < size and 0 <= y < size:
                        self.grid[y, x] = np.random.randint(128, 192)

        # 2. Create random Wall debris (Obstacles/Shelter)
        for _ in range(200):
            rx, ry = np.random.randint(0, size), np.random.randint(0, size)
            self.grid[ry, rx] = np.random.randint(64, 128)

        # 3. Spawn Adam & Eve Sparks
        for _ in range(50):
            self.spawn_spark()

    def spawn_spark(self):
        # Random position and direction
        s = Spark(
            x=random.randint(0, self.size-1),
            y=random.randint(0, self.size-1),
            dx=random.choice([-1, 0, 1]),
            dy=random.choice([-1, 0, 1]),
            energy=random.randint(50, 80)
        )
        # Ensure it's moving
        if s.dx == 0 and s.dy == 0: s.dx = 1
        self.sparks.append(s)

    def step(self):
        """ The Main Physics Loop """
        next_sparks = []
        
        # Random execution order to prevent positional bias
        random.shuffle(self.sparks)
        
        for s in self.sparks:
            s.age += 1
            
            # 1. Calculate Potential Next Coordinates
            nx = (s.x + s.dx) % self.size
            ny = (s.y + s.dy) % self.size
            val = self.grid[ny, nx]
            
            did_move = False
            
            # --- PHYSICS INTERPRETER ---
            
            # RANGE A: VOID / DATA (0 - 63)
            # Permeable. Low entropy.
            if val <= RANGE_VOID_MAX:
                s.x, s.y = nx, ny
                did_move = True

            # RANGE B: WALLS / MIRRORS (64 - 127)
            # Impermeable. Reflective.
            elif val <= RANGE_WALL_MAX:
                # Physics: Elastic Collision
                if val % 2 == 0: 
                    s.dx = -s.dx # Horizontal Bounce
                else: 
                    s.dy = -s.dy # Vertical Bounce
                
                s.energy -= PENALTY_HIT # Kinetic energy loss

            # RANGE C: METABOLISM (128 - 191)
            # Permeable. Energy Gain.
            elif val <= RANGE_SOLAR_MAX:
                s.x, s.y = nx, ny
                did_move = True
                
                # Photosynthesis
                # Higher value = More energy efficiency
                efficiency = (val - 128) / 64.0 
                gain = SOLAR_BASE_GAIN + (efficiency * SOLAR_BONUS_MAX)
                s.energy += gain

            # RANGE D: OPERATORS (192 - 255)
            # Permeable. Execution.
            else:
                s.x, s.y = nx, ny
                did_move = True
                
                # "Look Ahead" Coordinates (for Read/Write)
                ax = (s.x + s.dx) % self.size
                ay = (s.y + s.dy) % self.size
                
                # --- MEMORY OPS ---
                if val == OP_LOAD:
                    s.register = self.grid[ay, ax]
                    
                elif val == OP_STORE:
                    if s.energy > COST_WRITE:
                        self.grid[ay, ax] = s.register
                        s.energy -= COST_WRITE
                
                # --- REPRODUCTION ---
                elif val == OP_SPLIT:
                    if s.energy > COST_SPLIT:
                        # Child spawns with orthogonal velocity
                        # If parent is moving X, child moves Y
                        child = Spark(s.x, s.y, -s.dy, s.dx, energy=s.energy/2)
                        child.register = s.register
                        next_sparks.append(child)
                        s.energy /= 2 # Parent loses half energy

                # --- SPATIAL NAVIGATION (Fixed) ---
                elif val == OP_LEFT:
                    # Rotate Velocity Vector 90 deg CCW
                    # (1,0) -> (0,1) -> (-1,0) -> (0,-1)
                    s.dx, s.dy = s.dy, -s.dx

                elif val == OP_RIGHT:
                    # Rotate Velocity Vector 90 deg CW
                    s.dx, s.dy = -s.dy, s.dx

                # --- COMPUTATION ---
                elif val == OP_INC:
                    s.register = (s.register + 1) % 256
                    s.energy -= COST_MATH
                    
                elif val == OP_DEC:
                    s.register = (s.register - 1) % 256
                    s.energy -= COST_MATH

                # --- LOGIC CONTROL (Branching) ---
                elif val == OP_BRANCH:
                    # The "If Statement"
                    if s.register < 128:
                        # Turn Left
                        s.dx, s.dy = s.dy, -s.dx
                    else:
                        # Turn Right
                        s.dx, s.dy = -s.dy, s.dx

            # 2. Entropy & Cap
            s.energy -= COST_MOVE
            if s.energy > 250: s.energy = 250 # Max capacity
            
            # 3. Survival Check
            if s.energy > 0:
                next_sparks.append(s)
        
        # Extinction failsafe (Simulated 'panspermia')
        if len(next_sparks) < 5:
            self.spawn_spark()
            
        self.sparks = next_sparks

    def render_frame(self):
        """ Generates an RGB image for visualization """
        # Initialize black background
        img = np.zeros((self.size, self.size, 3))
        
        # 1. Render The Grid
        # Void (0-63): Dark Grey
        mask_void = (self.grid <= RANGE_VOID_MAX)
        img[mask_void] = 0.1
        
        # Wall (64-127): Blue shades
        mask_wall = (self.grid > RANGE_VOID_MAX) & (self.grid <= RANGE_WALL_MAX)
        # Normalize to 0.0-1.0 for brightness variation
        wall_brightness = (self.grid[mask_wall] - 64) / 64.0
        img[mask_wall, 2] = 0.4 + (wall_brightness * 0.6) # Blue Channel
        
        # Solar (128-191): Green/Yellow shades
        mask_solar = (self.grid > RANGE_WALL_MAX) & (self.grid <= RANGE_SOLAR_MAX)
        solar_brightness = (self.grid[mask_solar] - 128) / 64.0
        img[mask_solar, 0] = solar_brightness * 0.8  # Red
        img[mask_solar, 1] = 0.4 + (solar_brightness * 0.6) # Green
        
        # Ops (192-255): Red/Pink shades
        mask_op = (self.grid > RANGE_SOLAR_MAX)
        img[mask_op, 0] = 0.9 # High Red
        img[mask_op, 2] = 0.5 # Some Blue (Magenta-ish)
        
        # 2. Render Sparks
        # We draw them as bright white pixels
        for s in self.sparks:
            img[s.y, s.x] = [1.0, 1.0, 1.0]
            
        return img

# --- 4. RUNNER ---

if __name__ == "__main__":
    world = BytePhysicsWorld(size=100)
    
    print("--- BYTE-PHYSICS WORLD INITIALIZED ---")
    print("Ranges: 0-63(Void), 64-127(Wall), 128-191(Solar), 192+(Ops)")
    print("Ops: 200:Load 201:Store 202:Split 203:Left 204:Right 207:Branch")
    
    # Matplotlib Setup
    plt.ion()
    fig, ax = plt.subplots(figsize=(8, 8))
    # Hide axes for cleaner look
    ax.set_xticks([])
    ax.set_yticks([])
    
    img_plot = ax.imshow(world.render_frame(), interpolation='nearest')
    
    step_count = 0
    try:
        while True:
            world.step()
            step_count += 1
            
            # Update visuals every few ticks for speed
            if step_count % 5 == 0:
                img_plot.set_data(world.render_frame())
                ax.set_title(f"Tick: {step_count} | Sparks: {len(world.sparks)}")
                plt.pause(0.001) # Short pause to update GUI
                
    except KeyboardInterrupt:
        print("\nSimulation Stopped.")
```