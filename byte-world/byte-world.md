# TerraByte -- A ByteWorld Simulation

**TerraByte** is a 2D artificial life simulation based on "Byte Physics." In this world, the grid acts as both **terrain** and **executable code**. Agents, called **Sparks**, are tiny virtual machines that traverse the grid, interpreting the byte value of the cell they step on as an instruction.

The simulation is an evolutionary sandbox where Sparks must manage their energy (entropy) to survive. They execute code to move, manipulate memory, reproduce, and fight. The environment is dynamic: energy sources grow naturally, dead sparks recycle into food, and heavily used code paths burn out into "slag" (walls) due to heat damage. The goal is to observe emergent behaviors, self-replicating organisms, and digital ecosystems.

---

### Simulation Rules

#### 1. The World (Grid Ontology)
The world is a grid of 8-bit integers (`u8`), where the value determines the cell's function:
*   **0–63 (VOID):** Empty space. Sparks move through it but nothing happens.
*   **64–127 (WALL):** Reflective matter. Sparks bounce off these cells. Even numbers reflect horizontally; odd numbers reflect vertically.
*   **128–191 (SOLAR):** Energy sources. If a Spark steps here, it gains energy, and the tile is consumed (turned to VOID).
*   **192–255 (OPS):** Active instructions. If a Spark steps here, it executes a specific operation.

#### 2. The Agent (The Spark)
A Spark is a single-pixel entity with the following state:
*   **Energy:** Consumed by existing, moving, and processing. If it hits 0, the Spark dies.
*   **Register:** An 8-bit memory slot for holding data.
*   **Inventory:** A slot to carry one grid tile (cargo).
*   **Direction:** Moving X and Y (-1, 0, or 1).
*   **Color:** Indicates lineage/species (inherited from parent).

#### 3. Metabolism & Physics
*   **Movement Cost:** 0.2 energy per tick.
*   **Execution Cost:** Math/Logic costs 0.1; Writing to the grid costs 1.0 (or 2.0 for overwriting walls).
*   **Reproduction Cost:** 6.0 energy.
*   **Death:** Occurs if Energy < 0 or Age > 1000 ticks.
*   **Corpse Recycling:** When a Spark dies (from age or starvation), it deposits its remaining energy into the grid as a **Solar** tile (biomass), allowing other Sparks to feed on the dead.

#### 4. The Instruction Set (Ops)
When a Spark enters a cell with a value > 191, it executes an Op:
*   **Memory:**
    *   `LOAD` (200): Register = Value of the cell ahead.
    *   `STORE` (201): Cell ahead = Register value. (Costs energy).
*   **Locomotion:**
    *   `LEFT` (203) / `RIGHT` (204): Rotates the Spark 90°.
    *   `BRANCH` (207): Turns Left if Register < 128, otherwise turns Right.
*   **Biology:**
    *   `SPLIT` (202): Spits half the energy into a new child Spark in an adjacent cell. The child inherits the parent's code (Register) and Color (with slight mutation).
*   **Logic:**
    *   `INC` (205) / `DEC` (206): Modifies the Register value.
    *   `SENSE` (208): Sonar. Scans 3 cells ahead. Register becomes: 0 (Wall), 255 (Solar), 128 (Empty), or 50 (Enemy Spark).
*   **Manipulation:**
    *   `PICKUP` (209): Swaps the Spark's Inventory with the cell ahead.
    *   `DROP` (210): Places Inventory into the cell ahead (if the cell ahead is Void).

#### 5. Conflict & Occupancy
*   **One per Cell:** Only one Spark can occupy a cell at a time.
*   **Collision:** Hitting a Wall or a Blocked cell causes the Spark to bounce or stop, incurring a damage penalty.
*   **Predation (Vampirism):** If a Spark tries to move into a cell occupied by a Spark of a **different color**:
    *   If the attacker has **strictly higher energy**, it kills the occupant.
    *   The attacker absorbs **50%** of the victim's energy.
    *   If they are the same color, the move is simply blocked.

#### 6. Environmental Dynamics
*   **Solar Regrowth:** Random Void tiles slowly turn into Solar tiles (food).
*   **Heat Damage (Entropy):** Cells that are visited frequently gain "Heat" (Alpha). If a cell gets too hot, there is a chance it burns out and permanently turns into a **WALL**, destroying the instruction or food that was there.
*   **Tides/Seasons:** An optional global cycle that raises and lowers the maximum energy gained from Solar tiles over time.
*   **Panspermia:** If the population drops to zero (or via auto-timer), new random Sparks are injected into the world to restart life.