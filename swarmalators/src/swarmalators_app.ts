import { GPUSwarmalators, type SwarmalatorParams, type SpeciesParams } from './gpu_swarmalators';

let swarmalators: GPUSwarmalators | null = null;
let currentSwarmalatorId: string | null = null;

// Pattern presets based on the mathematical model
const patternPresets: Record<string, Partial<SwarmalatorParams>> = {
  'rainbow-ring': {
    J: 1.0,
    K: 0.0,
    omega: 0.0,
    dt: 0.05
  },
  'dancing-circus': {
    J: 0.1,
    K: -0.1,
    omega: 0.0,
    dt: 0.05
  },
  'uniform-blob': {
    J: 0.1,
    K: 1.0,
    omega: 0.0,
    dt: 0.05
  },
  'solar-convection': {
    J: 0.1,
    K: 1.0,
    omega: 0.5,
    dt: 0.05
  },
  'makes-me-dizzy': {
    J: 1.0,
    K: 0.1,
    omega: 0.0,
    dt: 0.05
  },
  'fractured': {
    J: 1.0,
    K: -0.1,
    omega: 0.0,
    dt: 0.05
  }
};

// Species presets showing different inter-species interactions
const speciesPresets: Record<string, Partial<SpeciesParams>> = {
  'predator-prey': {
    numSpecies: 2,
    JMatrix: [
      [1.0, 0.3],  // Species 0 (red) - moderate attraction to species 1
      [0.8, 1.0]   // Species 1 (green) - strong attraction to species 0
    ],
    KMatrix: [
      [0.5, 0.1],  // Species 0 - weak sync with species 1
      [0.2, 0.8]   // Species 1 - strong internal sync
    ],
    speciesColors: ['#ff4444', '#44ff44'],
    speciesDistribution: [0.3, 0.7]
  },
  'symmetric-species': {
    numSpecies: 2,
    JMatrix: [
      [1.0, 0.5],  // Symmetric coupling
      [0.5, 1.0]
    ],
    KMatrix: [
      [0.8, 0.2],  // Symmetric phase coupling
      [0.2, 0.8]
    ],
    speciesColors: ['#ff4444', '#44ff44'],
    speciesDistribution: [0.5, 0.5]
  },
  'segregated-species': {
    numSpecies: 2,
    JMatrix: [
      [1.5, -0.5],  // Species 0 repels species 1
      [-0.5, 1.5]   // Species 1 repels species 0
    ],
    KMatrix: [
      [0.9, 0.0],   // No phase coupling between species
      [0.0, 0.9]
    ],
    speciesColors: ['#ff4444', '#44ff44'],
    speciesDistribution: [0.5, 0.5]
  },
  'three-species-chain': {
    numSpecies: 3,
    JMatrix: [
      [1.0, 0.8, 0.2],  // Species 0 - strong coupling to species 1
      [0.3, 1.0, 0.8],  // Species 1 - coupling chain
      [0.2, 0.3, 1.0]   // Species 2 - weak coupling to species 0
    ],
    KMatrix: [
      [0.8, 0.4, 0.1],  // Phase coupling chain
      [0.1, 0.8, 0.4],
      [0.4, 0.1, 0.8]
    ],
    speciesColors: ['#ff4444', '#44ff44', '#4444ff'],
    speciesDistribution: [0.33, 0.33, 0.34]
  },
  'four-species-ecosystem': {
    numSpecies: 4,
    JMatrix: [
      [1.0, 0.6, 0.3, 0.1],  // Species 0 - decreasing coupling strength
      [0.2, 1.0, 0.6, 0.3],  // Species 1 - rotated pattern
      [0.3, 0.2, 1.0, 0.6],  // Species 2 - rotated pattern
      [0.6, 0.3, 0.2, 1.0]   // Species 3 - rotated pattern
    ],
    KMatrix: [
      [0.9, 0.3, 0.1, 0.05], // Phase coupling with hierarchy
      [0.05, 0.9, 0.3, 0.1],
      [0.1, 0.05, 0.9, 0.3],
      [0.3, 0.1, 0.05, 0.9]
    ],
    speciesColors: ['#ff4444', '#44ff44', '#4444ff', '#ffff44'],
    speciesDistribution: [0.25, 0.25, 0.25, 0.25]
  },
  'five-species-complex': {
    numSpecies: 5,
    JMatrix: [
      [1.2, 0.5, 0.3, 0.2, 0.1],  // Species 0 - complex interactions
      [0.4, 1.2, 0.5, 0.3, 0.2],  // Species 1 - ring-like coupling
      [0.3, 0.4, 1.2, 0.5, 0.3],  // Species 2 - ring-like coupling
      [0.2, 0.3, 0.4, 1.2, 0.5],  // Species 3 - ring-like coupling
      [0.5, 0.2, 0.3, 0.4, 1.2]   // Species 4 - ring-like coupling
    ],
    KMatrix: [
      [0.8, 0.2, 0.1, 0.05, 0.3], // Complex phase relationships
      [0.3, 0.8, 0.2, 0.1, 0.05],
      [0.05, 0.3, 0.8, 0.2, 0.1],
      [0.1, 0.05, 0.3, 0.8, 0.2],
      [0.2, 0.1, 0.05, 0.3, 0.8]
    ],
    speciesColors: ['#ff4444', '#44ff44', '#4444ff', '#ffff44', '#ff44ff'],
    speciesDistribution: [0.2, 0.2, 0.2, 0.2, 0.2]
  }
};

function updateStatus(message: string, type: 'loading' | 'ready' | 'error') {
  const statusDiv = document.getElementById('status');
  if (statusDiv) {
    statusDiv.textContent = message;
    statusDiv.className = `status ${type}`;
  }
}

function setupUI() {
  // Parameter sliders
  const parameterIds = ['J', 'K', 'omega', 'dt'];
  
  parameterIds.forEach(param => {
    const slider = document.getElementById(`${param}-slider`) as HTMLInputElement;
    const valueInput = document.getElementById(`${param}-value`) as HTMLInputElement;
    
    if (slider && valueInput) {
      // Sync slider and number input
      slider.addEventListener('input', () => {
        valueInput.value = slider.value;
        updateParameter(param, parseFloat(slider.value));
      });
      
      valueInput.addEventListener('input', () => {
        slider.value = valueInput.value;
        updateParameter(param, parseFloat(valueInput.value));
      });
    }
  });
  
  // Particle count
  const countSlider = document.getElementById('count-slider') as HTMLInputElement;
  const countValue = document.getElementById('count-value') as HTMLInputElement;
  
  if (countSlider && countValue) {
    countSlider.addEventListener('input', () => {
      countValue.value = countSlider.value;
    });
    
    countValue.addEventListener('input', () => {
      countSlider.value = countValue.value;
    });
  }
  
  // Control buttons
  const startButton = document.getElementById('start-button');
  const stopButton = document.getElementById('stop-button');
  const resetButton = document.getElementById('reset-button');
  const recreateButton = document.getElementById('recreate-button');
  
  if (startButton) {
    startButton.addEventListener('click', () => {
      if (swarmalators) {
        swarmalators.startAnimation();
        updateStatus('Animation running', 'ready');
      }
    });
  }
  
  if (stopButton) {
    stopButton.addEventListener('click', () => {
      if (swarmalators) {
        swarmalators.stopAnimation();
        updateStatus('Animation stopped', 'ready');
      }
    });
  }
  
  if (resetButton) {
    resetButton.addEventListener('click', async () => {
      if (swarmalators) {
        await resetSwarmalators();
      }
    });
  }
  
  if (recreateButton) {
    recreateButton.addEventListener('click', async () => {
      const count = parseInt(countValue.value);
      await createSwarmalators(count);
    });
  }
  
  // Pattern buttons
  const patternButtons = document.querySelectorAll('.pattern-button');
  patternButtons.forEach(button => {
    button.addEventListener('click', () => {
      const pattern = button.getAttribute('data-pattern');
      if (pattern && patternPresets[pattern]) {
        applyPattern(pattern);
      }
    });
  });
  
  // Species count selector
  const speciesCountSelect = document.getElementById('species-count') as HTMLSelectElement;
  if (speciesCountSelect) {
    speciesCountSelect.addEventListener('change', () => {
      const numSpecies = parseInt(speciesCountSelect.value);
      changeNumSpecies(numSpecies);
    });
  }
  
  // Species preset buttons
  const speciesButtons = document.querySelectorAll('.species-button');
  speciesButtons.forEach(button => {
    button.addEventListener('click', () => {
      const species = button.getAttribute('data-species');
      if (species && speciesPresets[species]) {
        applySpeciesPreset(species);
      }
    });
  });
  
  // Matrix controls
  setupMatrixControls();
  
  // Randomize matrices button
  const randomizeButton = document.getElementById('randomize-matrices');
  if (randomizeButton) {
    randomizeButton.addEventListener('click', () => {
      randomizeMatrices();
    });
  }
}

function updateParameter(param: string, value: number) {
  if (!swarmalators) return;
  
  const update: Partial<SwarmalatorParams> = {};
  (update as any)[param] = value;
  
  swarmalators.updateParams(update);
  
  console.log(`Updated ${param} to ${value}`);
}

function applyPattern(patternName: string) {
  const preset = patternPresets[patternName];
  if (!preset || !swarmalators) return;
  
  // Update UI controls
  Object.entries(preset).forEach(([param, value]) => {
    const slider = document.getElementById(`${param}-slider`) as HTMLInputElement;
    const valueInput = document.getElementById(`${param}-value`) as HTMLInputElement;
    
    if (slider && valueInput) {
      slider.value = value.toString();
      valueInput.value = value.toString();
    }
  });
  
  // Apply to swarmalators
  swarmalators.updateParams(preset);
  
  updateStatus(`Applied pattern: ${patternName}`, 'ready');
  console.log(`Applied pattern: ${patternName}`, preset);
}

function applySpeciesPreset(presetName: string) {
  const preset = speciesPresets[presetName];
  if (!preset || !swarmalators) return;
  
  // Apply species preset
  swarmalators.updateSpeciesParams(preset);
  
  // Update species count selector if preset changes number of species
  if (preset.numSpecies !== undefined) {
    const speciesCountSelect = document.getElementById('species-count') as HTMLSelectElement;
    if (speciesCountSelect) {
      speciesCountSelect.value = preset.numSpecies.toString();
    }
  }
  
  // Update matrix controls to reflect new values
  updateMatrixControls();
  
  // Recreate swarmalators to apply new species settings
  const count = parseInt((document.getElementById('count-value') as HTMLInputElement).value);
  createSwarmalators(count);
  
  updateStatus(`Applied species preset: ${presetName}`, 'ready');
  console.log(`Applied species preset: ${presetName}`, preset);
}

function changeNumSpecies(numSpecies: number) {
  if (!swarmalators) return;
  
  try {
    // Use the new setNumSpecies method
    swarmalators.setNumSpecies(numSpecies);
    
    // Update matrix controls to reflect new species count
    updateMatrixControls();
    
    // Recreate swarmalators to apply new species count
    const count = parseInt((document.getElementById('count-value') as HTMLInputElement).value);
    createSwarmalators(count);
    
    updateStatus(`Changed to ${numSpecies} species`, 'ready');
    console.log(`Changed to ${numSpecies} species`);
  } catch (error) {
    console.error('Error changing species count:', error);
    updateStatus('Error changing species count', 'error');
  }
}

function generateMatrixControls() {
  if (!swarmalators) return;
  
  const speciesParams = swarmalators.getSpeciesParams();
  const numSpecies = speciesParams.numSpecies;
  const JMatrix = speciesParams.JMatrix;
  const KMatrix = speciesParams.KMatrix;
  
  const speciesColors = ['Red', 'Green', 'Blue', 'Yellow', 'Magenta'];
  const speciesNames = speciesColors.slice(0, numSpecies);
  
  // Generate J Matrix controls
  const jMatrixContainer = document.getElementById('j-matrix');
  if (jMatrixContainer) {
    jMatrixContainer.innerHTML = '';
    jMatrixContainer.className = `matrix-grid species-${numSpecies}`;
    
    for (let i = 0; i < numSpecies; i++) {
      for (let j = 0; j < numSpecies; j++) {
        const cellDiv = document.createElement('div');
        cellDiv.className = 'matrix-cell';
        
        const label = document.createElement('label');
        label.textContent = `J[${i},${j}] (${speciesNames[i]}→${speciesNames[j]}):`;
        
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = `j-${i}-${j}`;
        slider.min = '-2';
        slider.max = '2';
        slider.step = '0.1';
        slider.value = JMatrix[i][j].toString();
        
        const numberInput = document.createElement('input');
        numberInput.type = 'number';
        numberInput.id = `j-${i}-${j}-value`;
        numberInput.step = '0.1';
        numberInput.value = JMatrix[i][j].toString();
        
        // Add event listeners
        slider.addEventListener('input', () => {
          numberInput.value = slider.value;
          updateMatrixFromControls();
        });
        
        numberInput.addEventListener('input', () => {
          slider.value = numberInput.value;
          updateMatrixFromControls();
        });
        
        cellDiv.appendChild(label);
        cellDiv.appendChild(slider);
        cellDiv.appendChild(numberInput);
        jMatrixContainer.appendChild(cellDiv);
      }
    }
  }
  
  // Generate K Matrix controls
  const kMatrixContainer = document.getElementById('k-matrix');
  if (kMatrixContainer) {
    kMatrixContainer.innerHTML = '';
    kMatrixContainer.className = `matrix-grid species-${numSpecies}`;
    
    for (let i = 0; i < numSpecies; i++) {
      for (let j = 0; j < numSpecies; j++) {
        const cellDiv = document.createElement('div');
        cellDiv.className = 'matrix-cell';
        
        const label = document.createElement('label');
        label.textContent = `K[${i},${j}] (${speciesNames[i]}→${speciesNames[j]}):`;
        
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.id = `k-${i}-${j}`;
        slider.min = '-2';
        slider.max = '2';
        slider.step = '0.1';
        slider.value = KMatrix[i][j].toString();
        
        const numberInput = document.createElement('input');
        numberInput.type = 'number';
        numberInput.id = `k-${i}-${j}-value`;
        numberInput.step = '0.1';
        numberInput.value = KMatrix[i][j].toString();
        
        // Add event listeners
        slider.addEventListener('input', () => {
          numberInput.value = slider.value;
          updateMatrixFromControls();
        });
        
        numberInput.addEventListener('input', () => {
          slider.value = numberInput.value;
          updateMatrixFromControls();
        });
        
        cellDiv.appendChild(label);
        cellDiv.appendChild(slider);
        cellDiv.appendChild(numberInput);
        kMatrixContainer.appendChild(cellDiv);
      }
    }
  }
}

function setupMatrixControls() {
  // Generate initial matrix controls
  generateMatrixControls();
}

function updateMatrixFromControls() {
  if (!swarmalators) return;
  
  const speciesParams = swarmalators.getSpeciesParams();
  const numSpecies = speciesParams.numSpecies;
  
  // Get current values from controls dynamically
  const JMatrix: number[][] = [];
  const KMatrix: number[][] = [];
  
  for (let i = 0; i < numSpecies; i++) {
    JMatrix[i] = [];
    KMatrix[i] = [];
    for (let j = 0; j < numSpecies; j++) {
      const jInput = document.getElementById(`j-${i}-${j}-value`) as HTMLInputElement;
      const kInput = document.getElementById(`k-${i}-${j}-value`) as HTMLInputElement;
      
      if (jInput && kInput) {
        JMatrix[i][j] = parseFloat(jInput.value);
        KMatrix[i][j] = parseFloat(kInput.value);
      }
    }
  }
  
  // Update species parameters
  swarmalators.updateSpeciesParams({
    JMatrix,
    KMatrix
  });
  
  console.log('Updated matrices:', { JMatrix, KMatrix });
}

function updateMatrixControls() {
  if (!swarmalators) return;
  
  // Regenerate the matrix controls with current values
  generateMatrixControls();
}

function randomizeMatrices() {
  if (!swarmalators) return;
  
  const currentSpecies = swarmalators.getSpeciesParams();
  const numSpecies = currentSpecies.numSpecies;
  
  // Generate random values for ALL interactions (both diagonal and off-diagonal)
  const JMatrix: number[][] = [];
  const KMatrix: number[][] = [];
  
  for (let i = 0; i < numSpecies; i++) {
    JMatrix[i] = [];
    KMatrix[i] = [];
    for (let j = 0; j < numSpecies; j++) {
      if (i === j) {
        // Diagonal elements (self-interaction) - stronger and more positive
        JMatrix[i][j] = Math.random() * 2.0 + 0.5;  // Range: [0.5, 2.5]
        KMatrix[i][j] = Math.random() * 1.2 + 0.3;  // Range: [0.3, 1.5]
      } else {
        // Off-diagonal elements (cross-species) - can be negative
        JMatrix[i][j] = (Math.random() - 0.5) * 2.0;  // Range: [-1.0, 1.0]
        KMatrix[i][j] = (Math.random() - 0.5) * 1.0;  // Range: [-0.5, 0.5]
      }
    }
  }
  
  // Update species parameters
  swarmalators.updateSpeciesParams({
    JMatrix,
    KMatrix
  });
  
  // Update UI controls
  updateMatrixControls();
  
  // Recreate swarmalators to apply changes
  const count = parseInt((document.getElementById('count-value') as HTMLInputElement).value);
  createSwarmalators(count);
  
  updateStatus(`Randomized all ${numSpecies} species interactions`, 'ready');
  console.log('Randomized matrices:', { JMatrix, KMatrix });
}

async function createSwarmalators(count: number) {
  if (!swarmalators) return;
  
  updateStatus('Creating swarmalators...', 'loading');
  
  try {
    // Stop current animation
    swarmalators.stopAnimation();
    
    // Clear existing swarmalators before creating new ones
    swarmalators.clearAllSwarmalators();
    
    // Create new swarmalators
    const params = getCurrentParams();
    currentSwarmalatorId = swarmalators.createSwarmalators(count, params);
    
    // Initialize positions and phases
    await swarmalators.initializeSwarmalators();
    
    // Start animation
    swarmalators.startAnimation();
    
    updateStatus(`Created ${count} swarmalators`, 'ready');
  } catch (error) {
    console.error('Error creating swarmalators:', error);
    updateStatus('Error creating swarmalators', 'error');
  }
}

async function resetSwarmalators() {
  if (!swarmalators) return;
  
  updateStatus('Resetting swarmalators...', 'loading');
  
  try {
    await swarmalators.initializeSwarmalators();
    updateStatus('Swarmalators reset', 'ready');
  } catch (error) {
    console.error('Error resetting swarmalators:', error);
    updateStatus('Error resetting swarmalators', 'error');
  }
}

function getCurrentParams(): Partial<SwarmalatorParams> {
  const J = parseFloat((document.getElementById('J-value') as HTMLInputElement).value);
  const K = parseFloat((document.getElementById('K-value') as HTMLInputElement).value);
  const omega = parseFloat((document.getElementById('omega-value') as HTMLInputElement).value);
  const dt = parseFloat((document.getElementById('dt-value') as HTMLInputElement).value);
  
  return { J, K, omega, dt };
}

async function initApplication() {
  updateStatus('Initializing WebGPU...', 'loading');
  
  try {
    // Create swarmalators instance with default species configuration
    const defaultSpecies = speciesPresets['symmetric-species'];
    swarmalators = new GPUSwarmalators(undefined, defaultSpecies);
    
    // Wait for WebGPU initialization
    await new Promise(resolve => {
      const checkRenderer = () => {
        if ((swarmalators as any).renderer) {
          resolve(true);
        } else {
          setTimeout(checkRenderer, 100);
        }
      };
      checkRenderer();
    });
    
    // Attach to DOM
    const container = document.getElementById('canvas-container');
    if (container) {
      swarmalators.attachToDom(container);
    }
    
    // Create initial swarmalators
    await createSwarmalators(1000);
    
    // Initialize matrix controls with current values
    generateMatrixControls();
    
    updateStatus('Ready! Adjust parameters to see different patterns', 'ready');
    
  } catch (error) {
    console.error('Failed to initialize application:', error);
    updateStatus('Failed to initialize WebGPU. Check browser compatibility.', 'error');
  }
}

// Initialize application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  setupUI();
  initApplication();
});

// Export for debugging
if (typeof window !== 'undefined') {
  (window as any).swarmalators = swarmalators;
  (window as any).patternPresets = patternPresets;
  (window as any).speciesPresets = speciesPresets;
}