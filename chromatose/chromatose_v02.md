# Chromatose 3.0 Specification
**"The 8-Neighbor Standard"**

### 1. The Data Structure
Each grid unit contains three values (Double Buffered):
1. **`TYPE` (`Cell_Type`, u8)**: Material classification.
2. **`VAL` (`f32`, range \([0, 512]\))**: Thermal energy / Charge.
3. **`OP` (`Op_Code`, u8)**: Machine instruction code.

### 2. The Types

| ID | Name | Description | Physics Interaction |
| :--- | :--- | :--- | :--- |
| **0** | **ETHER** | The medium. | Diffuses energy. |
| **1** | **SOURCE** | Generator. | Fixed `VAL = 512`. |
| **2** | **CODE** | Organism / solid substrate. | Acts as a wall by default; permeability is controlled by `OP` (not by `TYPE`). |

### 3. The Instruction Set (OP Codes)

| OP ID | Name | Behavior |
| :--- | :--- | :--- |
| **0** | **IDLE** | CODE cell is inert. Acts as a wall. |
| **1** | **PORE** | CODE cell is a permeable wall. It conducts diffusion like ETHER, but is still solid for movement/locking. |
| **2** | **GROW** | Directional growth head. |
| **3** | **WRITE** | Scanner/writer. |
| **4** | **SWAP** | Swapper. |

### 4. The Physics Update (Synchronous)

#### A. The Ether Perspective (Diffusion)
When updating an `ETHER` cell, sample all **8 neighbors**:

1. **Neighbor Sampling**:
   - `SOURCE` $\to$ **512**.
   - `ETHER` $\to$ Neighbor's **VAL**.
   - `CODE` (with `OP == PORE`) $\to$ Neighbor's **VAL** (Permeable).
   - `CODE` (other ops) $\to$ **Ignore** (Wall).

2. **Relaxation**:
   \[
   VAL_{next} = VAL_{cur} + (Average - VAL_{cur}) \cdot spread\_rate
   \]

#### B. The CODE Perspective (OP execution)
When updating a `CODE` cell:

1. **Persistence**: `VAL` is preserved by default.
2. **Execution (`OP` Logic)**: depends on `OP` (e.g. `GROW`, `WRITE`, `SWAP`).
3. **Permeability**: `OP == PORE` diffuses like ETHER and can starve/die.

---

### Implementation Instructions

#### 1. Logic Update: CODE Update Loop
In the `CODE` case of your update function:
```odin
case .CODE:
    // Persist state
    next_types[idx] = .CODE
    next_ops[idx]   = ops[idx]
    current_val    := current_vals[idx]
    
    // OP Execution
    // (See `sim_rules.odin` for the authoritative implementation.)
    
    // Clamp
    if current_val > 512 do current_val = 512
    next_vals[idx] = current_val
```