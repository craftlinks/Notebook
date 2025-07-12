// @ts-nocheck
import { GPUSwarmalators, type SwarmalatorParams, type SpeciesParams } from './gpu_swarmalators';

let swarmalators: GPUSwarmalators | null = null;
let currentSwarmalatorId: string | null = null;

// Configuration interface for save/load
interface SwarmalatorConfig {
  globalParams: SwarmalatorParams;
  speciesParams: SpeciesParams;
  particleCount: number;
  timestamp: number;
  version: string;
}

// Save/Load utility functions
function saveConfigurationToPNG(): void {
  if (!swarmalators) {
    console.error('No swarmalators instance available');
    return;
  }

  try {
    // Get current configuration
    const config: SwarmalatorConfig = {
      globalParams: swarmalators.getParams(),
      speciesParams: swarmalators.getSpeciesParams(),
      particleCount: parseInt((document.getElementById('count-value') as HTMLInputElement).value),
      timestamp: Date.now(),
      version: '1.0'
    };

    // Get canvas from renderer
    const canvas = (swarmalators as any).renderer?.domElement;
    if (!canvas) {
      console.error('Canvas not available');
      return;
    }

    // Convert config to JSON and then to base64
    const configJSON = JSON.stringify(config);
    const configBase64 = btoa(configJSON);

    // For WebGPU, we need to ensure we capture the current frame
    // Force a render and then capture immediately
    const captureCanvas = async () => {
      try {
        // Force a render to ensure the canvas has current content
        if (swarmalators) {
          const renderer = (swarmalators as any).renderer;
          const scene = (swarmalators as any).scene;
          const camera = (swarmalators as any).camera;
          
          // Force a render
          renderer.render(scene, camera);
          
          // Wait for the render to complete
          await new Promise(resolve => requestAnimationFrame(resolve));
        }

        // Try multiple methods to capture the canvas
        let blob: Blob | null = null;
        
        // Method 1: Use convertToBlob if available (WebGPU)
        if (typeof (canvas as any).convertToBlob === 'function') {
          try {
            blob = await (canvas as any).convertToBlob({ type: 'image/png' });
          } catch (e) {
            console.warn('convertToBlob failed:', e);
          }
        }
        
        // Method 2: Use toBlob (fallback)
        if (!blob) {
          blob = await new Promise<Blob | null>((resolve) => {
            canvas.toBlob((blob: Blob | null) => resolve(blob), 'image/png');
          });
        }

        // Method 3: Use toDataURL and convert to blob (last resort)
        if (!blob) {
          try {
            const dataURL = canvas.toDataURL('image/png');
            const response = await fetch(dataURL);
            blob = await response.blob();
          } catch (e) {
            console.warn('toDataURL method failed:', e);
          }
        }

        if (!blob) {
          console.error('All canvas capture methods failed');
          updateStatus('Failed to capture canvas content', 'error');
          return;
        }

        // Create a new PNG with metadata
        const reader = new FileReader();
        reader.onload = (e) => {
          const arrayBuffer = e.target?.result as ArrayBuffer;
          const uint8Array = new Uint8Array(arrayBuffer);
          
          // Add PNG metadata chunk with our configuration
          const modifiedPNG = addPNGMetadata(uint8Array, 'swarmalators_config', configBase64);
          
          // Create download link
          const modifiedBlob = new Blob([modifiedPNG], { type: 'image/png' });
          const url = URL.createObjectURL(modifiedBlob);
          
          const link = document.createElement('a');
          link.href = url;
          link.download = `swarmalators_config_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
          link.click();
          
          URL.revokeObjectURL(url);
          updateStatus('Configuration saved to PNG', 'ready');
        };
        reader.readAsArrayBuffer(blob);
      } catch (error) {
        console.error('Error capturing canvas:', error);
        updateStatus('Error capturing canvas', 'error');
      }
    };

    // Call the async capture function
    captureCanvas();
    
  } catch (error) {
    console.error('Error saving configuration:', error);
    updateStatus('Error saving configuration', 'error');
  }
}

function loadConfigurationFromPNG(file: File): void {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const arrayBuffer = e.target?.result as ArrayBuffer;
      const uint8Array = new Uint8Array(arrayBuffer);
      
      // Extract metadata from PNG
      const configBase64 = extractPNGMetadata(uint8Array, 'swarmalators_config');
      
      if (!configBase64) {
        updateStatus('No configuration found in PNG file', 'error');
        return;
      }

      // Decode configuration
      const configJSON = atob(configBase64);
      const config: SwarmalatorConfig = JSON.parse(configJSON);
      
      // Apply configuration
      applyConfiguration(config);
      
      updateStatus('Configuration loaded successfully', 'ready');
    } catch (error) {
      console.error('Error loading configuration:', error);
      updateStatus('Error loading configuration', 'error');
    }
  };
  reader.readAsArrayBuffer(file);
}

function addPNGMetadata(pngData: Uint8Array, keyword: string, text: string): Uint8Array {
  // Find the end of the PNG header (after IHDR chunk)
  let insertPosition = 8; // Skip PNG signature
  
  // Find IHDR chunk and skip it
  while (insertPosition < pngData.length) {
    const chunkLength = (pngData[insertPosition] << 24) | (pngData[insertPosition + 1] << 16) | 
                      (pngData[insertPosition + 2] << 8) | pngData[insertPosition + 3];
    const chunkType = String.fromCharCode(...pngData.slice(insertPosition + 4, insertPosition + 8));
    
    insertPosition += 8 + chunkLength + 4; // Skip length + type + data + CRC
    
    if (chunkType === 'IHDR') {
      break;
    }
  }
  
  // Create tEXt chunk
  const keywordBytes = new TextEncoder().encode(keyword);
  const textBytes = new TextEncoder().encode(text);
  const chunkData = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  chunkData.set(keywordBytes, 0);
  chunkData[keywordBytes.length] = 0; // null separator
  chunkData.set(textBytes, keywordBytes.length + 1);
  
  // Calculate CRC32
  const crc = calculateCRC32(new Uint8Array([...new TextEncoder().encode('tEXt'), ...chunkData]));
  
  // Create the chunk
  const chunk = new Uint8Array(12 + chunkData.length);
  const chunkLength = chunkData.length;
  
  // Length (4 bytes, big endian)
  chunk[0] = (chunkLength >> 24) & 0xFF;
  chunk[1] = (chunkLength >> 16) & 0xFF;
  chunk[2] = (chunkLength >> 8) & 0xFF;
  chunk[3] = chunkLength & 0xFF;
  
  // Type (4 bytes)
  chunk.set(new TextEncoder().encode('tEXt'), 4);
  
  // Data
  chunk.set(chunkData, 8);
  
  // CRC (4 bytes, big endian)
  chunk[8 + chunkLength] = (crc >> 24) & 0xFF;
  chunk[8 + chunkLength + 1] = (crc >> 16) & 0xFF;
  chunk[8 + chunkLength + 2] = (crc >> 8) & 0xFF;
  chunk[8 + chunkLength + 3] = crc & 0xFF;
  
  // Insert the chunk into the PNG data
  const result = new Uint8Array(pngData.length + chunk.length);
  result.set(pngData.slice(0, insertPosition), 0);
  result.set(chunk, insertPosition);
  result.set(pngData.slice(insertPosition), insertPosition + chunk.length);
  
  return result;
}

function extractPNGMetadata(pngData: Uint8Array, keyword: string): string | null {
  let position = 8; // Skip PNG signature
  
  while (position < pngData.length) {
    const chunkLength = (pngData[position] << 24) | (pngData[position + 1] << 16) | 
                      (pngData[position + 2] << 8) | pngData[position + 3];
    const chunkType = String.fromCharCode(...pngData.slice(position + 4, position + 8));
    
    if (chunkType === 'tEXt') {
      const chunkData = pngData.slice(position + 8, position + 8 + chunkLength);
      const nullIndex = chunkData.indexOf(0);
      
      if (nullIndex !== -1) {
        const chunkKeyword = new TextDecoder().decode(chunkData.slice(0, nullIndex));
        if (chunkKeyword === keyword) {
          return new TextDecoder().decode(chunkData.slice(nullIndex + 1));
        }
      }
    }
    
    position += 8 + chunkLength + 4; // Skip length + type + data + CRC
    
    if (chunkType === 'IEND') {
      break;
    }
  }
  
  return null;
}

function calculateCRC32(data: Uint8Array): number {
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
  }
  
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function applyConfiguration(config: SwarmalatorConfig): void {
  if (!swarmalators) {
    console.error('No swarmalators instance available');
    return;
  }

  try {
    // Update global parameters
    swarmalators.updateParams(config.globalParams);
    
    // Update species parameters
    swarmalators.updateSpeciesParams(config.speciesParams);
    
    // Update UI controls
    updateUIFromConfig(config);
    
    // Recreate swarmalators with new configuration
    createSwarmalators(config.particleCount);
    
    console.log('Configuration applied successfully:', config);
  } catch (error) {
    console.error('Error applying configuration:', error);
    updateStatus('Error applying configuration', 'error');
  }
}

function updateUIFromConfig(config: SwarmalatorConfig): void {
  // Update global parameter controls
  const globalParams = config.globalParams;
  Object.entries(globalParams).forEach(([param, value]) => {
    const slider = document.getElementById(`${param}-slider`) as HTMLInputElement;
    const valueInput = document.getElementById(`${param}-value`) as HTMLInputElement;
    
    if (slider && valueInput) {
      slider.value = value.toString();
      valueInput.value = value.toString();
    }
  });
  
  // Update particle count
  const countSlider = document.getElementById('count-slider') as HTMLInputElement;
  const countValue = document.getElementById('count-value') as HTMLInputElement;
  if (countSlider && countValue) {
    countSlider.value = config.particleCount.toString();
    countValue.value = config.particleCount.toString();
  }
  
  // Update species count selector
  const speciesCountSelect = document.getElementById('species-count') as HTMLSelectElement;
  if (speciesCountSelect) {
    speciesCountSelect.value = config.speciesParams.numSpecies.toString();
  }
  
  // Update matrix controls
  updateMatrixControls();
}

function handleFileLoad(file: File): void {
  // Check if file is PNG
  if (!file.type.includes('image/png')) {
    updateStatus('Please select a PNG file', 'error');
    return;
  }
  
  // Check file size (reasonable limit)
  if (file.size > 50 * 1024 * 1024) { // 50MB limit
    updateStatus('File too large (max 50MB)', 'error');
    return;
  }
  
  updateStatus('Loading configuration...', 'loading');
  loadConfigurationFromPNG(file);
}

// Pattern presets based on the mathematical model
const patternPresets: Record<string, Partial<SwarmalatorParams>> = {
  'rainbow-ring': {
    J: 2.5,
    K: 0.0,
    omega: 0.0,
    alpha: 0.0,
    dt: 0.005
  },
  'dancing-circus': {
    J: 0.5,
    K: -1.5,
    omega: 0.0,
    alpha: 0.5,
    dt: 0.01
  },
  'uniform-blob': {
    J: 0.5,
    K: 3.0,
    omega: 0.0,
    alpha: 0.1,
    dt: 0.01
  },
  'solar-convection': {
    J: 0.8,
    K: 2.5,
    omega: 1.2,
    alpha: 0.8,
    dt: 0.02
  },
  'makes-me-dizzy': {
    J: 3.0,
    K: 0.5,
    omega: 0.0,
    alpha: 1.2,
    dt: 0.005
  },
  'fractured': {
    J: 2.0,
    K: -2.0,
    omega: 0.0,
    alpha: -0.7,
    dt: 0.01
  }
};

// Species presets showing different inter-species interactions
const speciesPresets: Record<string, Partial<SpeciesParams>> = {
  'predator-prey': {
    numSpecies: 2,
    JMatrix: [
      [2.0, 1.5],  // Species 0 (red) - strong attraction to species 1
      [3.0, 2.5]   // Species 1 (green) - very strong attraction to species 0
    ],
    KMatrix: [
      [1.5, -0.5],  // Species 0 - desync with species 1
      [-1.0, 2.0]   // Species 1 - strong internal sync, desync with species 0
    ],
    speciesColors: ['#ff4444', '#44ff44'],
    speciesDistribution: [0.3, 0.7]
  },
  'symmetric-species': {
    numSpecies: 2,
    JMatrix: [
      [2.5, 1.5],  // Stronger symmetric coupling
      [1.5, 2.5]
    ],
    KMatrix: [
      [2.0, 0.8],  // Stronger symmetric phase coupling
      [0.8, 2.0]
    ],
    speciesColors: ['#ff4444', '#44ff44'],
    speciesDistribution: [0.5, 0.5]
  },
  'segregated-species': {
    numSpecies: 2,
    JMatrix: [
      [3.0, -2.0],  // Species 0 strongly repels species 1
      [-2.0, 3.0]   // Species 1 strongly repels species 0
    ],
    KMatrix: [
      [2.5, -1.5],   // Strong desync between species
      [-1.5, 2.5]
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
  const parameterIds = ['J', 'K', 'omega', 'alpha', 'dt'];
  
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
  
  // Save configuration button
  const saveButton = document.getElementById('save-config-button');
  if (saveButton) {
    saveButton.addEventListener('click', () => {
      saveConfigurationToPNG();
    });
  }
  
  // Load configuration drag and drop
  const dropZone = document.getElementById('load-drop-zone');
  const fileInput = document.getElementById('load-file-input') as HTMLInputElement;
  
  if (dropZone && fileInput) {
    // Click to select file
    dropZone.addEventListener('click', () => {
      fileInput.click();
    });
    
    // Handle file selection
    fileInput.addEventListener('change', (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        handleFileLoad(files[0]);
      }
    });
    
    // Drag and drop handlers
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
    
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        handleFileLoad(files[0]);
      }
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
    // Capture existing species parameters before change
    const prevParams = swarmalators.getSpeciesParams();
    const prevNum = prevParams.numSpecies;
    const prevJ = prevParams.JMatrix;
    const prevK = prevParams.KMatrix;

    // Apply the new species count inside the engine
    swarmalators.setNumSpecies(numSpecies);

    // Build new J/K matrices preserving previous values where possible and
    // randomising any newly-introduced interactions.
    const JMatrix: number[][] = [];
    const KMatrix: number[][] = [];

    for (let i = 0; i < numSpecies; i++) {
      JMatrix[i] = [];
      KMatrix[i] = [];
      for (let j = 0; j < numSpecies; j++) {
        if (i < prevNum && j < prevNum) {
          // Preserve existing interactions
          JMatrix[i][j] = prevJ[i][j];
          KMatrix[i][j] = prevK[i][j];
        } else {
          // Randomise new interactions (including diagonal if i===j)
          if (i === j) {
            JMatrix[i][j] = Math.random() * 4.0 + 0.5;  // [0.5, 4.5]
            KMatrix[i][j] = Math.random() * 3.0 + 0.5;  // [0.5, 3.5]
          } else {
            JMatrix[i][j] = (Math.random() - 0.5) * 6.0; // [-3, 3]
            KMatrix[i][j] = (Math.random() - 0.5) * 4.0; // [-2, 2]
          }
        }
      }
    }

    // Update species parameters with new matrices
    swarmalators.updateSpeciesParams({ JMatrix, KMatrix });

    // Refresh UI controls to reflect the new matrices
    updateMatrixControls();

    // Recreate swarmalators with current particle count
    const count = parseInt((document.getElementById('count-value') as HTMLInputElement).value);
    createSwarmalators(count);

    updateStatus(`Changed to ${numSpecies} species (matrices updated)`, 'ready');
    console.log(`Changed to ${numSpecies} species`, { JMatrix, KMatrix });
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
        slider.min = '-5';
        slider.max = '5';
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
        slider.min = '-5';
        slider.max = '5';
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
        JMatrix[i][j] = Math.random() * 4.0 + 0.5;  // Range: [0.5, 4.5]
        KMatrix[i][j] = Math.random() * 3.0 + 0.5;  // Range: [0.5, 3.5]
      } else {
        // Off-diagonal elements (cross-species) - can be negative, more extreme
        JMatrix[i][j] = (Math.random() - 0.5) * 6.0;  // Range: [-3.0, 3.0]
        KMatrix[i][j] = (Math.random() - 0.5) * 4.0;  // Range: [-2.0, 2.0]
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
    
    // Reset camera position for consistent view
    swarmalators.resetCameraPosition();
    
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
    swarmalators.resetCameraPosition();
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
    await createSwarmalators(3500);
    
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