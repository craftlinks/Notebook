import './style.css'

// Type definitions
interface Params {
  mu_k: number;
  sigma_k: number;
  w_k: number;
  mu_g: number;
  sigma_g: number;
  c_rep: number;
  dt: number;
}

// Add interaction interface to define cross-species interactions
interface SpeciesInteraction {
  repulsion: number;  // Repulsion strength multiplier (0.0 = no repulsion)
  attraction: number; // Attraction strength multiplier (0.0 = no attraction)
}

interface Fields {
  R_val: Float32Array;
  U_val: Float32Array;
  R_grad: Float32Array;
  U_grad: Float32Array;
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

class ParticleSystem {
  private species: Map<string, Species> = new Map();
  private frameCount = 0;
  
  // Species interaction matrix - controls repulsion and attraction between different species
  private interactionMatrix: Map<string, Map<string, SpeciesInteraction>> = new Map();

  // Constants
  private readonly WORLD_WIDTH = 75.0;
  private readonly STEPS_PER_FRAME = 10;

  constructor() {
    this.initializeSpecies();
    this.initializeInteractionMatrix();
  }

  // Generate randomized parameters within reasonable ranges
  private generateRandomParams(): Params {
    return {
      mu_k: 2.0 + Math.random() * 4.0,        // Peak distance for attraction: 2.0-6.0
      sigma_k: 0.5 + Math.random() * 1.5,     // Width of attraction kernel: 0.5-2.0
      w_k: 0.01 + Math.random() * 0.04,       // Attraction strength: 0.01-0.05
      mu_g: 0.3 + Math.random() * 0.7,        // Growth function peak: 0.3-1.0
      sigma_g: 0.05 + Math.random() * 0.2,    // Growth function width: 0.05-0.25
      c_rep: 0.5 + Math.random() * 1.0,       // Repulsion strength: 0.5-1.5
      dt: 0.05 + Math.random() * 0.1          // Time step: 0.05-0.15
    };
  }

  private initializeSpecies(): void {
    // First species (original green particles)
    const species1: Species = {
      id: 'green',
      name: 'Green Species',
      pointCount: 200,
      points: new Float32Array(200 * 2),
      fields: {
        R_val: new Float32Array(200),
        U_val: new Float32Array(200),
        R_grad: new Float32Array(200 * 2),
        U_grad: new Float32Array(200 * 2),
      },
      params: this.generateRandomParams(),
      color: 'green',
      renderStyle: {
        strokeStyle: '#00ff88'
      }
    };

    // Second species (blue particles with different parameters)
    const species2: Species = {
      id: 'blue',
      name: 'Blue Species',
      pointCount: 200,
      points: new Float32Array(200 * 2),
      fields: {
        R_val: new Float32Array(200),
        U_val: new Float32Array(200),
        R_grad: new Float32Array(200 * 2),
        U_grad: new Float32Array(200 * 2),
      },
      params: this.generateRandomParams(),
      color: 'blue',
      renderStyle: {
        strokeStyle: '#4488ff'
      }
    };

    this.species.set(species1.id, species1);
    this.species.set(species2.id, species2);

    // Initialize positions for both species
    this.initSpeciesPoints(species1);
    this.initSpeciesPoints(species2);
  }

  private initSpeciesPoints(species: Species): void {
    for (let i = 0; i < species.pointCount; ++i) {
      // Slightly different initial positioning for different species
      // const offset = species.id === 'green' ? 0 : 20;
      species.points[i * 2] = (Math.random() - 0.5) * 12;
      species.points[i * 2 + 1] = (Math.random() - 0.5) * 12;
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

  // Peak function (Gaussian-like) and its derivative
  private peak_f(x: number, mu: number, sigma: number, w: number = 1.0): [number, number] {
    const t = (x - mu) / sigma;
    const y = w / this.fast_exp(t * t);
    return [y, -2.0 * t * y / sigma];
  }

  // Compute all species interactions using the interaction matrix
  private computeAllSpeciesFields(): void {
    // Reset all fields
    for (const species of this.species.values()) {
      const { R_val, U_val, R_grad, U_grad } = species.fields;
      const { c_rep, mu_k, sigma_k, w_k } = species.params;
      
      // Account for the own field of each particle
      R_val.fill(this.repulsion_f(0.0, c_rep)[0]);
      U_val.fill(this.peak_f(0.0, mu_k, sigma_k, w_k)[0]);
      R_grad.fill(0);
      U_grad.fill(0);
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
          // Inter-species interaction
          this.computeInterSpeciesInteraction(speciesA, speciesB);
        }
      }
    }
  }

  private computeIntraSpeciesInteraction(species: Species): void {
    const { R_val, U_val, R_grad, U_grad } = species.fields;
    const { c_rep, mu_k, sigma_k, w_k } = species.params;
    const { points, pointCount } = species;

    for (let i = 0; i < pointCount - 1; ++i) {
      for (let j = i + 1; j < pointCount; ++j) {
        let rx = points[i * 2] - points[j * 2];
        let ry = points[i * 2 + 1] - points[j * 2 + 1];
        const r = Math.sqrt(rx * rx + ry * ry) + 1e-20;
        rx /= r; ry /= r; // ∇r = [rx, ry]

        if (r < 1.0) {
          // ∇R = R'(r) ∇r
          const [R, dR] = this.repulsion_f(r, c_rep);
          this.add_xy(R_grad, i, rx, ry, dR);
          this.add_xy(R_grad, j, rx, ry, -dR);
          R_val[i] += R; R_val[j] += R;
        }

        // ∇K = K'(r) ∇r (attraction within species)
        const [K, dK] = this.peak_f(r, mu_k, sigma_k, w_k);
        this.add_xy(U_grad, i, rx, ry, dK);
        this.add_xy(U_grad, j, rx, ry, -dK);
        U_val[i] += K; U_val[j] += K;
      }
    }
  }

  private computeInterSpeciesInteraction(speciesA: Species, speciesB: Species): void {
    const interactionA = this.interactionMatrix.get(speciesA.id)?.get(speciesB.id);
    const interactionB = this.interactionMatrix.get(speciesB.id)?.get(speciesA.id);
    
    // Only compute if there's some interaction
    if (!interactionA && !interactionB) return;

    for (let i = 0; i < speciesA.pointCount; ++i) {
      for (let j = 0; j < speciesB.pointCount; ++j) {
        let rx = speciesA.points[i * 2] - speciesB.points[j * 2];
        let ry = speciesA.points[i * 2 + 1] - speciesB.points[j * 2 + 1];
        const r = Math.sqrt(rx * rx + ry * ry) + 1e-20;
        rx /= r; ry /= r; // ∇r = [rx, ry]

        // Repulsion between different species
        if (r < 1.0) {
          // Species A feels repulsion from Species B
          if (interactionA) {
            const [R_A, dR_A] = this.repulsion_f(r, speciesA.params.c_rep * interactionA.repulsion);
            this.add_xy(speciesA.fields.R_grad, i, rx, ry, dR_A);
            speciesA.fields.R_val[i] += R_A;
          }
          
          // Species B feels repulsion from Species A
          if (interactionB) {
            const [R_B, dR_B] = this.repulsion_f(r, speciesB.params.c_rep * interactionB.repulsion);
            this.add_xy(speciesB.fields.R_grad, j, rx, ry, -dR_B);
            speciesB.fields.R_val[j] += R_B;
          }
        }

        // Cross-species attraction using peak function
        // Species A feels attraction from Species B
        if (interactionA && interactionA.attraction > 0.0) {
          const [K_A, dK_A] = this.peak_f(r, speciesA.params.mu_k, speciesA.params.sigma_k, speciesA.params.w_k * interactionA.attraction);
          this.add_xy(speciesA.fields.U_grad, i, rx, ry, dK_A);
          speciesA.fields.U_val[i] += K_A;
        }
        
        // Species B feels attraction from Species A
        if (interactionB && interactionB.attraction > 0.0) {
          const [K_B, dK_B] = this.peak_f(r, speciesB.params.mu_k, speciesB.params.sigma_k, speciesB.params.w_k * interactionB.attraction);
          this.add_xy(speciesB.fields.U_grad, j, rx, ry, -dK_B);
          speciesB.fields.U_val[j] += K_B;
        }
      }
    }
  }

  // Simulation step for a single species
  private stepSpecies(species: Species): number {
    const { R_val, U_val, R_grad, U_grad } = species.fields;
    const { mu_g, sigma_g, dt } = species.params;
    const { points, pointCount } = species;

    let total_E = 0.0;
    for (let i = 0; i < pointCount; ++i) {
      const [G, dG] = this.peak_f(U_val[i], mu_g, sigma_g);
      // [vx, vy] = -∇E = G'(U)∇U - ∇R
      const vx = dG * U_grad[i * 2] - R_grad[i * 2];
      const vy = dG * U_grad[i * 2 + 1] - R_grad[i * 2 + 1];
      this.add_xy(points, i, vx, vy, dt);
      total_E += R_val[i] - G;
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
        .map(species => `${species.name}: ${species.pointCount}`)
        .join(', ');
      
      info.innerHTML = `
        <div>Frame: ${this.frameCount}</div>
        <div>Total Particles: ${totalParticles}</div>
        <div>${speciesInfo}</div>
      `;
    }
  }

  // Reset simulation
  public reset(): void {
    this.frameCount = 0;
    for (const species of this.species.values()) {
      // Regenerate random parameters for each species
      species.params = this.generateRandomParams();
      // Reinitialize positions
      this.initSpeciesPoints(species);
    }
    this.updateInfo();
  }

  // Get species for external access (if needed)
  public getSpecies(): Map<string, Species> {
    return this.species;
  }

  private initializeInteractionMatrix(): void {
    // Initialize interaction matrix with repulsion and attraction factors between species
    // repulsion: how strongly species A repels species B (0.0 = no repulsion, 1.0 = same as intra-species)
    // attraction: how strongly species A attracts species B (0.0 = no attraction, 1.0 = same as intra-species)
    
    const greenInteractions = new Map<string, SpeciesInteraction>();
    greenInteractions.set('green', { repulsion: 1.0, attraction: 0.0 });
    greenInteractions.set('blue', { repulsion: 0.5, attraction: 0.2 });  // Green has weak attraction to blue
    
    const blueInteractions = new Map<string, SpeciesInteraction>();
    blueInteractions.set('blue', { repulsion: 1.0, attraction: 0.0 });
    blueInteractions.set('green', { repulsion: 0.3, attraction: 0.3 }); // Blue has moderate attraction to green
    
    this.interactionMatrix.set('green', greenInteractions);
    this.interactionMatrix.set('blue', blueInteractions);
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

  // Start animation
  animationLoop();

  // Initial info display
  particleSystem.reset(); // This will trigger updateInfo()
}

// Start when DOM is loaded
document.addEventListener('DOMContentLoaded', initialize);
