import './style.css'

// Kernel type enums
enum KernelType {
  GAUSSIAN = 'gaussian',
  EXPONENTIAL = 'exponential', 
  POLYNOMIAL = 'polynomial',
  MEXICAN_HAT = 'mexican_hat',
  SIGMOID = 'sigmoid',
  SINC = 'sinc'
}

// Type definitions
interface Params {
  mu_k: number;
  sigma_k: number;
  w_k: number;
  mu_g: number;
  sigma_g: number;
  c_rep: number;
  kernel_k_type: KernelType;
  kernel_g_type: KernelType;
}

// Shared parameter generation function
function createRandomParams(customParams?: Partial<Params>): Params {
  const kernelTypes = Object.values(KernelType);
  const randomKernelK = kernelTypes[Math.floor(Math.random() * kernelTypes.length)];
  const randomKernelG = kernelTypes[Math.floor(Math.random() * kernelTypes.length)];

  const defaultParams = {
    mu_k: 1.5 + Math.random() * 8.0,        // 1.5-9.5 range
    sigma_k: 0.2 + Math.random() * 3.0,     // 0.2-3.2 range
    w_k: 0.005 + Math.random() * 0.12,      // 0.005-0.125 range
    mu_g: 0.1 + Math.random() * 0.8,        // 0.1-0.9 range
    sigma_g: 0.025 + Math.random() * 0.35,  // 0.025-0.375 range
    c_rep: 0.3 + Math.random() * 2.4,       // 0.3-2.7 range
    kernel_k_type: randomKernelK,
    kernel_g_type: randomKernelG
  };

  return {
    ...defaultParams,
    ...customParams
  };
}

interface Fields {
  R_val: Float32Array;
  U_val: Float32Array;
  R_grad: Float32Array;
  U_grad: Float32Array;
  // Interaction-specific U fields for species-specific responses
  U_val_interactions: Map<string, Float32Array>;  // Map<otherSpeciesId, U_val>
  U_grad_interactions: Map<string, Float32Array>; // Map<otherSpeciesId, U_grad>
  // Pooled arrays to avoid repeated allocations
  U_val_pool: Map<string, Float32Array>;
  U_grad_pool: Map<string, Float32Array>;
}

interface Species {
  id: string;
  name: string;
  pointCount: number;
  points: Float32Array;
  fields: Fields;
  params: Params;
  color: string;
  renderStyle: {
    strokeStyle: string;
    fillStyle?: string;
  };
}

class SpeciesFactory {
  private static colorPalette = [
    '#00ff88', '#4488ff', '#ff4488', '#ff8844', '#8844ff',
    '#44ff88', '#ff4400', '#8800ff', '#00ff44', '#4400ff',
    '#ffaa00', '#00aaff', '#aa00ff', '#ff00aa', '#aaff00'
  ];
  
  private static nextColorIndex = 0;
  private static speciesCounter = 0;

  static createSpecies(pointCount: number = 200, customParams?: Partial<Params>): Species {
    const id = `species_${this.speciesCounter++}`;
    const colorIndex = this.nextColorIndex % this.colorPalette.length;
    const color = this.colorPalette[colorIndex];
    this.nextColorIndex++;

    const params = createRandomParams(customParams);

    return {
      id,
      name: `Species ${this.speciesCounter}`,
      pointCount,
      points: new Float32Array(pointCount * 2),
      fields: {
        R_val: new Float32Array(pointCount),
        U_val: new Float32Array(pointCount),
        R_grad: new Float32Array(pointCount * 2),
        U_grad: new Float32Array(pointCount * 2),
        U_val_interactions: new Map<string, Float32Array>(),
        U_grad_interactions: new Map<string, Float32Array>(),
        U_val_pool: new Map<string, Float32Array>(),
        U_grad_pool: new Map<string, Float32Array>(),
      },
      params,
      color,
      renderStyle: {
        strokeStyle: color
      }
    };
  }

  static resetCounters(): void {
    this.nextColorIndex = 0;
    this.speciesCounter = 0;
  }
}

class ParticleSystem {
  private species: Map<string, Species> = new Map();
  private frameCount = 0;
  
  // Species-to-species interaction parameters
  // Map<speciesA_id, Map<speciesB_id, Params>>
  private interactionParams: Map<string, Map<string, Params>> = new Map();

  // Global simulation parameters
  private dt: number = 0.025; // Global time step

  // Constants
  private readonly WORLD_WIDTH = 55.0;
  private readonly WORLD_HEIGHT = 41.25; // 55 * (1200/1600) to match canvas aspect ratio
  private readonly STEPS_PER_FRAME = 10;

  constructor(initialSpeciesCount: number = 1) {
    SpeciesFactory.resetCounters();
    this.initializeSpecies(initialSpeciesCount);
  }

  private initializeSpecies(count: number): void {
    for (let i = 0; i < count; i++) {
      // Use 200 particles for single species, 125 for multiple species
      const particleCount = count === 1 ? 200 : 125;
      this.addSpecies(particleCount);
    }
  }

  private initSpeciesPoints(species: Species): void {
    for (let i = 0; i < species.pointCount; ++i) {
      // Spawn particles within safe bounds, accounting for rectangular world
      const spawnRangeX = Math.min(5.0, this.WORLD_WIDTH * 0.9); // 60% of world width
      const spawnRangeY = Math.min(5.0, this.WORLD_HEIGHT * 0.9); // 60% of world height
      
      species.points[i * 2] = (Math.random() - 0.5) * spawnRangeX;
      species.points[i * 2 + 1] = (Math.random() - 0.5) * spawnRangeY;
    }
  }

  // Add scaled vector to array
  private add_xy(a: Float32Array, i: number, x: number, y: number, c: number): void {
    a[i * 2] += x * c;
    a[i * 2 + 1] += y * c;
  }

  // Fast approximation of exp(-x*x)
  private fast_exp(x: number): number {
    let t = 1.0 + x / 32.0;
    t *= t; t *= t; t *= t; t *= t; t *= t; // t **= 32
    return t;
  }

  // Repulsion function and its derivative
  private repulsion_f(x: number, c_rep: number): [number, number] {
    const t = Math.max(1.0 - x, 0.0);
    return [0.5 * c_rep * t * t, -c_rep * t];
  }

  // Kernel function factory - returns [value, derivative]
  private kernel_f(x: number, mu: number, sigma: number, w: number, kernelType: KernelType): [number, number] {
    switch (kernelType) {
      case KernelType.GAUSSIAN:
        return this.gaussian_kernel(x, mu, sigma, w);
      
      case KernelType.EXPONENTIAL:
        return this.exponential_kernel(x, mu, sigma, w);
      
      case KernelType.POLYNOMIAL:
        return this.polynomial_kernel(x, mu, sigma, w);
      
      case KernelType.MEXICAN_HAT:
        return this.mexican_hat_kernel(x, mu, sigma, w);
      
      case KernelType.SIGMOID:
        return this.sigmoid_kernel(x, mu, sigma, w);
      
      case KernelType.SINC:
        return this.sinc_kernel(x, mu, sigma, w);
      
      default:
        return this.gaussian_kernel(x, mu, sigma, w);
    }
  }

  // Original Gaussian kernel
  private gaussian_kernel(x: number, mu: number, sigma: number, w: number): [number, number] {
    const t = (x - mu) / sigma;
    const y = w / this.fast_exp(t * t);
    return [y, -2.0 * t * y / sigma];
  }

  // Exponential decay kernel - asymmetric, longer tail
  private exponential_kernel(x: number, mu: number, sigma: number, w: number): [number, number] {
    const t = Math.abs(x - mu) / sigma;
    const exp_t = Math.exp(-t);
    const y = w * exp_t * 0.6; // Moderate dampening
    const sign = x >= mu ? 1 : -1;
    const dy = -sign * y / sigma;
    return [y, dy];
  }

  // Polynomial kernel - creates sharper peaks
  private polynomial_kernel(x: number, mu: number, sigma: number, w: number): [number, number] {
    const t = Math.abs(x - mu) / sigma;
    if (t > 1.0) return [0, 0];
    
    const poly = (1 - t * t) * (1 - t * t); // (1-t²)²
    const y = w * poly * 0.8; // Less dampening
    const sign = x >= mu ? 1 : -1;
    const dy = -3.2 * sign * t * (1 - t * t) * w / (sigma * sigma); // Stronger gradient
    return [y, dy];
  }

  // Mexican hat (Ricker) wavelet - creates inhibition zones
  private mexican_hat_kernel(x: number, mu: number, sigma: number, w: number): [number, number] {
    const t = (x - mu) / sigma;
    const t2 = t * t;
    const exp_term = Math.exp(-t2 / 2);
    const y = w * (1 - t2) * exp_term * 0.7; // Less dampening
    const dy = -w * t * (3 - t2) * exp_term * 0.7 / sigma;
    return [y, dy];
  }

  // Sigmoid kernel - creates step-like transitions
  private sigmoid_kernel(x: number, mu: number, sigma: number, w: number): [number, number] {
    const t = (x - mu) / (sigma * 1.5); // Sharper transitions
    const exp_t = Math.exp(-t);
    const sigmoid = 1 / (1 + exp_t);
    const y = w * sigmoid * 0.6; // Moderate dampening
    const dy = w * sigmoid * (1 - sigmoid) * 0.6 / (sigma * 1.5);
    return [y, dy];
  }

  // Sinc kernel - creates oscillatory patterns
  private sinc_kernel(x: number, mu: number, sigma: number, w: number): [number, number] {
    const t = (x - mu) / sigma;
    if (Math.abs(t) < 1e-6) {
      return [w * 0.5, 0]; // Less dampening
    }
    
    // Allow more oscillations for interesting patterns
    if (Math.abs(t) > 4) return [0, 0];
    
    const pi_t = Math.PI * t;
    const sinc_val = Math.sin(pi_t) / pi_t;
    const y = w * sinc_val * 0.5; // Less dampening
    const dy = w * Math.PI * (Math.cos(pi_t) * pi_t - Math.sin(pi_t)) * 0.5 / (pi_t * pi_t * sigma);
    return [y, dy];
  }

  // Legacy function for backward compatibility
  private peak_f(x: number, mu: number, sigma: number, w: number = 1.0): [number, number] {
    return this.gaussian_kernel(x, mu, sigma, w);
  }

  // Compute all species interactions
  private computeAllSpeciesFields(): void {
    // Reset all fields and initialize interaction-specific arrays
    for (const species of this.species.values()) {
      const { R_val, U_val, R_grad, U_grad, U_val_interactions, U_grad_interactions, U_val_pool, U_grad_pool } = species.fields;
      const { c_rep, mu_k, sigma_k, w_k } = species.params;
      
      // Account for the own field of each particle
      R_val.fill(this.repulsion_f(0.0, c_rep)[0]);
      U_val.fill(this.peak_f(0.0, mu_k, sigma_k, w_k)[0]);
      R_grad.fill(0);
      U_grad.fill(0);
      
      // Clear interaction arrays but reuse existing ones
      U_val_interactions.clear();
      U_grad_interactions.clear();
      for (const otherSpecies of this.species.values()) {
        if (otherSpecies.id !== species.id) {
          // Get or create pooled arrays
          let U_val_array = U_val_pool.get(otherSpecies.id);
          let U_grad_array = U_grad_pool.get(otherSpecies.id);
          
          if (!U_val_array || U_val_array.length !== species.pointCount) {
            U_val_array = new Float32Array(species.pointCount);
            U_val_pool.set(otherSpecies.id, U_val_array);
          } else {
            U_val_array.fill(0);
          }
          
          if (!U_grad_array || U_grad_array.length !== species.pointCount * 2) {
            U_grad_array = new Float32Array(species.pointCount * 2);
            U_grad_pool.set(otherSpecies.id, U_grad_array);
          } else {
            U_grad_array.fill(0);
          }
          
          U_val_interactions.set(otherSpecies.id, U_val_array);
          U_grad_interactions.set(otherSpecies.id, U_grad_array);
        }
      }
      // Self-interaction array
      let U_val_self = U_val_pool.get('self');
      let U_grad_self = U_grad_pool.get('self');
      
      if (!U_val_self || U_val_self.length !== species.pointCount) {
        U_val_self = new Float32Array(species.pointCount);
        U_val_pool.set('self', U_val_self);
      } else {
        U_val_self.fill(0);
      }
      
      if (!U_grad_self || U_grad_self.length !== species.pointCount * 2) {
        U_grad_self = new Float32Array(species.pointCount * 2);
        U_grad_pool.set('self', U_grad_self);
      } else {
        U_grad_self.fill(0);
      }
      
      U_val_interactions.set('self', U_val_self);
      U_grad_interactions.set('self', U_grad_self);
    }

    // Compute interactions between all species pairs
    const speciesArray = Array.from(this.species.values());
    for (let speciesA_idx = 0; speciesA_idx < speciesArray.length; speciesA_idx++) {
      for (let speciesB_idx = speciesA_idx; speciesB_idx < speciesArray.length; speciesB_idx++) {
        const speciesA = speciesArray[speciesA_idx];
        const speciesB = speciesArray[speciesB_idx];
        
        if (speciesA_idx === speciesB_idx) {
          // Intra-species interaction
          this.computeIntraSpeciesInteraction(speciesA);
        } else {
          // Inter-species interaction using the same structure as intra-species
          this.computeInterSpeciesInteraction(speciesA, speciesB);
        }
      }
    }
  }

  private computeInterSpeciesInteraction(speciesA: Species, speciesB: Species): void {
    // Get interaction parameters for A->B and B->A
    const paramsAB = this.interactionParams.get(speciesA.id)?.get(speciesB.id);
    const paramsBA = this.interactionParams.get(speciesB.id)?.get(speciesA.id);
    
    // Skip if no interaction parameters are defined
    if (!paramsAB && !paramsBA) return;

    // Get interaction-specific arrays
    const U_val_A_from_B = speciesA.fields.U_val_interactions.get(speciesB.id);
    const U_grad_A_from_B = speciesA.fields.U_grad_interactions.get(speciesB.id);
    const U_val_B_from_A = speciesB.fields.U_val_interactions.get(speciesA.id);
    const U_grad_B_from_A = speciesB.fields.U_grad_interactions.get(speciesA.id);

    for (let i = 0; i < speciesA.pointCount; ++i) {
      for (let j = 0; j < speciesB.pointCount; ++j) {
        let rx = speciesA.points[i * 2] - speciesB.points[j * 2];
        let ry = speciesA.points[i * 2 + 1] - speciesB.points[j * 2 + 1];
        const r_squared = rx * rx + ry * ry;
        
        // Early exit for very distant particles (beyond any interaction range)
        if (r_squared > 100.0) continue; // sqrt(100) = 10, reasonable max interaction range
        
        const r = Math.sqrt(r_squared) + 1e-20;
        rx /= r; ry /= r; // ∇r = [rx, ry]

        // Repulsion - Species A uses its interaction parameters with B
        // Use squared distance comparison to avoid sqrt when possible
        if (r_squared < 1.0 && paramsAB) {
          const [R_A, dR_A] = this.repulsion_f(r, paramsAB.c_rep);
          this.add_xy(speciesA.fields.R_grad, i, rx, ry, dR_A);
          speciesA.fields.R_val[i] += R_A;
        }
        
        // Repulsion - Species B uses its interaction parameters with A
        if (r_squared < 1.0 && paramsBA) {
          const [R_B, dR_B] = this.repulsion_f(r, paramsBA.c_rep);
          this.add_xy(speciesB.fields.R_grad, j, rx, ry, -dR_B);
          speciesB.fields.R_val[j] += R_B;
        }

        // Attraction - Species A uses its interaction parameters with B
        if (paramsAB && U_val_A_from_B && U_grad_A_from_B) {
          const [K_A, dK_A] = this.kernel_f(r, paramsAB.mu_k, paramsAB.sigma_k, paramsAB.w_k, paramsAB.kernel_k_type);
          // Store in species-specific interaction arrays
          this.add_xy(U_grad_A_from_B, i, rx, ry, dK_A);
          U_val_A_from_B[i] += K_A;
          // Also add to main arrays for backward compatibility
          this.add_xy(speciesA.fields.U_grad, i, rx, ry, dK_A);
          speciesA.fields.U_val[i] += K_A;
        }
        
        // Attraction - Species B uses its interaction parameters with A
        if (paramsBA && U_val_B_from_A && U_grad_B_from_A) {
          const [K_B, dK_B] = this.kernel_f(r, paramsBA.mu_k, paramsBA.sigma_k, paramsBA.w_k, paramsBA.kernel_k_type);
          // Store in species-specific interaction arrays
          this.add_xy(U_grad_B_from_A, j, rx, ry, -dK_B);
          U_val_B_from_A[j] += K_B;
          // Also add to main arrays for backward compatibility
          this.add_xy(speciesB.fields.U_grad, j, rx, ry, -dK_B);
          speciesB.fields.U_val[j] += K_B;
        }
      }
    }
  }

  private computeIntraSpeciesInteraction(species: Species): void {
    const { R_val, U_val, R_grad, U_grad, U_val_interactions, U_grad_interactions } = species.fields;
    const { c_rep, mu_k, sigma_k, w_k } = species.params;
    const { points, pointCount } = species;

    // Get self-interaction arrays
    const U_val_self = U_val_interactions.get('self')!;
    const U_grad_self = U_grad_interactions.get('self')!;

    for (let i = 0; i < pointCount - 1; ++i) {
      for (let j = i + 1; j < pointCount; ++j) {
        let rx = points[i * 2] - points[j * 2];
        let ry = points[i * 2 + 1] - points[j * 2 + 1];
        const r_squared = rx * rx + ry * ry;
        
        // Early exit for very distant particles
        if (r_squared > 100.0) continue;
        
        const r = Math.sqrt(r_squared) + 1e-20;
        rx /= r; ry /= r; // ∇r = [rx, ry]

        // Use squared distance comparison for repulsion check
        if (r_squared < 1.0) {
          // ∇R = R'(r) ∇r
          const [R, dR] = this.repulsion_f(r, c_rep);
          this.add_xy(R_grad, i, rx, ry, dR);
          this.add_xy(R_grad, j, rx, ry, -dR);
          R_val[i] += R; R_val[j] += R;
        }

        // ∇K = K'(r) ∇r (attraction within species) - store in self-interaction arrays
        const [K, dK] = this.kernel_f(r, mu_k, sigma_k, w_k, species.params.kernel_k_type);
        this.add_xy(U_grad_self, i, rx, ry, dK);
        this.add_xy(U_grad_self, j, rx, ry, -dK);
        U_val_self[i] += K; U_val_self[j] += K;
        
        // Also add to main U arrays for backward compatibility
        this.add_xy(U_grad, i, rx, ry, dK);
        this.add_xy(U_grad, j, rx, ry, -dK);
        U_val[i] += K; U_val[j] += K;
      }
    }
  }

  // Simulation step for a single species
  private stepSpecies(species: Species): number {
    const { R_val, U_val, R_grad, U_grad, U_val_interactions, U_grad_interactions } = species.fields;
    const { mu_g, sigma_g } = species.params;
    const { points, pointCount } = species;

    let total_E = 0.0;
    for (let i = 0; i < pointCount; ++i) {
      let total_vx = 0.0;
      let total_vy = 0.0;
      let total_G = 0.0;

      // Apply species-specific responses to each interaction source
      for (const [sourceSpeciesId, U_val_from_source] of U_val_interactions) {
        const U_grad_from_source = U_grad_interactions.get(sourceSpeciesId);
        if (!U_grad_from_source) continue;

        // Get interaction parameters for this species responding to the source
        let response_mu_g = mu_g;
        let response_sigma_g = sigma_g;
        
        if (sourceSpeciesId !== 'self') {
          // Use interaction-specific response parameters
          const interactionParams = this.interactionParams.get(species.id)?.get(sourceSpeciesId);
          if (interactionParams) {
            response_mu_g = interactionParams.mu_g;
            response_sigma_g = interactionParams.sigma_g;
          }
        }

        // Apply species-specific response function using appropriate kernel type
        let kernelType = species.params.kernel_g_type;
        if (sourceSpeciesId !== 'self') {
          const interactionParams = this.interactionParams.get(species.id)?.get(sourceSpeciesId);
          if (interactionParams) {
            kernelType = interactionParams.kernel_g_type;
          }
        }
        
        const [G, dG] = this.kernel_f(U_val_from_source[i], response_mu_g, response_sigma_g, 1.0, kernelType);
        total_vx += dG * U_grad_from_source[i * 2];
        total_vy += dG * U_grad_from_source[i * 2 + 1];
        total_G += G;
      }

      // [vx, vy] = -∇E = G'(U)∇U - ∇R
      let vx = total_vx - R_grad[i * 2];
      let vy = total_vy - R_grad[i * 2 + 1];
      
      // Apply boundary forces to keep particles within visible world
      const halfWorldX = this.WORLD_WIDTH / 2;
      const halfWorldY = this.WORLD_HEIGHT / 2;
      const boundaryStrength = 5.0; // Strength of boundary repulsion
      const boundaryMargin = 2.0;   // Distance from edge where force starts
      
      const currentX = points[i * 2];
      const currentY = points[i * 2 + 1];
      
      // Apply boundary forces for X direction
      if (currentX > halfWorldX - boundaryMargin) {
        const distance = currentX - (halfWorldX - boundaryMargin);
        vx -= boundaryStrength * distance * distance;
      } else if (currentX < -halfWorldX + boundaryMargin) {
        const distance = (-halfWorldX + boundaryMargin) - currentX;
        vx += boundaryStrength * distance * distance;
      }
      
      // Apply boundary forces for Y direction
      if (currentY > halfWorldY - boundaryMargin) {
        const distance = currentY - (halfWorldY - boundaryMargin);
        vy -= boundaryStrength * distance * distance;
      } else if (currentY < -halfWorldY + boundaryMargin) {
        const distance = (-halfWorldY + boundaryMargin) - currentY;
        vy += boundaryStrength * distance * distance;
      }
      
      this.add_xy(points, i, vx, vy, this.dt);
      
      // Failsafe: Hard clamp if particles somehow get beyond boundaries
      if (points[i * 2] > halfWorldX) {
        points[i * 2] = halfWorldX;
      } else if (points[i * 2] < -halfWorldX) {
        points[i * 2] = -halfWorldX;
      }
      
      if (points[i * 2 + 1] > halfWorldY) {
        points[i * 2 + 1] = halfWorldY;
      } else if (points[i * 2 + 1] < -halfWorldY) {
        points[i * 2 + 1] = -halfWorldY;
      }
      
      total_E += R_val[i] - total_G;
    }
    return total_E / pointCount;
  }

  // Main simulation step
  public step(): void {
    // Compute all interactions first (both intra and inter-species)
    this.computeAllSpeciesFields();
    
    // Then update all species
    for (const species of this.species.values()) {
      this.stepSpecies(species);
    }
  }

  // Render a single species
  private renderSpecies(ctx: CanvasRenderingContext2D, species: Species): void {
    const { points, pointCount, fields, params, renderStyle } = species;
    
    ctx.strokeStyle = renderStyle.strokeStyle;
    if (renderStyle.fillStyle) {
      ctx.fillStyle = renderStyle.fillStyle;
    }

    for (let i = 0; i < pointCount; ++i) {
      ctx.beginPath();
      const x = points[i * 2];
      const y = points[i * 2 + 1];
      const r = params.c_rep / (fields.R_val[i] * 5.0);
      ctx.arc(x, y, r, 0.0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // Main animation and rendering
  public animate(ctx: CanvasRenderingContext2D): void {
    for (let i = 0; i < this.STEPS_PER_FRAME; ++i) {
      this.step();
    }

    const { width, height } = ctx.canvas;
    ctx.resetTransform();
    ctx.clearRect(0, 0, width, height);
    ctx.translate(width / 2, height / 2);

    const s = width / this.WORLD_WIDTH;
    ctx.scale(s, s);
    ctx.lineWidth = 0.1;

    // Render all species
    for (const species of this.species.values()) {
      this.renderSpecies(ctx, species);
    }

    this.frameCount++;
    if (this.frameCount % 60 === 0) {
      this.updateInfo();
    }
  }

  // Update info display
  private updateInfo(): void {
    const info = document.querySelector<HTMLDivElement>('#info');
    if (info) {
      const totalParticles = Array.from(this.species.values())
        .reduce((sum, species) => sum + species.pointCount, 0);
      
      const speciesInfo = Array.from(this.species.values())
        .map(species => {
          const kType = species.params.kernel_k_type.replace('_', ' ');
          const gType = species.params.kernel_g_type.replace('_', ' ');
          return `<div style="color: ${species.color}">
            ${species.name}: ${species.pointCount} particles
            <br>&nbsp;&nbsp;K: ${kType}, G: ${gType}
          </div>`;
        })
        .join('');
      
      info.innerHTML = `
        <div>Frame: ${this.frameCount}</div>
        <div>Total Particles: ${totalParticles}</div>
        <div style="margin-top: 10px;">
          <strong>Species Kernels:</strong>
          ${speciesInfo}
        </div>
      `;
    }
  }



  // Update interaction parameters when a new species is added
  private updateInteractionParams(newSpeciesId: string): void {
    const allSpeciesIds = Array.from(this.species.keys());
    
    // Create interaction parameters for the new species
    const newSpeciesInteractions = new Map<string, Params>();
    
    for (const existingId of allSpeciesIds) {
      if (existingId !== newSpeciesId) {
        // Create unique interaction parameters for new species -> existing species
        newSpeciesInteractions.set(existingId, createRandomParams());
        
        // Create unique interaction parameters for existing species -> new species
        const existingInteractions = this.interactionParams.get(existingId);
        if (existingInteractions) {
          existingInteractions.set(newSpeciesId, createRandomParams());
        }
      }
    }
    
    this.interactionParams.set(newSpeciesId, newSpeciesInteractions);
  }

  // Remove interaction parameters when a species is removed
  private removeInteractionParams(speciesId: string): void {
    this.interactionParams.delete(speciesId);
    for (const interactions of this.interactionParams.values()) {
      interactions.delete(speciesId);
    }
  }

  // Add a new species to the simulation
  public addSpecies(pointCount: number = 150, customParams?: Partial<Params>): string {
    const species = SpeciesFactory.createSpecies(pointCount, customParams);
    
    // Add the new species to the simulation's species Map, using the species ID as the key
    // This allows us to track and manage all species in the simulation
    this.species.set(species.id, species);
    this.initSpeciesPoints(species);
    this.updateInteractionParams(species.id);
    this.updateInfo();
    return species.id;
  }

  // Remove a species from the simulation
  public removeSpecies(speciesId: string): boolean {
    if (this.species.has(speciesId)) {
      this.species.delete(speciesId);
      this.removeInteractionParams(speciesId);
      this.updateInfo();
      return true;
    }
    return false;
  }

  // Reset simulation
  public reset(speciesCount?: number): void {
    this.frameCount = 0;
    
    if (speciesCount !== undefined) {
      // Reset with new species count
      this.species.clear();
      this.interactionParams.clear();
      SpeciesFactory.resetCounters();
      this.initializeSpecies(speciesCount);
    } else {
      // Reset existing species with new parameters and positions
      for (const species of this.species.values()) {
        // Regenerate random parameters for each species
        const newSpecies = SpeciesFactory.createSpecies(species.pointCount);
        species.params = newSpecies.params;
        // Reinitialize positions
        this.initSpeciesPoints(species);
      }
      
      // Regenerate all interaction parameters
      this.interactionParams.clear();
      const speciesIds = Array.from(this.species.keys());
      for (const speciesId of speciesIds) {
        this.updateInteractionParams(speciesId);
      }
    }
    
    this.updateInfo();
  }

  // Get species for external access (if needed)
  public getSpecies(): Map<string, Species> {
    return this.species;
  }

  // Get current species count
  public getSpeciesCount(): number {
    return this.species.size;
  }

  // Get interaction parameters between two species
  public getInteractionParams(speciesAId: string, speciesBId: string): Params | undefined {
    return this.interactionParams.get(speciesAId)?.get(speciesBId);
  }

  // Set interaction parameters between two species
  public setInteractionParams(speciesAId: string, speciesBId: string, params: Params): boolean {
    if (!this.species.has(speciesAId) || !this.species.has(speciesBId)) {
      return false;
    }
    
    const speciesAInteractions = this.interactionParams.get(speciesAId);
    if (speciesAInteractions) {
      speciesAInteractions.set(speciesBId, params);
      return true;
    }
    return false;
  }

  // Convenience method to set only response parameters (mu_g, sigma_g) for a species pair
  public setSpeciesResponse(speciesAId: string, speciesBId: string, mu_g: number, sigma_g: number): boolean {
    const existingParams = this.getInteractionParams(speciesAId, speciesBId);
    if (!existingParams) return false;
    
    return this.setInteractionParams(speciesAId, speciesBId, {
      ...existingParams,
      mu_g,
      sigma_g
    });
  }

  // Update global dt
  public setDt(newDt: number): void {
    this.dt = newDt;
  }

  // Get current global dt
  public getDt(): number {
    return this.dt;
  }

  // Export simulation state to JSON
  public exportSimulation(): string {
    const simulationData = {
      timestamp: new Date().toISOString(),
      worldDimensions: {
        width: this.WORLD_WIDTH,
        height: this.WORLD_HEIGHT
      },
      stepsPerFrame: this.STEPS_PER_FRAME,
      species: Array.from(this.species.entries()).map(([id, species]) => ({
        id,
        name: species.name,
        pointCount: species.pointCount,
        params: species.params,
        color: species.color,
        renderStyle: species.renderStyle
      })),
      interactions: Array.from(this.interactionParams.entries()).map(([speciesAId, interactions]) => ({
        speciesAId,
        interactions: Array.from(interactions.entries()).map(([speciesBId, params]) => ({
          speciesBId,
          params
        }))
      }))
    };
    
    return JSON.stringify(simulationData, null, 2);
  }

  // Import simulation state from JSON
  public importSimulation(jsonData: string): boolean {
    try {
      const data = JSON.parse(jsonData);
      
      // Clear current simulation
      this.species.clear();
      this.interactionParams.clear();
      SpeciesFactory.resetCounters();
      
      // Helper to map numeric kernel codes back to string enums
      const mapNumberToKernel = (num: number): KernelType => {
        switch (num) {
          case 0: return KernelType.GAUSSIAN;
          case 1: return KernelType.EXPONENTIAL;
          case 2: return KernelType.POLYNOMIAL;
          case 3: return KernelType.MEXICAN_HAT;
          case 4: return KernelType.SIGMOID;
          case 5: return KernelType.SINC;
          default: return KernelType.GAUSSIAN;
        }
      };

      // Restore species
      for (const speciesData of data.species) {
        // Ensure kernel type fields are strings, not numeric codes (back-compat)
        const rawK = speciesData.params.kernel_k_type;
        const rawG = speciesData.params.kernel_g_type;

        const paramsCorrected = {
          ...speciesData.params,
          kernel_k_type: typeof rawK === 'number' ? mapNumberToKernel(rawK) : rawK,
          kernel_g_type: typeof rawG === 'number' ? mapNumberToKernel(rawG) : rawG
        } as Params;

        const species: Species = {
          id: speciesData.id,
          name: speciesData.name,
          pointCount: speciesData.pointCount,
          points: new Float32Array(speciesData.pointCount * 2), // Initialize empty points array
          fields: {
            R_val: new Float32Array(speciesData.pointCount),
            U_val: new Float32Array(speciesData.pointCount),
            R_grad: new Float32Array(speciesData.pointCount * 2),
            U_grad: new Float32Array(speciesData.pointCount * 2),
            U_val_interactions: new Map<string, Float32Array>(),
            U_grad_interactions: new Map<string, Float32Array>(),
            U_val_pool: new Map<string, Float32Array>(),
            U_grad_pool: new Map<string, Float32Array>(),
          },
          params: paramsCorrected,
          color: speciesData.color,
          renderStyle: speciesData.renderStyle
        };
        
        this.species.set(species.id, species);
        // Initialize particle positions randomly
        this.initSpeciesPoints(species);
      }
      
      // Restore interaction parameters
      for (const interactionData of data.interactions) {
        const interactions = new Map<string, Params>();
        for (const interaction of interactionData.interactions) {
          interactions.set(interaction.speciesBId, interaction.params);
        }
        this.interactionParams.set(interactionData.speciesAId, interactions);
      }
      
      // Update species counter to avoid ID conflicts
      const maxSpeciesNum = Math.max(...Array.from(this.species.keys())
        .map(id => parseInt(id.replace('species_', '')) || 0));
      SpeciesFactory['speciesCounter'] = maxSpeciesNum + 1;
      
      this.frameCount = 0;
      this.updateInfo();
      return true;
      
    } catch (error) {
      console.error('Failed to import simulation:', error);
      return false;
    }
  }

  // Save simulation to file
  public saveSimulation(filename?: string): void {
    const data = this.exportSimulation();
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `particle-lenia-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // Load simulation from file
  public loadSimulationFile(file: File): Promise<boolean> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result;
        if (typeof result === 'string') {
          const success = this.importSimulation(result);
          resolve(success);
        } else {
          resolve(false);
        }
      };
      reader.onerror = () => resolve(false);
      reader.readAsText(file);
    });
  }

}

// Global particle system instance
let particleSystem: ParticleSystem;

// Animation loop
function animationLoop(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  particleSystem.animate(ctx);
  requestAnimationFrame(animationLoop);
}

// Initialize everything
function initialize(): void {
  // Initialize particle system
  particleSystem = new ParticleSystem();

  // Set up event listeners
  const resetButton = document.querySelector<HTMLButtonElement>('#reset');
  if (resetButton) {
    resetButton.addEventListener('click', () => particleSystem.reset());
  }

  const speciesSlider = document.querySelector<HTMLInputElement>('#species-slider');
  const speciesCountDisplay = document.querySelector<HTMLSpanElement>('#species-count');
  
  if (speciesSlider && speciesCountDisplay) {
    // Update display when slider changes
    speciesSlider.addEventListener('input', () => {
      const count = parseInt(speciesSlider.value);
      speciesCountDisplay.textContent = count.toString();
      particleSystem.reset(count);
      console.log(`Reset with ${count} species`);
    });
  }

  const dtSlider = document.querySelector<HTMLInputElement>('#dt-slider');
  const dtValueDisplay = document.querySelector<HTMLSpanElement>('#dt-value');
  
  if (dtSlider && dtValueDisplay) {
    // Update display and dt value when slider changes
    dtSlider.addEventListener('input', () => {
      const dtValue = parseFloat(dtSlider.value);
      dtValueDisplay.textContent = dtValue.toFixed(3);
      particleSystem.setDt(dtValue);
      console.log(`Set dt to ${dtValue}`);
    });
  }

  // Save simulation button
  const saveButton = document.querySelector<HTMLButtonElement>('#save-button');
  if (saveButton) {
    saveButton.addEventListener('click', () => {
      particleSystem.saveSimulation();
      console.log('Simulation saved');
    });
  }

  // Load simulation file input
  const loadInput = document.querySelector<HTMLInputElement>('#load-input');
  if (loadInput) {
    loadInput.addEventListener('change', async (event) => {
      const files = (event.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        const success = await particleSystem.loadSimulationFile(files[0]);
        if (success) {
          console.log('Simulation loaded successfully');
          
          // Update species slider and display to match loaded simulation
          const currentSpeciesCount = particleSystem.getSpeciesCount();
          if (speciesSlider && speciesCountDisplay) {
            speciesSlider.value = currentSpeciesCount.toString();
            speciesCountDisplay.textContent = currentSpeciesCount.toString();
          }
          
          // Update dt slider and display to match loaded simulation
          const currentDt = particleSystem.getDt();
          if (dtSlider && dtValueDisplay) {
            dtSlider.value = currentDt.toString();
            dtValueDisplay.textContent = currentDt.toFixed(3);
          }
        } else {
          console.error('Failed to load simulation');
          alert('Failed to load simulation file. Please check the file format.');
        }
        // Reset the input so the same file can be loaded again
        loadInput.value = '';
      }
    });
  }

  // Load simulation button (triggers file input)
  const loadButton = document.querySelector<HTMLButtonElement>('#load-button');
  if (loadButton && loadInput) {
    loadButton.addEventListener('click', () => {
      loadInput.click();
    });
  }

  // Start animation
  animationLoop();

  // Initial info display
  particleSystem.reset(); // This will trigger updateInfo()
}

// Start when DOM is loaded
document.addEventListener('DOMContentLoaded', initialize);
