# Chromatose 3.0 Specification
**"The 8-Neighbor Standard"**

### 1. The Data Structure
Each grid unit contains three values (Double Buffered):
1. **`TYPE` (`Cell_Type`, u8)**: Material classification.
2. **`VAL` (`f32`, range \([0, 512]\))**: Thermal energy / Charge.
3. **`OP` (`u8`)**: Machine instruction code.

### 2. The Types

| ID | Name | Description | Physics Interaction |
| :--- | :--- | :--- | :--- |
| **0** | **ETHER** | The medium. | Diffuses energy. |
| **1** | **SOURCE** | Generator. | Fixed `VAL = 512`. |
| **2** | **CELL** | Organism. | **Variable Permeability**. Acts as Wall or Sink based on `OP`. |

### 3. The Instruction Set (OP Codes)

| OP ID | Name | Behavior |
| :--- | :--- | :--- |
| **0** | **IDLE** | The Cell is **Inert**. It acts as a **WALL**. |
| **1** | **HARVEST** | The Cell is **Active**. It acts as a **SINK** (Value 0) to Ether, causing inflow. |

### 4. The Physics Update (Synchronous)

#### A. The Ether Perspective (Diffusion)
When updating an `ETHER` cell, sample all **8 neighbors**:

1. **Neighbor Sampling**:
   - `SOURCE` $\to$ **512**.
   - `ETHER` $\to$ Neighbor's **VAL**.
   - `CELL` (with `OP == HARVEST`) $\to$ **0.0** (Sink).
   - `CELL` (with `OP == IDLE`) $\to$ **Ignore** (Wall).

2. **Relaxation**:
   \[
   VAL_{next} = VAL_{cur} + (Average - VAL_{cur}) \cdot spread\_rate
   \]

#### B. The Cell Perspective (Metabolism)
When updating a `CELL`:

1. **Persistence**: `VAL` is preserved by default.
2. **Execution (`OP` Logic)**:
   - If `OP == HARVEST`:
     - Scan all **8 neighbors** (N, S, E, W, NE, NW, SE, SW).
     - Sum the `VAL` of any neighbor that is `ETHER` or `SOURCE`.
     - **Absorption**:
       \[ VAL_{next} = VAL_{cur} + (Sum \cdot 0.1) \]
   - **Clamp**: Ensure `VAL` never exceeds 512.

---

### Implementation Instructions

#### 1. Logic Update: Cell Update Loop
In the `CELL` case of your update function:
```odin
case .CELL:
    // Persist state
    next_types[idx] = .CELL
    next_ops[idx]   = ops[idx]
    current_val    := current_vals[idx]
    
    // OP Execution
    if ops[idx] == 1 { // HARVEST
        energy_sum: f32 = 0
        
        // Scan 8 neighbors
        for offset in neighbors {
            nx, ny := get_clamped_coords(x + offset.x, y + offset.y)
            n_idx := nx + ny * width
            
            n_type := current_types[n_idx]
            
            // Only absorb from the environment
            if n_type == .ETHER || n_type == .SOURCE {
                // For Ether, read actual value. For Source, read 512.
                val := (n_type == .SOURCE) ? 512.0 : current_vals[n_idx]
                energy_sum += val
            }
        }
        
        // Gain Energy (10% of surrounding flux)
        current_val += energy_sum * 0.1
    }
    
    // Clamp
    if current_val > 512 do current_val = 512
    next_vals[idx] = current_val
```