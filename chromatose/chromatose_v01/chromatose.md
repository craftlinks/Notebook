Here is the finalized specification for **Chromatose 2.0**.

---

# Chromatose 2.0 Specification
**"The Continuous Medium"**

---

## How to read the demo (renderer legend)

### Colors
- **Ether (`COLOR == 0`)**: grayscale where **brightness = `VAL`** (0..255).
- **Organism (`COLOR in 1..255`)**: **hue = `COLOR` id**, **brightness = `VAL`** (clamped to a minimum so structure stays visible).
- **`WALL`**: dark gray (inert).
- **Refractory (`REFR > 0`)**: organism cells are drawn dim (“burnt out”).
- **Highlighted opcodes** (fixed colors so you can spot them quickly):
  - **`WRITE`**: magenta
  - **`CLAIM`**: cyan
  - **`INJECT`**: red
  - **`PORE`**: green
  - **`PUMP`**: orange
  - **`CAP`**: blue
  - **`DIODE_*`**: yellow

### Seeing the “instruction” (`OP`) per cell
- **Hover** a cell: the UI shows `OP`, `VAL`, `COLOR`, and `REFR`.
- Press **`I`** to toggle the **per-cell opcode overlay** (drawn as a **hex digit** `0..C` matching the enum value).  
  - Note: **`WRITE` encodes the target opcode as `VAL & 0x0F`**, so the overlay digits line up with what `WRITE` can produce.

### Keybinds (demo)
- **SPACE**: pause
- **TAB**: next preset
- **R**: reseed current preset
- **D/C/L/E/N**: jump to specific demos (leak/conflict/loop-zoo/excitable/noise)
- **P**: toggle pixel-perfect integer scaling
- **F**: reset view (zoom + pan)
- **H**: cycle help overlay (**off → compact → full**)
- **G**: toggle grid overlay

### 1. Core Philosophy
The universe is not a void; it is a pressurized, dissipative medium called **The Ether**. Life is not just the presence of matter, but the ability to maintain **Order** (Structure + Energy) against **Entropy** (Dissipation).

*   **Ether (Chaos):** The default state. It conducts energy but dissipates it rapidly (halving signal strength). It has no memory and no loyalty.
*   **Organism (Order):** A region of the grid with a unified ID (`COLOR`). It uses insulated Hulls (`WALL`) to keep its internal energy signals (`VAL`) from leaking into the Ether.

### 2. The Data Layers
Each cell in the grid contains four pieces of data:

1.  **`OP` (Instruction):** The functional logic (Enum).
2.  **`VAL` (Energy/Data):** An 8-bit unsigned integer (0-255).
3.  **`COLOR` (Identity):**
    *   `0`: **Ether** (The background).
    *   `1..255`: **Organism IDs**.
4.  **`REFR` (Refractory Timer):** An 8-bit counter for the excitable medium state.

---

### 3. The Physics of Time & Energy

The simulation runs in a **Split-Phase Tick** (Interaction $\to$ Resolution) to ensure parallel determinism.

#### A. The State Machine
Organism cells behave as an **Excitable Medium**, while Ether behaves as a **Linear Dissipative Medium**.

1.  **Resting (`REFR == 0`):** The cell accepts input from neighbors.
2.  **Excited:** If a Resting cell accumulates `VAL >= FIRING_THRESHOLD` (10), it:
    *   Fires its energy to neighbors (Phase 1).
    *   Enters **Refractory** mode (Phase 2).
3.  **Refractory (`REFR > 0`):**
    *   The cell **ignores all input**.
    *   The cell emits **0** energy.
    *   `REFR` decrements by 1 each tick.
    *   *Purpose:* Prevents signal saturation and infinite loops; enables "waves" of logic.

**Ether Exception:** Ether cells (`COLOR == 0`) never enter Refractory mode. They always accept energy, halve it (`Output = Input >> 1`), and emit it.

#### B. Permeability Rules (The Membrane)
Can Cell A send energy to Neighbor B?

1.  **Cohesion (Same Color):** YES.
2.  **Dissipation (Target is Ether):** YES. (This causes "Bleeding").
3.  **Rejection (Different Colors):** NO. (Blocked by membrane integrity).
    *   *Exception 1 (Inbound):* If Target B is a **`PORE`**, it allows entry (Sensor).
    *   *Exception 2 (Outbound):* If Source A is a **`PUMP`**, it forces exit (Weapon/Communication).

---

### 4. The Instruction Set

#### Structural (The Hull)
*   **`ETHER`**: The medium. Decays signal. Permeable to all.
*   **`WALL`**: Inert. Accepts no energy, emits no energy. Used to insulate wires from the Ether.
*   **`WIRE`**: Standard conductor.
*   **`CAP`**: Capacitor. Stores input in a buffer, releases it 1 tick later.
*   **`DIODE (N/S/E/W)`**: Allows flow *only* in the arrow direction. Blocks input from sides/reverse.

#### Active (The Metabolism)
*   **`WRITE`**: Uses `VAL` to overwrite the neighbor's `OP`.
    *   *Encoding:* Target Opcode = `VAL & 0x0F`.
    *   *Vs Ether:* Auto-Claims the cell (sets `COLOR` to writer). This is how organisms grow/move.
    *   *Vs Enemy:* Requires `VAL >= 200` to overwrite internal cells, `VAL >= 250` to overwrite Walls. Does **not** change Color (sabotage only).
*   **`CLAIM`**: Uses `VAL` to overwrite the neighbor's `COLOR`.
    *   *Vs Ether:* Easy.
    *   *Vs Enemy:* Requires `VAL >= 220`.
*   **`INJECT`**: Overwrites the neighbor's `VAL` (Energy).
    *   *Use:* To power internal circuits or overload/crash enemy circuits.

#### Interface (The Membrane)
*   **`PORE` (Sensor):**
    *   **Unidirectional Inbound:** Allows foreign color signals to enter the cell.
    *   *Use:* Detecting heat trails in the Ether.
*   **`PUMP` (Excretor):**
    *   **Unidirectional Outbound:** Forces energy into a foreign neighbor.
    *   *Use:* Attacking or clearing waste heat.

---

### 5. Emergent Dynamics

#### 1. Bleeding & Stealth
*   A `WIRE` carrying 200 energy touches `ETHER`.
*   The `ETHER` accepts the 200, halves it to 100, and emits it. The next Ether cell gets 50, then 25, 12, 6, 3, 1.
*   **Result:** A "Heat Halo" surrounds the organism.
*   **Counter-measure:** Organisms must wrap themselves in `WALL` cells to prevent data loss and detection.

#### 2. Locomotion (Terraforming)
An organism moves by constantly rebuilding itself:
1.  **Head:** `WRITE` heads extend into the Ether, claiming pixels and turning them into `WIRE`/`WALL`.
2.  **Body:** Energy flows through the new wires.
3.  **Tail:** A "Cleanup" circuit writes `ETHER` to the trailing cells, returning them to the soup.

#### 3. Predation
1.  **Scent:** Predator uses `PORE` cells on its skin. If `Input > 0`, it means Prey is nearby (leaking energy).
2.  **Chase:** Predator grows toward the gradient maximum.
3.  **Kill:**
    *   *Method A (Breach):* Use `WRITE` (High Strength) to turn Prey's `WALL` into `WIRE`. Prey bleeds out; Predator sucks up the energy.
    *   *Method B (Overload):* Use `PUMP` or `INJECT` to force 255 Energy into Prey's logic, jamming its refractory timers and freezing it.

---

### 6. Tuning Constants

| Constant | Value | Description |
| :--- | :--- | :--- |
| `FIRING_THRESHOLD` | 10 | Minimum `VAL` required to emit energy & trigger refractory state. |
| `REFRACTORY_PERIOD` | 2 | Ticks a cell sleeps after firing. |
| `ETHER_DECAY` | `>> 1` | Bitshift decay (Halving) per tick in Ether. |
| `CROSS_COLOR_FORCE` | 200 | Energy needed to `WRITE` on an enemy internal cell. |
| `WALL_INTEGRITY` | 250 | Energy needed to `WRITE` on an enemy `WALL`. |
| `CLAIM_TAKEOVER` | 220 | Energy needed to `CLAIM` an enemy cell. |