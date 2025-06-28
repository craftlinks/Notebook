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

// Interaction parameters for species-to-species interactions
interface InteractionParams {
  mu_k: number;
  sigma_k: number;
  w_k: number;
  c_rep: number;
  mu_g: number;    // How this species responds to the other species
  sigma_g: number; // Width of response to the other species
}



interface Fields {
  R_val: Float32Array;
  U_val: Float32Array;
  R_grad: Float32Array;
  U_grad: Float32Array;
  // Interaction-specific U fields for species-specific responses
  U_val_interactions: Map<string, Float32Array>;  // Map<otherSpeciesId, U_val>
  U_grad_interactions: Map<string, Float32Array>; // Map<otherSpeciesId, U_grad>
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

    const params = {
      mu_k: 2.0 + (Math.random() - 0.5) * 14.0,
      sigma_k: 0.5 + (Math.random() - 0.5) * 6.0,
      w_k: 0.01 + (Math.random() - 0.5) * 0.16,
      mu_g: 0.3 + (Math.random() - 0.5) * 1.4,
      sigma_g: 0.05 + (Math.random() - 0.5) * 0.4,
      c_rep: 0.5 + Math.random() * 2.0,
      dt: 0.05,
      ...customParams
    };

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
  // Map<speciesA_id, Map<speciesB_id, InteractionParams>>
  private interactionParams: Map<string, Map<string, InteractionParams>> = new Map();

  // Constants
  private readonly WORLD_WIDTH = 55.0;
  private readonly STEPS_PER_FRAME = 5;

  constructor(initialSpeciesCount: number = 2) {
    SpeciesFactory.resetCounters();
    this.initializeSpecies(initialSpeciesCount);
  }

  private initializeSpecies(count: number): void {
    for (let i = 0; i < count; i++) {
      this.addSpecies(100);
    }
  }

  private initSpeciesPoints(species: Species): void {
    for (let i = 0; i < species.pointCount; ++i) {
      // Slightly different initial positioning for different species
      // const offset = species.id === 'green' ? 0 : 20;
      species.points[i * 2] = (Math.random() - 0.5) * 7.0;
      species.points[i * 2 + 1] = (Math.random() - 0.5) * 7.0;
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

  // Compute all species interactions
  private computeAllSpeciesFields(): void {
    // Reset all fields and initialize interaction-specific arrays
    for (const species of this.species.values()) {
      const { R_val, U_val, R_grad, U_grad, U_val_interactions, U_grad_interactions } = species.fields;
      const { c_rep, mu_k, sigma_k, w_k } = species.params;
      
      // Account for the own field of each particle
      R_val.fill(this.repulsion_f(0.0, c_rep)[0]);
      U_val.fill(this.peak_f(0.0, mu_k, sigma_k, w_k)[0]);
      R_grad.fill(0);
      U_grad.fill(0);
      
      // Initialize interaction-specific arrays for each other species
      U_val_interactions.clear();
      U_grad_interactions.clear();
      for (const otherSpecies of this.species.values()) {
        if (otherSpecies.id !== species.id) {
          U_val_interactions.set(otherSpecies.id, new Float32Array(species.pointCount));
          U_grad_interactions.set(otherSpecies.id, new Float32Array(species.pointCount * 2));
        }
      }
      // Self-interaction array
      U_val_interactions.set('self', new Float32Array(species.pointCount));
      U_grad_interactions.set('self', new Float32Array(species.pointCount * 2));
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
        const r = Math.sqrt(rx * rx + ry * ry) + 1e-20;
        rx /= r; ry /= r; // ∇r = [rx, ry]

        // Repulsion - Species A uses its interaction parameters with B
        if (r < 1.0 && paramsAB) {
          const [R_A, dR_A] = this.repulsion_f(r, paramsAB.c_rep);
          this.add_xy(speciesA.fields.R_grad, i, rx, ry, dR_A);
          speciesA.fields.R_val[i] += R_A;
        }
        
        // Repulsion - Species B uses its interaction parameters with A
        if (r < 1.0 && paramsBA) {
          const [R_B, dR_B] = this.repulsion_f(r, paramsBA.c_rep);
          this.add_xy(speciesB.fields.R_grad, j, rx, ry, -dR_B);
          speciesB.fields.R_val[j] += R_B;
        }

        // Attraction - Species A uses its interaction parameters with B
        if (paramsAB && U_val_A_from_B && U_grad_A_from_B) {
          const [K_A, dK_A] = this.peak_f(r, paramsAB.mu_k, paramsAB.sigma_k, paramsAB.w_k);
          // Store in species-specific interaction arrays
          this.add_xy(U_grad_A_from_B, i, rx, ry, dK_A);
          U_val_A_from_B[i] += K_A;
          // Also add to main arrays for backward compatibility
          this.add_xy(speciesA.fields.U_grad, i, rx, ry, dK_A);
          speciesA.fields.U_val[i] += K_A;
        }
        
        // Attraction - Species B uses its interaction parameters with A
        if (paramsBA && U_val_B_from_A && U_grad_B_from_A) {
          const [K_B, dK_B] = this.peak_f(r, paramsBA.mu_k, paramsBA.sigma_k, paramsBA.w_k);
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
        const r = Math.sqrt(rx * rx + ry * ry) + 1e-20;
        rx /= r; ry /= r; // ∇r = [rx, ry]

        if (r < 1.0) {
          // ∇R = R'(r) ∇r
          const [R, dR] = this.repulsion_f(r, c_rep);
          this.add_xy(R_grad, i, rx, ry, dR);
          this.add_xy(R_grad, j, rx, ry, -dR);
          R_val[i] += R; R_val[j] += R;
        }

        // ∇K = K'(r) ∇r (attraction within species) - store in self-interaction arrays
        const [K, dK] = this.peak_f(r, mu_k, sigma_k, w_k);
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
    const { mu_g, sigma_g, dt } = species.params;
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

        // Apply species-specific response function
        const [G, dG] = this.peak_f(U_val_from_source[i], response_mu_g, response_sigma_g);
        total_vx += dG * U_grad_from_source[i * 2];
        total_vy += dG * U_grad_from_source[i * 2 + 1];
        total_G += G;
      }

      // [vx, vy] = -∇E = G'(U)∇U - ∇R
      const vx = total_vx - R_grad[i * 2];
      const vy = total_vy - R_grad[i * 2 + 1];
      this.add_xy(points, i, vx, vy, dt);
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
        .map(species => `${species.name}: ${species.pointCount}`)
        .join(', ');
      
      info.innerHTML = `
        <div>Frame: ${this.frameCount}</div>
        <div>Total Particles: ${totalParticles}</div>
        <div>${speciesInfo}</div>
      `;
    }
  }

  // Create random interaction parameters
  private createRandomInteractionParams(): InteractionParams {
    return {
      mu_k: 2.0 + (Math.random() - 0.5) * 14.0,
      sigma_k: 0.5 + (Math.random() - 0.5) * 6.0,
      w_k: 0.01 + (Math.random() - 0.5) * 0.16,
      c_rep: 0.5 + Math.random() * 2.0,
      mu_g: 0.3 + (Math.random() - 0.5) * 1.4,
      sigma_g: 0.05 + (Math.random() - 0.5) * 0.4
    };
  }

  // Update interaction parameters when a new species is added
  private updateInteractionParams(newSpeciesId: string): void {
    const allSpeciesIds = Array.from(this.species.keys());
    
    // Create interaction parameters for the new species
    const newSpeciesInteractions = new Map<string, InteractionParams>();
    
    for (const existingId of allSpeciesIds) {
      if (existingId !== newSpeciesId) {
        // Create unique interaction parameters for new species -> existing species
        newSpeciesInteractions.set(existingId, this.createRandomInteractionParams());
        
        // Create unique interaction parameters for existing species -> new species
        const existingInteractions = this.interactionParams.get(existingId);
        if (existingInteractions) {
          existingInteractions.set(newSpeciesId, this.createRandomInteractionParams());
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
    // Get current dt to ensure new species matches existing ones
    const currentDt = this.species.size > 0 ? this.getDt() : 0.05;
    
    const species = SpeciesFactory.createSpecies(pointCount, customParams);
    // Set dt to match current system dt
    species.params.dt = currentDt;
    
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
    
    // Get current dt to preserve it
    const currentDt = this.species.size > 0 ? this.getDt() : 0.05;
    
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
    
    // Restore the current dt value to all species
    this.setDt(currentDt);
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
  public getInteractionParams(speciesAId: string, speciesBId: string): InteractionParams | undefined {
    return this.interactionParams.get(speciesAId)?.get(speciesBId);
  }

  // Set interaction parameters between two species
  public setInteractionParams(speciesAId: string, speciesBId: string, params: InteractionParams): boolean {
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

  // Get all interaction parameters for debugging/inspection
  public getAllInteractionParams(): Map<string, Map<string, InteractionParams>> {
    return this.interactionParams;
  }

  // Update dt for all species
  public setDt(newDt: number): void {
    for (const species of this.species.values()) {
      species.params.dt = newDt;
    }
  }

  // Get current dt (from first species, assuming all have same dt)
  public getDt(): number {
    const firstSpecies = this.species.values().next().value;
    return firstSpecies ? firstSpecies.params.dt : 0.05;
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

  // Start animation
  animationLoop();

  // Initial info display
  particleSystem.reset(); // This will trigger updateInfo()
}

// Start when DOM is loaded
document.addEventListener('DOMContentLoaded', initialize);
