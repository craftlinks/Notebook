import { GPUSwarmalators, type SwarmalatorParams } from './gpu_swarmalators';

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
    // Create swarmalators instance
    swarmalators = new GPUSwarmalators();
    
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
}