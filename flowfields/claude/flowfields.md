### LLM Prompt for 2D Flow Field Visualization System

**Project Goal:**

Create a high-performance 2D flow field visualization system using TypeScript and Three.js with its WebGPU backend. The visualization will have two distinct parts: a static vector grid showing flow direction and a dynamic particle system illustrating the flow's paths. The core calculations will be parallelized on the GPU using Three.js's shader language, TSL, for compute shaders.

**Core Implementation Design:**

The implementation must follow a specific, highly-optimized design that leverages the GPU for both visualization components.

**Part 1: The Vector Grid (Static Representation)**

*   **Objective:** To calculate and display a grid of vectors representing the flow field at fixed points.
*   **Method:** Use a **WebGPU Compute Shader** written in TSL.
*   **Logic:**
    *   The compute shader will be dispatched once with a 2D workgroup size matching the desired grid resolution (e.g., 32x32).
    *   Each shader invocation will correspond to a single point on the grid.
    *   Inside the shader, calculate the flow vector `(vx, vy)` for the corresponding grid coordinate `(x, y)` by evaluating a predefined motion equation. For this example, use the following non-linear system:
        *   `vx = sin(y)`
        *   `vy = sin(x)`
    *   The resulting vectors should be written to a `StorageTexture` (`storageTexture` in TSL).
*   **Rendering:**
    *   The grid vectors will be rendered using **instanced rendering**.
    *   Create a single base mesh for an arrow or a line.
    *   Draw this mesh N times, where N is the total number of grid cells.
    *   The TSL vertex shader for the instances will use the `instanceIndex` to look up the corresponding vector from the `StorageTexture` and apply the correct rotation and scale to the arrow.

**Part 2: The Particle System (Dynamic Simulation)**

*   **Objective:** To simulate and display thousands of particles moving through the flow field.
*   **Method:** This is the most critical part of the design. We will use the **Direct Calculation Method** for particle updates, as it provides the highest accuracy and is perfectly suited for GPU parallelization. **Do not** use the pre-calculated grid vectors for the particle simulation.
*   **Data Management:**
    *   Use two `StorageBuffer`s for particle data in a **ping-pong configuration**. This allows reading from one buffer while writing updated data to the other in a single frame, avoiding race conditions.
    *   Each particle in the buffer should have a data structure like:
        ```
        struct Particle {
            position: vec2<f32>,
            velocity: vec2<f32>,
            age: f32,
            lifetime: f32
        };
        ```
*   **Compute Shader Logic:**
    *   A second compute shader, written in TSL, will handle particle updates. It will be dispatched every frame.
    *   Assign one shader thread per particle.
    *   For each particle, the shader will:
        1.  Read the particle's data from the "input" storage buffer.
        2.  Check if `age >= lifetime`. If so, "respawn" the particle by resetting its `age` to 0 and assigning it a new random starting `position` and `lifetime`.
        3.  If the particle is alive, calculate its velocity **directly** by evaluating the motion equations (`vx = sin(position.y)`, `vy = sin(position.x)`) at its current, precise `position`.
        4.  Update the particle's position using the **Euler integration** method: `newPosition = oldPosition + velocity * deltaTime`.
        5.  Increment the particle's age: `newAge = age + deltaTime`.
        6.  Write the `newPosition`, `velocity`, and `newAge` into the "output" storage buffer at the corresponding index.
*   **Rendering:**
    *   The updated particle data (the "output" buffer from the compute pass, which becomes the "input" for the next frame) will be used directly as a vertex buffer for a `THREE.Points` object.
    *   The TSL vertex shader will simply read the particle's position and project it.
    *   The TSL fragment shader can color the particles. For a nice visual effect, map the particle's color to the magnitude of its velocity.

**Code Structure and Requirements:**

*   The implementation must use **TypeScript**.
*   The renderer must be explicitly configured to use the **WebGPU Backend** (`WebGPURenderer`).
*   All shader code must be written using **TSL (Three Shader Language)**. This includes the compute shaders for the grid and particles, as well as the vertex/fragment shaders for rendering.
*   Please structure the code logically, potentially encapsulating the flow field logic within a dedicated class.
*   Provide clear comments, especially within the TSL shader code, to explain the logic for vector calculation, particle updates, and data lookups.

**Context to be Provided:**

I will supply you with working examples of:
1.  Setting up a basic Three.js scene with TypeScript and the WebGPURenderer.
2.  A simple TSL compute shader example.
3.  An example of instanced rendering in Three.js.

Please generate the complete, self-contained code for this visualization system based on the design specified above.