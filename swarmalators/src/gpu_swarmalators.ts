// @ts-nocheck
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
  alpha: number;    // Phase lag parameter in phase coupling
  dt: number;       // Time step
  boundarySize: number;    // Soft boundary size (particles gently pushed back when beyond this)
  boundaryStrength: number; // Strength of boundary force (0 = no boundaries, 1 = strong)
}

// Species-based coupling parameters (supports up to 5 species)
export interface SpeciesParams {
  numSpecies: number;           // Number of distinct species (1-5)
  JMatrix: number[][];          // J coupling matrix [species_i][species_j] (numSpecies x numSpecies)
  KMatrix: number[][];          // K coupling matrix [species_i][species_j] (numSpecies x numSpecies)
  speciesColors: string[];      // Colors for each species (up to 5)
  speciesDistribution: number[]; // Probability distribution for species assignment (must sum to 1)
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
  speciesBuffer: any;       // per-particle species ID
  densityBuffer: any;       // local density
  
  // Rendering
  mesh: THREE.InstancedMesh;
  material: THREE.SpriteNodeMaterial;
  
  // Uniform parameters
  params: {
    J: any;                // Fallback J (scalar)
    K: any;                // Fallback K (scalar)
    omega: any;
    alpha: any;
    dt: any;
    boundarySize: any;
    boundaryStrength: any;
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
 * Calculate combined spatial force (attractive + repulsive)
 * F_ij = (r_j - r_i)/|r_j - r_i| * [1 + J*cos(θ_j - θ_i)] - (r_j - r_i)/|r_j - r_i|²
 * This matches the original O'Keeffe equation but with force limiting for stability
 */
const spatialForce = /*@__PURE__*/ Fn(([dr, distance, phaseI, phaseJ, J]) => {
  const phaseDiff = phaseJ.sub(phaseI);
  const modulation = float(1.0).add(J.mul(cos(phaseDiff)));
  
  // Enforce minimum distance to prevent extreme forces
  const safeDistance = max(distance, float(0.1));
  
  const attractive = dr.div(safeDistance).mul(modulation);
  
  // Stronger repulsive force but with distance limiting
  const repulsive = dr.div(safeDistance.mul(safeDistance)).mul(0.5).negate();
  
  // Clamp total force magnitude to prevent jumping
  const totalForce = attractive.add(repulsive);
  const forceMag = length(totalForce);
  const maxForce = float(2.0);
  
  return select(forceMag.greaterThan(maxForce), 
    totalForce.div(forceMag).mul(maxForce), 
    totalForce
  );
});

/**
 * Calculate phase coupling force (Kuramoto-like) with lag alpha
 * dθ/dt = ω + (K/N) * Σ sin(θ_j - θ_i - alpha) / |r_j - r_i|
 * alpha is the phase lag parameter
 */
const phaseCoupling = /*@__PURE__*/ Fn(([phaseI, phaseJ, distance, K, alpha]) => {
  const phaseDiff = phaseJ.sub(phaseI).sub(alpha);
  // Avoid division by zero in extreme clustering - enforce minimum distance
  const safeDist = max(distance, float(0.1));
  return K.mul(sin(phaseDiff)).div(safeDist);
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
  private cameraFollowsParticles: boolean = false;
  private lastCenterOfMass: THREE.Vector3 = new THREE.Vector3();
  
  constructor(params?: Partial<SwarmalatorParams>, speciesParams?: Partial<SpeciesParams>) {
    // Default swarmalator parameters (J and K are now global offsets)
    this.globalParams = {
      J: 0.0,           // Global J offset (initially zero)
      K: 0.0,           // Global K offset (initially zero)
      omega: 1.2,       // Natural frequency for interesting dynamics
      alpha: 0.0,       // Phase lag initially zero
      dt: 0.02,         // Balanced time step with force limiting
      boundarySize: 6.0, // Default soft boundary size
      boundaryStrength: 0.8, // Default soft boundary strength
      ...params
    };
    
    // Default species parameters (2 species with different coupling)
    this.speciesParams = {
      numSpecies: 2,
      JMatrix: [
        [1.4, 0.6],
        [-1.0405, 0.6]
      ],
      KMatrix: [
        [-1.6, -0.1],
        [2.4, -0.3]
      ],
      speciesColors: ['#ff4444', '#44ff44', '#4444ff', '#ffff44', '#ff44ff'],
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
      90,  // Wider field of view to see more particles
      this.worldWidth / this.worldHeight,
      0.1,
      1000
    );
    this.camera.position.set(0, 0, 10);
    this.camera.updateProjectionMatrix();
    
    // Initialize WebGPU asynchronously
    this.initializeWebGPU();
  }
  
  private async initializeWebGPU() {
    this.renderer = new THREE.WebGPURenderer({ 
      antialias: true,
      preserveDrawingBuffer: true  // Enable canvas capture
    });
    // this.renderer.setSize(1200, 800); // Size is now set dynamically in attachToDom
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
    const speciesBuffer = instancedArray(count, 'uint');
    const densityBuffer = instancedArray(count, 'float');
    
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
      
      // Base color from species (supports up to 5 species)
      const baseColor = select(species.equal(uint(0)), 
        vec3(1.0, 0.3, 0.3), // Red for species 0
        select(species.equal(uint(1)), 
          vec3(0.3, 1.0, 0.3), // Green for species 1
          select(species.equal(uint(2)), 
            vec3(0.3, 0.3, 1.0), // Blue for species 2
            select(species.equal(uint(3)), 
              vec3(1.0, 1.0, 0.3), // Yellow for species 3
              vec3(1.0, 0.3, 1.0)  // Magenta for species 4
            )
          )
        )
      );
      
      // Phase modulation for brightness
      const phaseBrightness = cos(phase).mul(0.3).add(0.7);
      
      return vec4(baseColor.mul(phaseBrightness), 1.0);
    })();
    
    // Dynamic alpha based on phase velocity (more active = brighter)
    const densityAttr = densityBuffer.toAttribute();

    // Opacity: soft circular sprite with fixed base alpha
    const dist = length(uv().sub(vec2(0.5, 0.5)));
    const radialAlpha = clamp(float(1.0).sub(pow(dist.mul(2.0), 8.0)), float(0.0), float(1.0));
    material.opacityNode = radialAlpha.mul(float(0.8));

    // Position from buffer
    material.positionNode = positionBuffer.toAttribute();

    // Particle scale inversely proportional to local density
    const densityScale = clamp(float(1.0).div(densityAttr.mul(5.0).add(1.0)), float(0.2), float(2.0));
    const dynamicScale = clamp(float(0.05).mul(densityScale).mul(2.0), float(0.011), float(0.165));
    material.scaleNode = dynamicScale;
    
    // Flatten coupling matrices for GPU
    const flatJMatrix = this.speciesParams.JMatrix.flat();
    const flatKMatrix = this.speciesParams.KMatrix.flat();
    
    // Create uniform parameters
    const paramUniforms = {
      J: uniform(finalParams.J),
      K: uniform(finalParams.K),
      omega: uniform(finalParams.omega),
      alpha: uniform(finalParams.alpha),
      dt: uniform(finalParams.dt),
      boundarySize: uniform(finalParams.boundarySize),
      boundaryStrength: uniform(finalParams.boundaryStrength)
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
      speciesBuffer,
      densityBuffer,
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
      speciesBuffer,
      densityBuffer,
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
      const species_i = speciesBuffer.element(i).toVar();
      
      // Initialize force and phase coupling accumulators
      const force_acc = vec3(0.0, 0.0, 0.0).toVar();
      const phase_coupling_acc = float(0.0).toVar();
      const density_acc = float(0.0).toVar();
      
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
        const distance = length(dr).toVar(); // Distance handled in force calculation
        
        // Get species-specific coupling parameters with global offsets
        const J_ij = getSpeciesCoupling(speciesParams.JMatrix, species_i, species_j, speciesParams.numSpecies, params.J);
        const K_ij = getSpeciesCoupling(speciesParams.KMatrix, species_i, species_j, speciesParams.numSpecies, params.K);
        
        // Calculate combined spatial force (attractive + repulsive)
        const spatial = spatialForce(dr, distance, phase_i, phase_j, J_ij);
        force_acc.addAssign(spatial);
        
        // Calculate phase coupling with species-specific strength
        const coupling = phaseCoupling(phase_i, phase_j, distance, K_ij, params.alpha);
        phase_coupling_acc.addAssign(coupling);

        // Accumulate density (count neighbors within radius)
        const densityRadius = float(2.0);
        If(distance.lessThan(densityRadius), () => {
          density_acc.addAssign(1.0);
        });
        
      });
      
      // Normalize forces by particle count (as in original O'Keeffe equations)
      const N = float(pointCount);
      force_acc.divAssign(N);
      phase_coupling_acc.divAssign(N);
      density_acc.divAssign(float(10.0)); // simple normalization
      
      // Apply forces with moderate amplification and velocity damping
      const vel_i = velocityBuffer.element(i).toVar();
      const currentVel = vel_i;
      
      // Apply damping to prevent runaway acceleration
      const damping = float(0.95);
      const dampedVel = currentVel.mul(damping);
      
      // Apply force with moderate amplification
      const newVel = dampedVel.add(force_acc.mul(2.0));
      
      // Clamp velocity magnitude to prevent jumping
      const velMag = length(newVel);
      const maxVel = float(1.0);
      const clampedVel = select(velMag.greaterThan(maxVel), 
        newVel.div(velMag).mul(maxVel), 
        newVel
      );
      
      vel_i.assign(clampedVel);
      
      // Update phase velocity (phase dynamics)
      // Use global omega parameter instead of per-particle natural frequency for consistency
      const phase_vel_i = phaseVelocityBuffer.element(i).toVar();
      phase_vel_i.assign(params.omega.add(phase_coupling_acc.mul(1.5))); // Moderate phase coupling
      
      // Write back updated velocities
      velocityBuffer.element(i).assign(vel_i);
      phaseVelocityBuffer.element(i).assign(phase_vel_i);
      densityBuffer.element(i).assign(density_acc);
      
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
      
      // Update position with soft boundary conditions
      const pos_i = positionBuffer.element(i).toVar();
      const vel_i = velocityBuffer.element(i).toVar();
      
      // Apply soft boundary forces
      const distanceFromCenter = length(pos_i);
      const boundaryForce = vec3(0.0, 0.0, 0.0).toVar();
      
      // If particle is beyond boundary size, apply restoring force toward center
      If(distanceFromCenter.greaterThan(params.boundarySize), () => {
        // Safe normalization (avoid NaN when pos_i is near zero)
        const lenPos = length(pos_i);
        const invLen = select(lenPos.greaterThan(float(0.0001)), float(1.0).div(lenPos), float(0.0));
        const forceDirection = pos_i.mul(invLen).mul(float(-1.0)); // Direction toward center (safe)
        const excess = distanceFromCenter.sub(params.boundarySize);
        const forceMagnitude = excess.mul(params.boundaryStrength).mul(float(2.0)); // Linear spring force
        boundaryForce.assign(forceDirection.mul(forceMagnitude));
      });
      
      // Special Z-axis constraints to keep particles within camera view
      // Camera is at (0, 0, 10) looking at (0, 0, 0), so constrain Z more tightly
      const zPos = pos_i.z;
      const zVel = vel_i.z.toVar();
      
      // Hard constraint: keep Z between -6 and 6 (camera viewing range)
      // If(zPos.greaterThan(float(6.0)), () => {
      //   const zExcess = zPos.sub(float(6.0));
      //   const zForce = zExcess.mul(params.boundaryStrength).mul(float(-4.0)); // Strong Z constraint
      //   vel_i.z.assign(zVel.add(zForce.mul(params.dt)));
      // });
      
      // If(zPos.lessThan(float(-6.0)), () => {
      //   const zExcess = float(-6.0).sub(zPos);
      //   const zForce = zExcess.mul(params.boundaryStrength).mul(float(4.0)); // Strong Z constraint
      //   vel_i.z.assign(zVel.add(zForce.mul(params.dt)));
      // });
      
      // Apply boundary force to velocity
      vel_i.addAssign(boundaryForce.mul(params.dt));
      
      // Apply velocity damping near boundaries to stabilize particles
      If(distanceFromCenter.greaterThan(params.boundarySize.mul(float(0.8))), () => {
        const dampingFactor = float(0.95); // Slight damping
        vel_i.mulAssign(dampingFactor);
      });
      
      // Extra Z-velocity damping to prevent runaway Z movement
      If(abs(zPos).greaterThan(float(4.0)), () => {
        vel_i.z.mulAssign(float(0.9)); // Stronger Z damping
      });
      
      // Update position
      pos_i.addAssign(vel_i.mul(params.dt));
      
      // Update phase
      const phase_i = phaseBuffer.element(i).toVar();
      const phase_vel_i = phaseVelocityBuffer.element(i);
      phase_i.addAssign(phase_vel_i.mul(params.dt));
      
      // Wrap phase to [0, 2π]
      phase_i.assign(phase_i.mod(PI.mul(2.0)));
      
      // Write back updated state
      positionBuffer.element(i).assign(pos_i);
      velocityBuffer.element(i).assign(vel_i);
      phaseBuffer.element(i).assign(phase_i);
      
    })().compute(pointCount);
  }
  
  /**
   * Initialize particle positions and phases
   */
  createInitCompute(swarmalator: GPUSwarmalator) {
    const { pointCount, positionBuffer, velocityBuffer, phaseBuffer, phaseVelocityBuffer, speciesBuffer, densityBuffer } = swarmalator;
    
    return Fn(() => {
      const i = instanceIndex;
      
      // Skip if beyond particle count
      If(i.greaterThanEqual(uint(pointCount)), () => {
        return;
      });
      
      // Random position in world bounds (balanced clustering)
      const randX = hash(instanceIndex.add(uint(42))).mul(2.0).sub(1.0);
      const randY = hash(instanceIndex.add(uint(123))).mul(2.0).sub(1.0);
      const randZ = hash(instanceIndex.add(uint(456))).mul(2.0).sub(1.0);
      
      const clusterSize = 2.0; // Moderate cluster size to prevent overcrowding
      const posX = randX.mul(clusterSize);
      const posY = randY.mul(clusterSize);
      const posZ = randZ.mul(0.1); // Keep mostly 2D
      
      positionBuffer.element(i).assign(vec3(posX, posY, posZ));
      
      // Random initial velocity (moderate energy)
      const velX = hash(instanceIndex.add(uint(789))).mul(2.0).sub(1.0).mul(0.1);
      const velY = hash(instanceIndex.add(uint(101112))).mul(2.0).sub(1.0).mul(0.1);
      const velZ = float(0.0);
      
      velocityBuffer.element(i).assign(vec3(velX, velY, velZ));
      
      // Random initial phase [0, 2π]
      const randPhase = hash(instanceIndex.add(uint(131415))).mul(PI.mul(2.0));
      phaseBuffer.element(i).assign(randPhase);
      
      // Zero initial phase velocity
      phaseVelocityBuffer.element(i).assign(0.0);

      // Zero initial density
      densityBuffer.element(i).assign(0.0);
      
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
    
    const targetContainer = container || document.body;

    // Set renderer size based on the container for responsiveness
    const width = targetContainer.clientWidth;
    const aspect = this.worldWidth / this.worldHeight;
    const height = width / aspect;
    this.renderer.setSize(width, height);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();

    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.backgroundColor = '#000';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    
    // Clear the container and append new elements directly
    targetContainer.innerHTML = '';
    // targetContainer.appendChild(title);
    targetContainer.appendChild(canvas);
    
    // Add orbit controls
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.zoomSpeed = 2;
    // this.controls.minDistance = 1.0;    // Prevent zooming too close
    // this.controls.maxDistance = 25.0;   // Prevent zooming too far
    // this.controls.target.set(0, 0, 0);
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
      
      // Update camera tracking
      this.updateCameraTracking();
      
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
      if (newParams.alpha !== undefined) swarmalator.params.alpha.value = newParams.alpha;
      if (newParams.dt !== undefined) swarmalator.params.dt.value = newParams.dt;
      if (newParams.boundarySize !== undefined) swarmalator.params.boundarySize.value = newParams.boundarySize;
      if (newParams.boundaryStrength !== undefined) swarmalator.params.boundaryStrength.value = newParams.boundaryStrength;
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
   * Change the number of species (requires recreation of swarmalators)
   */
  setNumSpecies(numSpecies: number) {
    if (numSpecies < 1 || numSpecies > 5) {
      throw new Error('Number of species must be between 1 and 5');
    }

    // Create new matrices for the specified number of species
    const newJMatrix: number[][] = [];
    const newKMatrix: number[][] = [];
    
    for (let i = 0; i < numSpecies; i++) {
      newJMatrix[i] = [];
      newKMatrix[i] = [];
      for (let j = 0; j < numSpecies; j++) {
        if (i === j) {
          // Diagonal elements (self-interaction)
          newJMatrix[i][j] = 1.0;
          newKMatrix[i][j] = 0.8;
        } else {
          // Off-diagonal elements (cross-species interaction)
          newJMatrix[i][j] = 0.5;
          newKMatrix[i][j] = 0.2;
        }
      }
    }

    // Create uniform distribution for species assignment
    const newDistribution = new Array(numSpecies).fill(1.0 / numSpecies);

    // Update species parameters
    this.speciesParams = {
      ...this.speciesParams,
      numSpecies,
      JMatrix: newJMatrix,
      KMatrix: newKMatrix,
      speciesDistribution: newDistribution
    };

    console.log(`Set number of species to ${numSpecies}`);
    console.log('New J Matrix:', newJMatrix);
    console.log('New K Matrix:', newKMatrix);
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
   * Reset camera position to default
   */
  resetCameraPosition() {
    if (this.camera) {
      this.camera.position.set(0, 0, 2);
      this.camera.lookAt(0, 0, 0);
      this.camera.updateProjectionMatrix();
    }
    
    if (this.controls) {
      this.controls.target.set(0, 0, 0);
      this.controls.update();
    }
    
    console.log('Camera position reset to default');
  }

  /**
   * Enable or disable camera following the particle center of mass
   */
  setCameraFollowing(enabled: boolean) {
    this.cameraFollowsParticles = enabled;
    console.log(`Camera following particles: ${enabled}`);
  }

  /**
   * Update camera to follow particle center of mass (simplified approach)
   */
  private updateCameraTracking() {
    if (!this.cameraFollowsParticles || this.swarmalators.size === 0) {
      return;
    }

    // Simple approach: keep camera at a reasonable distance to view the particle cloud
    // This is a heuristic since reading GPU data back to CPU would be expensive
    
    const currentTarget = this.controls?.target || new THREE.Vector3(0, 0, 0);
    const currentDistance = this.camera.position.distanceTo(currentTarget);
    
    // Keep camera at a good viewing distance (not too close, not too far)
    const idealDistance = 2.0; // Fixed reasonable distance
    const minDistance = 1.0;
    const maxDistance = 18.0;
    
    // Only adjust if we're outside the reasonable range
    if (currentDistance < minDistance || currentDistance > maxDistance) {
      // Smoothly interpolate camera position
      const direction = this.camera.position.clone().sub(currentTarget).normalize();
      const targetDistance = Math.max(minDistance, Math.min(maxDistance, idealDistance));
      const newPosition = currentTarget.clone().add(direction.multiplyScalar(targetDistance));
      
      // Smooth transition
      this.camera.position.lerp(newPosition, 0.05);
      
      if (this.controls) {
        this.controls.update();
      }
    }
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