# GPU Swarmalators Implementation

A WebGPU-based implementation of swarmalators using Three.js TSL (Three.js Shading Language). Swarmalators are oscillators that both swarm in space and synchronize their phases, creating fascinating emergent patterns.

## Mathematical Model

The swarmalator model is based on the equations from O'Keeffe et al. (2017):

### Spatial Dynamics
```
dri/dt = vi + (1/N) Σ [(rj - ri)/|rj - ri|] * [1 + J*cos(θj - θi)] - (rj - ri)/|rj - ri|²
```

### Phase Dynamics
```
dθi/dt = ωi + (K/N) Σ sin(θj - θi) / |rj - ri|
```

Where:
- `ri` = position of oscillator i
- `θi` = phase of oscillator i
- `J` = spatial-phase coupling strength
- `K` = synchronization strength
- `ωi` = natural frequency of oscillator i
- `N` = total number of oscillators

## Implementation Features

### GPU Acceleration
- **WebGPU compute shaders** for parallel force calculations
- **TSL (Three.js Shading Language)** for GPU-native programming
- **O(N²) interactions** computed in parallel across GPU cores
- **Real-time visualization** with 60fps performance

### Visualization
- **Phase-based coloring**: Each oscillator's phase maps to a color on the rainbow spectrum
- **Dynamic brightness**: Brightness indicates phase velocity (activity level)
- **3D rendering**: Full 3D space with orbital camera controls
- **Smooth particles**: Gaussian-falloff sprites for aesthetic appeal

### Parameter Control
- **J (Spatial-Phase Coupling)**: -2 to 2
  - Positive: particles with similar phases attract
  - Negative: particles with opposite phases attract
- **K (Synchronization)**: -2 to 2
  - Positive: phases synchronize
  - Negative: phases desynchronize
- **ω (Natural Frequency)**: -2 to 2
- **dt (Time Step)**: 0.001 to 0.05

## Emergent Patterns

The implementation includes presets for various documented patterns:

1. **Rainbow Ring** (J=1.0, K=0.0): Stationary ring with phase ordering
2. **Dancing Circus** (J=0.1, K=-0.1): Dynamic oscillating patterns
3. **Uniform Blob** (J=0.1, K=1.0): Fully synchronized stable state
4. **Solar Convection** (J=0.1, K=1.0, ω=0.5): Convection-like patterns
5. **Makes Me Dizzy** (J=1.0, K=0.1): Highly dynamic rotating patterns
6. **Fractured** (J=1.0, K=-0.1): Slice-of-orange patterns

## File Structure

```
swarmalators/
├── gpu_swarmalators.ts     # Main GPU implementation class
├── swarmalators_app.ts     # Application logic and UI handling
├── swarmalators_test.html  # HTML test interface
├── style.css               # Styling for the application
└── README.md              # This documentation
```

## Key Classes and Functions

### `GPUSwarmalators`
Main class managing the GPU simulation:
- `createSwarmalators(count, params)` - Create swarmalator group
- `updateParams(params)` - Update simulation parameters
- `startAnimation()` / `stopAnimation()` - Control animation
- `attachToDom(container)` - Attach renderer to DOM

### TSL Compute Shaders
- `createForceCompute()` - Calculate spatial forces and phase coupling
- `createIntegrationCompute()` - Integrate positions and phases
- `createInitCompute()` - Initialize particle positions and phases

### TSL Math Functions
- `phaseToColor(phase)` - Convert phase to RGB color
- `attractiveForce(dr, distance, phaseI, phaseJ, J)` - Calculate attractive forces
- `repulsiveForce(dr, distance)` - Calculate repulsive forces
- `phaseCoupling(phaseI, phaseJ, distance, K)` - Calculate phase coupling

## Usage

1. **Development**: Use with a development server that supports ES modules
2. **Production**: Bundle with Vite, Webpack, or similar
3. **WebGPU**: Requires a WebGPU-compatible browser (Chrome 113+, Firefox with flag)

### Basic Example

```typescript
import { GPUSwarmalators } from './gpu_swarmalators';

const swarmalators = new GPUSwarmalators({
  J: 1.0,
  K: 0.5,
  omega: 0.0,
  dt: 0.01
});

// Wait for initialization
await new Promise(resolve => {
  const check = () => {
    if ((swarmalators as any).renderer) resolve(true);
    else setTimeout(check, 100);
  };
  check();
});

// Create and initialize
const id = swarmalators.createSwarmalators(500);
await swarmalators.initializeSwarmalators();
swarmalators.attachToDom(document.body);
swarmalators.startAnimation();
```

## Performance

- **500 particles**: ~60 FPS on modern GPUs
- **1000 particles**: ~45-60 FPS
- **2000 particles**: ~30-45 FPS

Performance depends on GPU capabilities and browser WebGPU implementation.

## Browser Compatibility

- **Chrome 113+**: Full support
- **Firefox**: WebGPU behind flag (`dom.webgpu.enabled`)
- **Safari**: WebGPU in development
- **Edge**: Same as Chrome (Chromium-based)

## References

- O'Keeffe, K.P., Hong, H., Strogatz, S.H. "Oscillators that sync and swarm." *Nature Communications* 8, 1504 (2017)
- [Three.js TSL Documentation](https://threejs.org/docs/#api/en/nodes/Intro)
- [WebGPU Specification](https://gpuweb.github.io/gpuweb/)