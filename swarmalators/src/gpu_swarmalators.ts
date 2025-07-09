import './style.css'

// Three.js WebGPU and TSL imports
import * as THREE from 'three/webgpu';
import { 
  float, int, uint, vec2, vec3, vec4, color, uniform, uniformArray,
  Fn, If, Loop, instanceIndex, instancedArray, attributeArray,
  sin, cos, exp, abs, max, min, pow, sqrt, PI, sign, select, clamp,
  add, sub, mul, div, mod, normalize, length, dot, cross, hash,
  uv, Continue, Break, Switch, atan2, fract
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Swarmalator parameters based on the mathematical model
export interface SwarmalatorParams {
  J: number;        // Coupling strength between spatial and phase dynamics (global fallback)
  K: number;        // Synchronization strength (global fallback)
  omega: number;    // Natural frequency
  naturalVelocity: number; // Natural propulsion velocity (v_n in equations)
  dt: number;       // Time step
}

// Species-based coupling parameters
export interface SpeciesParams {
  numSpecies: number;           // Number of distinct species
  JMatrix: number[][];          // J coupling matrix [species_i][species_j]
  KMatrix: number[][];          // K coupling matrix [species_i][species_j]
  speciesColors: string[];      // Colors for each species
  speciesDistribution: number[]; // Probability distribution for species assignment
}

// GPU-compatible swarmalator data structure
interface GPUSwarmalator {
  id: string;
  name: string;
  pointCount: number;
  
  // GPU buffers using TSL instancedArray
  positionBuffer: any;    // TSL instancedArray - particle positions [x,y,z]
  velocityBuffer: any;    // TSL instancedArray - particle velocities [vx,vy,vz]
  phaseBuffer: any;       // TSL instancedArray - oscillator phases [θ]
  phaseVelocityBuffer: any; // TSL instancedArray - phase velocities [dθ/dt]
  naturalFreqBuffer: any;   // per-particle natural frequency ω_n
  speciesBuffer: any;       // NEW: per-particle species ID
  
  // Rendering
  mesh: THREE.InstancedMesh;
  material: THREE.SpriteNodeMaterial;
  
  // Uniform parameters
  params: {
    J: any;                // Fallback J (scalar)
    K: any;                // Fallback K (scalar)
    omega: any;
    naturalVelocity: any;
    dt: any;
  };
  
  // Species parameters
  speciesParams: {
    numSpecies: any;       // Number of species
    JMatrix: any;          // J coupling matrix (flattened)
    KMatrix: any;          // K coupling matrix (flattened)
  };
  
  color: string;
  
  // Cached compute passes
  forceCompute?: THREE.ComputeNode;
  integrationCompute?: THREE.ComputeNode;
}

// =============================================================================
// TSL SWARMALATOR MATH FUNCTIONS
// =============================================================================

/**
 * Convert phase to HSV color representation
 * Phase θ maps to hue (0-360°), with full saturation and value
 */
const phaseToColor = /*@__PURE__*/ Fn(([phase]) => {
  // Normalize phase to [0, 1] range for hue
  const normalizedPhase = phase.div(PI.mul(2)).fract();
  
  // HSV to RGB conversion with S=1, V=1
  const hue = normalizedPhase.mul(6.0);
  const c = float(1.0); // Chroma (saturation * value)
  const x = c.mul(float(1.0).sub(abs(hue.mod(2.0).sub(1.0))));
  const m = float(0.0); // Since V=1, C=1
  
  const r = select(hue.lessThan(1.0), c,
           select(hue.lessThan(2.0), x,
           select(hue.lessThan(3.0), float(0.0),
           select(hue.lessThan(4.0), float(0.0),
           select(hue.lessThan(5.0), x, c)))));
  
  const g = select(hue.lessThan(1.0), x,
           select(hue.lessThan(2.0), c,
           select(hue.lessThan(3.0), c,
           select(hue.lessThan(4.0), x,
           select(hue.lessThan(5.0), float(0.0), float(0.0))))));
  
  const b = select(hue.lessThan(1.0), float(0.0),
           select(hue.lessThan(2.0), float(0.0),
           select(hue.lessThan(3.0), x,
           select(hue.lessThan(4.0), c,
           select(hue.lessThan(5.0), c, x)))));
  
  return vec3(r.add(m), g.add(m), b.add(m));
});

/**
 * Calculate attractive force modulated by phase difference
 * F_attraction = (1 + J*cos(θ_j - θ_i)) * (r_j - r_i) / |r_j - r_i|
 */
const attractiveForce = /*@__PURE__*/ Fn(([dr, distance, phaseI, phaseJ, J]) => {
  const phaseDiff = phaseJ.sub(phaseI);
  const modulation = float(1.0).add(J.mul(cos(phaseDiff)));
  return dr.div(distance).mul(modulation);
});

/**
 * Calculate repulsive force (inverse square law)
 * F_repulsion = -(r_j - r_i) / |r_j - r_i|^2
 */
const repulsiveForce = /*@__PURE__*/ Fn(([dr, distance]) => {
  const distanceSq = distance.mul(distance);
  return dr.div(distanceSq).negate();
});

/**
 * Calculate phase coupling force (Kuramoto-like)
 * dθ/dt = ω + (K/N) * Σ sin(θ_j - θ_i) / |r_j - r_i|
 */
const phaseCoupling = /*@__PURE__*/ Fn(([phaseI, phaseJ, distance, K]) => {
  const phaseDiff = phaseJ.sub(phaseI);
  return K.mul(sin(phaseDiff)).div(distance);
});

/**
 * Get coupling strength between two species from flattened matrix with global offset
 * Matrix access: matrix[i * numSpecies + j] + globalOffset
 */
const getSpeciesCoupling = /*@__PURE__*/ Fn(([matrix, speciesI, speciesJ, numSpecies, globalOffset]) => {
  const index = speciesI.mul(numSpecies).add(speciesJ);
  return matrix.element(index).add(globalOffset);
});

// =============================================================================
// GPU SWARMALATOR CLASS
// =============================================================================

class GPUSwarmalators {
  private renderer: THREE.WebGPURenderer | undefined;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private worldWidth: number;
  private worldHeight: number;
  private worldDepth: number;
  private controls?: OrbitControls;
  private swarmalators: Map<string, GPUSwarmalator> = new Map();
  private animationId: number | null = null;
  private globalParams: SwarmalatorParams;
  private speciesParams: SpeciesParams;
  
  constructor(params?: Partial<SwarmalatorParams>, speciesParams?: Partial<SpeciesParams>) {
    // Default swarmalator parameters (J and K are now global offsets)
    this.globalParams = {
      J: 0.0,           // Global J offset (starts at 0)
      K: 0.0,           // Global K offset (starts at 0) 
      omega: 2.0,       // No natural frequency initially
      naturalVelocity:  1.1, // No natural propulsion
      dt: 0.14,         // Larger time step
      ...params
    };
    
    // Default species parameters (2 species with different coupling)
    this.speciesParams = {
      numSpecies: 2,
      JMatrix: [
        [1.0, 0.5],  // Species 0 to [0, 1]
        [0.5, 1.0]   // Species 1 to [0, 1]
      ],
      KMatrix: [
        [0.8, 0.2],  // Species 0 to [0, 1]
        [0.2, 0.8]   // Species 1 to [0, 1]
      ],
      speciesColors: ['#ff4444', '#44ff44'],
      speciesDistribution: [0.5, 0.5],
      ...speciesParams
    };
    
    // Initialize scene and camera
    this.scene = new THREE.Scene();
    
    // Set up world dimensions
    const aspect = 16 / 9;
    this.worldHeight = 20;
    this.worldWidth = this.worldHeight * aspect;
    this.worldDepth = 20;
    
    this.camera = new THREE.PerspectiveCamera(
      75,
      this.worldWidth / this.worldHeight,
      0.1,
      1000
    );
    this.camera.position.set(0, 0, 5);
    this.camera.updateProjectionMatrix();
    
    // Initialize WebGPU asynchronously
    this.initializeWebGPU();
  }
  
  private async initializeWebGPU() {
    this.renderer = new THREE.WebGPURenderer({ antialias: true });
    this.renderer.setSize(1200, 800);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 1);
    
    await this.renderer.init();
    
    console.log('GPU Swarmalators system initialized');
    console.log('WebGPU support:', (this.renderer as any).backend.isWebGPUBackend);
  }
  
  /**
   * Create a new swarmalator group
   */
  createSwarmalators(count: number, params?: Partial<SwarmalatorParams>, name?: string): string {
    if (!this.renderer) {
      throw new Error('WebGPU renderer not initialized');
    }
    
    const id = `swarmalator_${this.swarmalators.size}`;
    const finalParams = { ...this.globalParams, ...params };
    
    // Create GPU buffers
    const positionBuffer = instancedArray(count, 'vec3');
    const velocityBuffer = instancedArray(count, 'vec3');
    const phaseBuffer = instancedArray(count, 'float');
    const phaseVelocityBuffer = instancedArray(count, 'float');
    const naturalFreqBuffer = instancedArray(count, 'float');
    const speciesBuffer = instancedArray(count, 'uint');
    
    // Create geometry and material
    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.SpriteNodeMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true
    });
    
    // Species-based color visualization with phase modulation
    const phaseAttr = phaseBuffer.toAttribute();
    const speciesAttr = speciesBuffer.toAttribute();
    
    // Create a hybrid color system: base color from species, modulated by phase
    material.colorNode = Fn(() => {
      const species = speciesAttr;
      const phase = phaseAttr;
      
      // Base color from species (red for species 0, green for species 1)
      const baseColor = select(species.equal(uint(0)), 
        vec3(1.0, 0.3, 0.3), // Red for species 0
        vec3(0.3, 1.0, 0.3)  // Green for species 1
      );
      
      // Phase modulation for brightness
      const phaseBrightness = cos(phase).mul(0.3).add(0.7);
      
      return vec4(baseColor.mul(phaseBrightness), 1.0);
    })();
    
    // Dynamic alpha based on phase velocity (more active = brighter)
    const phaseVelAttr = phaseVelocityBuffer.toAttribute();
    const alpha = clamp(abs(phaseVelAttr).mul(5.0).add(0.3), float(0.1), float(1.0));
    material.opacityNode = alpha;
    
    // Position from buffer
    material.positionNode = positionBuffer.toAttribute();
    
    // Dynamic scale based on synchronization
    material.scaleNode = float(0.05);
    
    // Flatten coupling matrices for GPU
    const flatJMatrix = this.speciesParams.JMatrix.flat();
    const flatKMatrix = this.speciesParams.KMatrix.flat();
    
    // Create uniform parameters
    const paramUniforms = {
      J: uniform(finalParams.J),
      K: uniform(finalParams.K),
      omega: uniform(finalParams.omega),
      naturalVelocity: uniform(finalParams.naturalVelocity),
      dt: uniform(finalParams.dt)
    };
    
    // Create species uniform parameters
    const speciesParamUniforms = {
      numSpecies: uniform(this.speciesParams.numSpecies),
      JMatrix: uniformArray(flatJMatrix),
      KMatrix: uniformArray(flatKMatrix)
    };
    
    // Create instanced mesh
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    this.scene.add(mesh);
    
    const swarmalator: GPUSwarmalator = {
      id,
      name: name ?? `Swarmalators ${this.swarmalators.size + 1}`,
      pointCount: count,
      positionBuffer,
      velocityBuffer,
      phaseBuffer,
      phaseVelocityBuffer,
      naturalFreqBuffer,
      speciesBuffer,
      mesh,
      material,
      params: paramUniforms,
      speciesParams: speciesParamUniforms,
      color: '#00ff88'
    };
    
    // Create compute shaders
    swarmalator.forceCompute = this.createForceCompute(swarmalator);
    swarmalator.integrationCompute = this.createIntegrationCompute(swarmalator);
    
    this.swarmalators.set(id, swarmalator);
    console.log(`Created swarmalator group ${id} with ${count} oscillators`);
    
    return id;
  }
  
  /**
   * Create force calculation compute shader
   */
  createForceCompute(swarmalator: GPUSwarmalator) {
    const { 
      pointCount, 
      positionBuffer, 
      velocityBuffer, 
      phaseBuffer, 
      phaseVelocityBuffer,
      naturalFreqBuffer,
      speciesBuffer,
      params,
      speciesParams
    } = swarmalator;
    
    return Fn(() => {
      const i = instanceIndex;
      
      // Skip if beyond particle count
      If(i.greaterThanEqual(uint(pointCount)), () => {
        return;
      });
      
      // Get current particle state
      const pos_i = positionBuffer.element(i).toVar();
      const phase_i = phaseBuffer.element(i).toVar();
      const omega_i = naturalFreqBuffer.element(i).toVar();
      const species_i = speciesBuffer.element(i).toVar();
      
      // Initialize force and phase coupling accumulators
      const force_acc = vec3(0.0, 0.0, 0.0).toVar();
      const phase_coupling_acc = float(0.0).toVar();
      
      // Loop over all other particles
      Loop(uint(pointCount), ({ i: j }) => {
        
        // Skip self-interaction
        If(j.equal(i), () => {
          Continue();
        });
        
        // Get other particle state
        const pos_j = positionBuffer.element(j);
        const phase_j = phaseBuffer.element(j);
        const species_j = speciesBuffer.element(j);
        
        // Calculate distance vector and magnitude
        const dr = pos_j.sub(pos_i).toVar();
        const distance = length(dr).add(1e-6).toVar(); // Add small epsilon to avoid division by zero
        
        // Get species-specific coupling parameters with global offsets
        const J_ij = getSpeciesCoupling(speciesParams.JMatrix, species_i, species_j, speciesParams.numSpecies, params.J);
        const K_ij = getSpeciesCoupling(speciesParams.KMatrix, species_i, species_j, speciesParams.numSpecies, params.K);
        
        // Calculate attractive force (modulated by phase difference and species coupling)
        const attractive = attractiveForce(dr, distance, phase_i, phase_j, J_ij);
        force_acc.addAssign(attractive);
        
        // Calculate repulsive force (inverse–square) – always active, no scaling.
        const repulsive = repulsiveForce(dr, distance);
        force_acc.addAssign(repulsive.mul(1.0)); // Strengthen repulsion for more spacing
        
        // Calculate phase coupling with species-specific strength
        const coupling = phaseCoupling(phase_i, phase_j, distance, K_ij);
        phase_coupling_acc.addAssign(coupling);
        
      });
      
      // Normalize forces by particle count
      const N = float(pointCount).mul(0.89);
      force_acc.divAssign(N);
      phase_coupling_acc.divAssign(N);
      
      // In the original ODE the position derivative equals the force sum directly
      // (plus an optional natural propulsion velocity). We therefore *assign*
      // the computed force to the velocity buffer instead of integrating it
      // with inertia, damping or speed limits.
      const vel_i = velocityBuffer.element(i).toVar();
      vel_i.assign(force_acc.mul(params.naturalVelocity)); // naturalVelocity assumed zero for now
      
      // Update phase velocity (phase dynamics)
      const phase_vel_i = phaseVelocityBuffer.element(i).toVar();
      phase_vel_i.assign(omega_i.add(phase_coupling_acc));
      
      // Write back updated velocities
      velocityBuffer.element(i).assign(vel_i);
      phaseVelocityBuffer.element(i).assign(phase_vel_i);
      
    })().compute(pointCount);
  }
  
  /**
   * Create integration compute shader
   */
  createIntegrationCompute(swarmalator: GPUSwarmalator) {
    const { 
      pointCount, 
      positionBuffer, 
      velocityBuffer, 
      phaseBuffer, 
      phaseVelocityBuffer,
      params 
    } = swarmalator;
    
    return Fn(() => {
      const i = instanceIndex;
      
      // Skip if beyond particle count
      If(i.greaterThanEqual(uint(pointCount)), () => {
        return;
      });
      
      // Update position (no boundary wrapping – infinite plane)
      const pos_i = positionBuffer.element(i).toVar();
      const vel_i = velocityBuffer.element(i);
      pos_i.addAssign(vel_i.mul(params.dt));
      
      // Update phase
      const phase_i = phaseBuffer.element(i).toVar();
      const phase_vel_i = phaseVelocityBuffer.element(i);
      phase_i.addAssign(phase_vel_i.mul(params.dt));
      
      // Wrap phase to [0, 2π]
      phase_i.assign(phase_i.mod(PI.mul(2.0)));
      
      // Write back updated state
      positionBuffer.element(i).assign(pos_i);
      phaseBuffer.element(i).assign(phase_i);
      
    })().compute(pointCount);
  }
  
  /**
   * Initialize particle positions and phases
   */
  createInitCompute(swarmalator: GPUSwarmalator) {
    const { pointCount, positionBuffer, velocityBuffer, phaseBuffer, phaseVelocityBuffer, naturalFreqBuffer, speciesBuffer } = swarmalator;
    
    return Fn(() => {
      const i = instanceIndex;
      
      // Skip if beyond particle count
      If(i.greaterThanEqual(uint(pointCount)), () => {
        return;
      });
      
      // Random position in world bounds
      const randX = hash(instanceIndex.add(uint(42))).mul(2.0).sub(1.0);
      const randY = hash(instanceIndex.add(uint(123))).mul(2.0).sub(1.0);
      const randZ = hash(instanceIndex.add(uint(456))).mul(2.0).sub(1.0);
      
      const clusterSize = 10.0;
      const posX = randX.mul(clusterSize);
      const posY = randY.mul(clusterSize);
      const posZ = randZ.mul(0.1); // Keep mostly 2D
      
      positionBuffer.element(i).assign(vec3(posX, posY, posZ));
      
      // Random initial velocity
      const velX = hash(instanceIndex.add(uint(789))).mul(2.0).sub(1.0).mul(0.1);
      const velY = hash(instanceIndex.add(uint(101112))).mul(2.0).sub(1.0).mul(0.1);
      const velZ = float(0.0);
      
      velocityBuffer.element(i).assign(vec3(velX, velY, velZ));
      
      // Random initial phase [0, 2π]
      const randPhase = hash(instanceIndex.add(uint(131415))).mul(PI.mul(2.0));
      phaseBuffer.element(i).assign(randPhase);
      
      // Zero initial phase velocity
      phaseVelocityBuffer.element(i).assign(0.0);

      // Random initial natural frequency [0.0, 2.0] - wide spread
      const randNaturalFreq = hash(instanceIndex.add(uint(161718))).mul(2.0);
      naturalFreqBuffer.element(i).assign(randNaturalFreq);
      
      // Assign species based on distribution (simple: alternate between species for now)
      const species = uint(hash(instanceIndex.add(uint(192021))).mul(float(this.speciesParams.numSpecies)));
      speciesBuffer.element(i).assign(species);
      
    })().compute(pointCount);
  }
  
  /**
   * Attach canvas to DOM
   */
  attachToDom(container?: HTMLElement) {
    if (!this.renderer) {
      console.error('Renderer not initialized');
      return;
    }
    
    const canvas = this.renderer.domElement;
    canvas.style.border = '2px solid #00ff88';
    canvas.style.marginTop = '20px';
    canvas.style.display = 'block';
    canvas.style.backgroundColor = '#000';
    
    const canvasContainer = document.createElement('div');
    canvasContainer.style.textAlign = 'center';
    canvasContainer.style.marginTop = '20px';
    
    const title = document.createElement('h3');
    title.textContent = '🌀 GPU Swarmalators Visualization';
    title.style.color = '#00ff88';
    title.style.margin = '10px 0';
    
    canvasContainer.appendChild(title);
    canvasContainer.appendChild(canvas);
    
    const targetContainer = container || document.body;
    targetContainer.appendChild(canvasContainer);
    
    // Add orbit controls
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.zoomSpeed = 0.6;
    this.controls.minDistance = 0.5;
    this.controls.maxDistance = 100;
    this.controls.target.set(0, 0, 0);
    this.controls.update();
    
    console.log('GPU Swarmalators renderer attached to DOM');
  }
  
  /**
   * Initialize swarmalator positions and phases
   */
  async initializeSwarmalators() {
    if (!this.renderer) {
      throw new Error('Renderer not initialized');
    }
    
    for (const swarmalator of this.swarmalators.values()) {
      const initCompute = this.createInitCompute(swarmalator);
      await this.renderer.computeAsync(initCompute);
    }
  }
  
  /**
   * Start animation loop
   */
  startAnimation() {
    if (!this.renderer) {
      console.error('Cannot start animation - renderer not initialized');
      return;
    }
    
    if (this.animationId !== null) {
      console.log('Animation already running');
      return;
    }
    
    console.log('Starting GPU swarmalator animation loop');
    
    const animate = () => {
      this.animationId = requestAnimationFrame(animate);
      
      // Run physics simulation for all swarmalators
      for (const swarmalator of this.swarmalators.values()) {
        // Force calculation
        if (swarmalator.forceCompute) {
          this.renderer!.compute(swarmalator.forceCompute);
        }
        
        // Integration
        if (swarmalator.integrationCompute) {
          this.renderer!.compute(swarmalator.integrationCompute);
        }
      }
      
      // Update controls
      if (this.controls) {
        this.controls.update();
      }
      
      // Render scene
      this.renderer!.render(this.scene, this.camera);
    };
    
    animate();
  }
  
  /**
   * Stop animation
   */
  stopAnimation() {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
      console.log('GPU swarmalator animation stopped');
    }
  }
  
  /**
   * Update global parameters
   */
  updateParams(newParams: Partial<SwarmalatorParams>) {
    this.globalParams = { ...this.globalParams, ...newParams };
    
    // Update all swarmalators
    for (const swarmalator of this.swarmalators.values()) {
      if (newParams.J !== undefined) swarmalator.params.J.value = newParams.J;
      if (newParams.K !== undefined) swarmalator.params.K.value = newParams.K;
      if (newParams.omega !== undefined) swarmalator.params.omega.value = newParams.omega;
      if (newParams.naturalVelocity !== undefined) swarmalator.params.naturalVelocity.value = newParams.naturalVelocity;
      if (newParams.dt !== undefined) swarmalator.params.dt.value = newParams.dt;
    }
  }
  
  /**
   * Update species parameters
   */
  updateSpeciesParams(newSpeciesParams: Partial<SpeciesParams>) {
    this.speciesParams = { ...this.speciesParams, ...newSpeciesParams };
    
    // Update all swarmalators
    for (const swarmalator of this.swarmalators.values()) {
      if (newSpeciesParams.numSpecies !== undefined) {
        swarmalator.speciesParams.numSpecies.value = newSpeciesParams.numSpecies;
      }
      if (newSpeciesParams.JMatrix !== undefined) {
        const flatJMatrix = newSpeciesParams.JMatrix.flat();
        swarmalator.speciesParams.JMatrix.array = flatJMatrix;
      }
      if (newSpeciesParams.KMatrix !== undefined) {
        const flatKMatrix = newSpeciesParams.KMatrix.flat();
        swarmalator.speciesParams.KMatrix.array = flatKMatrix;
      }
    }
  }
  
  /**
   * Get current parameters
   */
  getParams(): SwarmalatorParams {
    return { ...this.globalParams };
  }
  
  /**
   * Get current species parameters
   */
  getSpeciesParams(): SpeciesParams {
    return { ...this.speciesParams };
  }
  
  /**
   * Get swarmalator count
   */
  getSwarmalatorCount(): number {
    return this.swarmalators.size;
  }
  
  /**
   * Get total particle count
   */
  getTotalParticleCount(): number {
    return Array.from(this.swarmalators.values()).reduce((sum, s) => sum + s.pointCount, 0);
  }

  /**
   * Clear all existing swarmalators
   */
  clearAllSwarmalators() {
    // Remove all meshes from the scene
    for (const swarmalator of this.swarmalators.values()) {
      this.scene.remove(swarmalator.mesh);
      
      // Dispose of geometry and material to free GPU memory
      swarmalator.mesh.geometry.dispose();
      if (Array.isArray(swarmalator.mesh.material)) {
        swarmalator.mesh.material.forEach(material => material.dispose());
      } else {
        swarmalator.mesh.material.dispose();
      }
    }
    
    // Clear the internal map
    this.swarmalators.clear();
    console.log('Cleared all existing swarmalators');
  }
}

export { GPUSwarmalators };