Here is the ultra-minimal specification for **Chromatose 3.0** as currently implemented in `chromatose_v02.odin`.

This is a pure **Diffusion / Relaxation Engine** with interactive painting.

---

# Chromatose 3.0 Specification (Implementation-Accurate)
**"The Radiant Field (Relaxation)"**

### 1. The Data Structure
Each cell contains two values:
1. **`TYPE` (`Cell_Type`)**: discrete material type.
2. **`VAL` (`f32`, range \([0, 512]\))**: thermal energy field.

The simulation uses **double buffering** for both `TYPE` and `VAL` (`types/vals` and `next_types/next_vals`).

### 2. The Types

| ID | Name | Description | Physics |
| :--- | :--- | :--- | :--- |
| **0** | **ETHER** | The medium. | Variable `VAL`. Updates every tick. |
| **1** | **SOURCE** | A vent/heat source. | Fixed `VAL = 512`. Never changes. |
| **2** | **CONSUMER** | A sink/drain. | Fixed `VAL = 0`. Never changes. |

### 3. Boundary Condition (Sampling)
When sampling neighbors, coordinates are **clamped to the grid** (no-flux / Neumann-ish). That means edges do not artificially darken; out-of-bounds samples read the nearest edge cell.

Additionally, when sampling a cell:
- If `TYPE == SOURCE`, the sampled value is **512**.
- If `TYPE == CONSUMER`, the sampled value is **0**.
- Else the sampled value is the stored `VAL`.

### 4. The Physics (Synchronous Update)
Every tick computes **Next** from **Current** (synchronous / double buffered).

#### For `SOURCE` Cells:
\[
VAL_{next} = 512
\]

#### For `CONSUMER` Cells:
\[
VAL_{next} = 0
\]

#### For `ETHER` Cells:
1. **Sample 8 neighbors** (N, S, E, W, NE, NW, SE, SW) using the clamped sampling rule above.
2. **Average**: \(neighbor\_avg = \frac{\sum neighbors}{8}\)
3. **Relaxation step** (explicit):
\[
VAL_{next} = clamp\Big(VAL_{cur} + (neighbor\_avg - VAL_{cur}) \cdot spread\_rate,\ 0,\ 512\Big)
\]

Where:
- `spread_rate` is a runtime parameter (hotkey-adjustable) intended to stay in **\([0, 1]\)**.
- There is **no explicit decay constant** in this implementation.

### 5. Expected Behavior (As Implemented)
- **Sources** remain bright peaks.
- **Ether** forms smooth gradients and “blur” diffusion around sources.
- With **no sinks** and **no decay**, the field will eventually “bathtub fill” toward the source value (512) over time (uniform saturation).
- **Consumers** create persistent valleys (sinks) and can prevent full saturation.

### 6. Interaction / Controls (As Implemented)
- **LMB**: paint `SOURCE`
- **MMB**: paint `CONSUMER`
- **RMB**: erase to `ETHER` (does not forcibly zero `VAL`)
- **SPACE**: pause
- **R**: reseed (single source at center)
- **C**: clear
- **+ / -**: adjust `spread_rate`