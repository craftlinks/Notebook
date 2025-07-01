import { GPUParticleLenia, KernelType } from './main_gpu'

// Simple helper to generate random Params matching the interface in main_gpu.ts
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

function createRandomParams(): Params {
  const kernelTypes = Object.values(KernelType);

  const kernelKSelect = document.getElementById('kernel-k-select') as HTMLSelectElement;
  const kernelGSelect = document.getElementById('kernel-g-select') as HTMLSelectElement;

  const selectedKernelK = kernelKSelect ? kernelKSelect.value as KernelType : kernelTypes[Math.floor(Math.random() * kernelTypes.length)];
  const selectedKernelG = kernelGSelect ? kernelGSelect.value as KernelType : kernelTypes[Math.floor(Math.random() * kernelTypes.length)];

  return {
    mu_k: 1.5 + Math.random() * 8.0,
    sigma_k: 0.2 + Math.random() * 3.0,
    w_k: 0.005 + Math.random() * 0.12,
    mu_g: 0.1 + Math.random() * 0.8,
    sigma_g: 0.025 + Math.random() * 0.35,
    c_rep: 0.3 + Math.random() * 2.4,
    kernel_k_type: selectedKernelK,
    kernel_g_type: selectedKernelG
  }
}

type Nullable<T> = T | null

let gpuSim: Nullable<GPUParticleLenia> = null

// Helper function to embed JSON data into PNG metadata
function embedDataInPNG(imageBlob: Blob, jsonData: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arrayBuffer = reader.result as ArrayBuffer;
        const uint8Array = new Uint8Array(arrayBuffer);
        
        // Find the IEND chunk (last 12 bytes of a PNG)
        const iendIndex = uint8Array.length - 12;
        
        // Create the text chunk with simulation data
        const textData = new TextEncoder().encode(jsonData);
        const keyword = new TextEncoder().encode('ParticleLeniaData');
        const separator = new Uint8Array([0]); // null separator
        
        // Calculate chunk length (keyword + separator + data)
        const chunkDataLength = keyword.length + separator.length + textData.length;
        const chunkData = new Uint8Array(chunkDataLength);
        
        // Assemble chunk data: keyword + null + text data
        let offset = 0;
        chunkData.set(keyword, offset);
        offset += keyword.length;
        chunkData.set(separator, offset);
        offset += separator.length;
        chunkData.set(textData, offset);
        
        // Create tEXt chunk
        const chunkLength = new Uint32Array([chunkDataLength]);
        const chunkType = new TextEncoder().encode('tEXt');
        
        // Calculate CRC32 for chunk type + chunk data
        const crcData = new Uint8Array(chunkType.length + chunkData.length);
        crcData.set(chunkType);
        crcData.set(chunkData, chunkType.length);
        const crc = calculateCRC32(crcData);
        
        // Create the complete chunk
        const chunkHeader = new Uint8Array(4);
        new DataView(chunkHeader.buffer).setUint32(0, chunkDataLength, false); // big-endian
        
        const crcBytes = new Uint8Array(4);
        new DataView(crcBytes.buffer).setUint32(0, crc, false); // big-endian
        
        // Assemble the new PNG: original PNG (without IEND) + tEXt chunk + IEND
        const newPngSize = iendIndex + 4 + 4 + chunkDataLength + 4 + 12; // original + chunk header + type + data + crc + IEND
        const newPng = new Uint8Array(newPngSize);
        
        // Copy original PNG up to IEND
        newPng.set(uint8Array.subarray(0, iendIndex));
        
        // Add tEXt chunk
        let newOffset = iendIndex;
        newPng.set(chunkHeader, newOffset);
        newOffset += 4;
        newPng.set(chunkType, newOffset);
        newOffset += 4;
        newPng.set(chunkData, newOffset);
        newOffset += chunkDataLength;
        newPng.set(crcBytes, newOffset);
        newOffset += 4;
        
        // Add IEND chunk
        newPng.set(uint8Array.subarray(iendIndex), newOffset);
        
        resolve(new Blob([newPng], { type: 'image/png' }));
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read image blob'));
    reader.readAsArrayBuffer(imageBlob);
  });
}

// Simple CRC32 implementation for PNG chunks
function calculateCRC32(data: Uint8Array): number {
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      if (c & 1) {
        c = 0xEDB88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    crcTable[i] = c;
  }
  
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Helper function to extract JSON data from PNG metadata
function extractDataFromPNG(file: File): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const arrayBuffer = reader.result as ArrayBuffer;
        const uint8Array = new Uint8Array(arrayBuffer);
        
        // Check PNG signature
        const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
        for (let i = 0; i < 8; i++) {
          if (uint8Array[i] !== pngSignature[i]) {
            resolve(null); // Not a PNG file
            return;
          }
        }
        
        // Search for tEXt chunks
        let offset = 8; // Skip PNG signature
        const decoder = new TextDecoder();
        
        while (offset < uint8Array.length - 12) {
          // Read chunk length (4 bytes, big-endian)
          const chunkLength = new DataView(arrayBuffer, offset, 4).getUint32(0, false);
          offset += 4;
          
          // Read chunk type (4 bytes)
          const chunkType = decoder.decode(uint8Array.subarray(offset, offset + 4));
          offset += 4;
          
          if (chunkType === 'tEXt') {
            // Read chunk data
            const chunkData = uint8Array.subarray(offset, offset + chunkLength);
            const textContent = decoder.decode(chunkData);
            
            // Split keyword and text data (separated by null byte)
            const nullIndex = textContent.indexOf('\0');
            if (nullIndex !== -1) {
              const keyword = textContent.substring(0, nullIndex);
              const textData = textContent.substring(nullIndex + 1);
              
              if (keyword === 'ParticleLeniaData') {
                resolve(textData);
                return;
              }
            }
          }
          
          // Skip chunk data and CRC
          offset += chunkLength + 4;
          
          // Stop at IEND chunk
          if (chunkType === 'IEND') {
            break;
          }
        }
        
        resolve(null); // No simulation data found
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(new Error('Failed to read PNG file'));
    reader.readAsArrayBuffer(file);
  });
}

// Helper function to capture screenshot with embedded simulation data
function captureScreenshotWithData(filename: string, simulationData: string, width?: number, height?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!gpuSim || !gpuSim['renderer']) {
      reject(new Error('GPU simulation not initialized'));
      return;
    }

    const renderer = gpuSim['renderer'] as any; // THREE.WebGPURenderer
    const camera = gpuSim['camera'] as any; // THREE.PerspectiveCamera
    const scene = gpuSim['scene'] as any; // THREE.Scene
    const canvas = renderer.domElement;
    
    // Store original dimensions
    const originalWidth = canvas.width;
    const originalHeight = canvas.height;
    const originalAspect = camera.aspect;
    
    // Set desired screenshot dimensions (default to current canvas size or high-res)
    const screenshotWidth = width || Math.max(canvas.width, 1920);
    const screenshotHeight = height || Math.max(canvas.height, 1080);
    
    try {
      // Update camera aspect ratio for new dimensions
      camera.aspect = screenshotWidth / screenshotHeight;
      camera.updateProjectionMatrix();
      
      // Set renderer to new size
      renderer.setSize(screenshotWidth, screenshotHeight);
      
      // Force a render frame at new resolution
      renderer.render(scene, camera);
      
      // Capture the image
      canvas.toBlob(async (blob: Blob | null) => {
        if (blob) {
          try {
            // Embed simulation data in PNG metadata
            const pngWithData = await embedDataInPNG(blob, simulationData);
            
            // Create download link for the enhanced screenshot
            const url = URL.createObjectURL(pngWithData);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            console.log(`📸 Screenshot with embedded data saved: ${filename} (${screenshotWidth}x${screenshotHeight})`);
            resolve();
          } catch (error) {
            reject(new Error(`Failed to embed data in PNG: ${error}`));
          }
        } else {
          reject(new Error('Failed to create screenshot blob'));
        }
      }, 'image/png');
      
    } catch (error) {
      reject(error);
    } finally {
      // Restore original dimensions
      camera.aspect = originalAspect;
      camera.updateProjectionMatrix();
      renderer.setSize(originalWidth, originalHeight);
    }
  });
}

// Helper function to load simulation from embedded PNG data
async function loadSimulationFromImage(file: File): Promise<boolean> {
  try {
    const jsonData = await extractDataFromPNG(file);
    if (!jsonData) {
      console.log('No simulation data found in image');
      return false;
    }

    const simulationData = JSON.parse(jsonData);
    
    if (gpuSim) {
      const success = await gpuSim.importSimulation(jsonData);
      if (success) {
        console.log('🖼️ Simulation loaded successfully from image metadata');
        
        // Restore kernel selections if present
        if (simulationData.kernelSelections) {
          const kernelKSelect = document.getElementById('kernel-k-select') as HTMLSelectElement;
          const kernelGSelect = document.getElementById('kernel-g-select') as HTMLSelectElement;
          
          if (kernelKSelect && simulationData.kernelSelections.kernel_k) {
            kernelKSelect.value = simulationData.kernelSelections.kernel_k;
          }
          if (kernelGSelect && simulationData.kernelSelections.kernel_g) {
            kernelGSelect.value = simulationData.kernelSelections.kernel_g;
          }
          
          console.log('Kernel selections restored from image:', simulationData.kernelSelections);
        }
        
        // Update species slider and display
        const currentSpeciesCount = gpuSim.getSpeciesCount();
        const speciesSlider = document.getElementById('species-slider') as HTMLInputElement | null;
        const speciesCountDisplay = document.getElementById('species-count');
        
        if (speciesSlider && speciesCountDisplay) {
          speciesSlider.value = currentSpeciesCount.toString();
          speciesCountDisplay.textContent = currentSpeciesCount.toString();
        }
        
        updateInfo();
        return true;
      }
    }
    
    return false;
  } catch (error) {
    console.error('Error loading simulation from image:', error);
    return false;
  }
}

// Helper function to restore UI state from simulation data
function restoreUIFromSimulationData(simulationData: any) {
  // Try to load kernel selections from the loaded data
  try {
    if (simulationData.kernelSelections) {
      const kernelKSelect = document.getElementById('kernel-k-select') as HTMLSelectElement;
      const kernelGSelect = document.getElementById('kernel-g-select') as HTMLSelectElement;
      
      if (kernelKSelect && simulationData.kernelSelections.kernel_k) {
        kernelKSelect.value = simulationData.kernelSelections.kernel_k;
      }
      if (kernelGSelect && simulationData.kernelSelections.kernel_g) {
        kernelGSelect.value = simulationData.kernelSelections.kernel_g;
      }
      
      console.log('Kernel selections restored:', simulationData.kernelSelections);
    }
  } catch (error) {
    console.warn('Could not restore kernel selections:', error);
  }
  
  // Update species slider and display to match loaded simulation
  const currentSpeciesCount = gpuSim?.getSpeciesCount() || 1;
  const speciesSlider = document.getElementById('species-slider') as HTMLInputElement | null;
  const speciesCountDisplay = document.getElementById('species-count');
  
  if (speciesSlider && speciesCountDisplay) {
    speciesSlider.value = currentSpeciesCount.toString();
    speciesCountDisplay.textContent = currentSpeciesCount.toString();
  }
  
  updateInfo();
}

async function createSimulation(speciesCount: number) {
  // Clean up existing simulation if any
  if (gpuSim) {
    gpuSim.stopAnimation()
    gpuSim = null
  }

  gpuSim = new GPUParticleLenia()
  // wait for WebGPU initialization inside the class
  await new Promise((resolve) => {
    const checkRenderer = () => {
      if (gpuSim!['renderer']) {
        resolve(true)
      } else {
        setTimeout(checkRenderer, 100)
      }
    }
    checkRenderer()
  })

  // Create requested species
  for (let i = 0; i < speciesCount; i++) {
    const params = createRandomParams()
    const pointCount = speciesCount === 1 ? 25_000 : 7_000
    gpuSim.createSpecies(pointCount, params)
  }

  // ------------------------------------------------------------------
  // Sync the simulation's dt with the slider's current value right away
  // This avoids one extra frame at the default dt that may be too large
  // for high-density particle runs.
  // ------------------------------------------------------------------
  const dtSlider = document.getElementById('dt-slider') as HTMLInputElement | null
  if (dtSlider) {
    const currentDt = parseFloat(dtSlider.value)
    if (!Number.isNaN(currentDt)) {
      gpuSim.setDt(currentDt)
      const dtValueDisplay = document.getElementById('dt-value')
      if (dtValueDisplay) dtValueDisplay.textContent = currentDt.toFixed(3)
    }
  }

  // initialise positions for each species
  for (const species of gpuSim['species'].values()) {
    const initCompute = gpuSim.createInitPositionsCompute(species as any)
    await gpuSim['renderer']!.computeAsync(initCompute)
  }

  // Always (re)attach canvas so OrbitControls get re-created
  const wrapper = document.getElementById('gpu-canvas-wrapper')
  if (wrapper) {
    // Clear previous contents
    wrapper.innerHTML = ''
    gpuSim.attachToDom(wrapper)
  }

  gpuSim.startAnimation()
  updateInfo()
}

function updateInfo() {
  const infoDiv = document.getElementById('info')
  if (!infoDiv || !gpuSim) return
  const totalParticles = Array.from(gpuSim['species'].values()).reduce(
    (sum: number, s: any) => sum + s.pointCount,
    0
  )
  infoDiv.innerHTML = `Total Particles: ${totalParticles} | Species: ${gpuSim['species'].size}`
}

function setupDragAndDrop() {
  const canvasWrapper = document.getElementById('gpu-canvas-wrapper')
  if (!canvasWrapper) return

  let dragCounter = 0

  const addDragOverlay = () => {
    let overlay = document.getElementById('drag-overlay')
    if (!overlay) {
      overlay = document.createElement('div')
      overlay.id = 'drag-overlay'
      overlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0, 123, 255, 0.1);
        border: 3px dashed #007bff;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        color: #007bff;
        font-weight: bold;
        pointer-events: none;
        z-index: 1000;
      `
      overlay.textContent = 'Drop simulation file (.json) or image (.png) here'
      canvasWrapper.style.position = 'relative'
      canvasWrapper.appendChild(overlay)
    }
    overlay.style.display = 'flex'
  }

  const removeDragOverlay = () => {
    const overlay = document.getElementById('drag-overlay')
    if (overlay) {
      overlay.style.display = 'none'
    }
  }

  canvasWrapper.addEventListener('dragenter', (e) => {
    e.preventDefault()
    dragCounter++
    addDragOverlay()
  })

  canvasWrapper.addEventListener('dragleave', (e) => {
    e.preventDefault()
    dragCounter--
    if (dragCounter === 0) {
      removeDragOverlay()
    }
  })

  canvasWrapper.addEventListener('dragover', (e) => {
    e.preventDefault()
  })

  canvasWrapper.addEventListener('drop', async (e) => {
    e.preventDefault()
    dragCounter = 0
    removeDragOverlay()

    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      const file = files[0]
      const fileName = file.name.toLowerCase();
      
      // Check if it's a PNG file with embedded data or JSON file
      if (fileName.endsWith('.png')) {
        const success = await loadSimulationFromImage(file);
        if (!success) {
          alert('This PNG file does not contain simulation data. Please drop a PNG file saved from this application or a JSON simulation file.');
        }
      } else if (fileName.endsWith('.json')) {
        // Handle JSON files for backwards compatibility
        if (gpuSim) {
          const success = await gpuSim.loadSimulationFile(file)
          if (success) {
            console.log('📁 Simulation loaded successfully via drag and drop (JSON)')
            
            // Try to load kernel selections from the dropped file
            try {
              const fileText = await file.text();
              const simulationData = JSON.parse(fileText);
              restoreUIFromSimulationData(simulationData);
            } catch (error) {
              console.warn('Could not restore UI state from dropped file:', error);
            }
          } else {
            alert('Failed to load simulation file')
          }
        }
      } else {
        alert('Please drop a PNG file with embedded simulation data or a JSON simulation file')
      }
    }
  })
}

function setupUI() {
  const speciesSlider = document.getElementById('species-slider') as HTMLInputElement | null
  const speciesCountDisplay = document.getElementById('species-count')
  const dtSlider = document.getElementById('dt-slider') as HTMLInputElement | null
  const dtValueDisplay = document.getElementById('dt-value')
  const resetBtn = document.getElementById('reset') as HTMLButtonElement | null
  const saveBtn = document.getElementById('save-button') as HTMLButtonElement | null
  const loadBtn = document.getElementById('load-button') as HTMLButtonElement | null
  const loadInput = document.getElementById('load-input') as HTMLInputElement | null

  if (speciesSlider && speciesCountDisplay) {
    speciesSlider.addEventListener('input', async () => {
      const count = parseInt(speciesSlider.value)
      speciesCountDisplay.textContent = count.toString()
      await createSimulation(count)
    })
  }

  if (dtSlider && dtValueDisplay) {
    // Update display and dt value when slider changes
    dtSlider.addEventListener('input', () => {
      const dtValue = parseFloat(dtSlider.value)
      dtValueDisplay.textContent = dtValue.toFixed(3)
      if (gpuSim) {
        gpuSim.setDt(dtValue)
        console.log(`Set GPU dt to ${dtValue}`)
      }
    })
  }

  if (resetBtn && speciesSlider) {
    resetBtn.addEventListener('click', async () => {
      const count = parseInt(speciesSlider.value)
      await createSimulation(count)
    })
  }

  // Save simulation as PNG with embedded data
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (gpuSim) {
        // Store original button text and disable button during save
        const originalText = saveBtn.textContent;
        saveBtn.textContent = 'Saving...';
        saveBtn.disabled = true;
        
        const timestamp = Date.now();
        const baseName = `gpu-particle-lenia-${timestamp}`;
        
        try {
          // Before saving, update the kernel selections in the simulation data
          const kernelKSelect = document.getElementById('kernel-k-select') as HTMLSelectElement;
          const kernelGSelect = document.getElementById('kernel-g-select') as HTMLSelectElement;
          
          // Save current kernel selections as metadata
          const simulationData = JSON.parse(gpuSim.exportSimulation());
          simulationData.kernelSelections = {
            kernel_k: kernelKSelect ? kernelKSelect.value : 'gaussian',
            kernel_g: kernelGSelect ? kernelGSelect.value : 'gaussian'
          };
          
          const jsonString = JSON.stringify(simulationData, null, 2);
          
          // Update button status
          saveBtn.textContent = 'Creating Screenshot...';
          
          // Save screenshot with embedded simulation data
          await captureScreenshotWithData(`${baseName}.png`, jsonString);
          
          console.log('✅ Save complete: screenshot with embedded simulation data');
          
          // Show success briefly
          saveBtn.textContent = '✅ Saved!';
          setTimeout(() => {
            saveBtn.textContent = originalText;
            saveBtn.disabled = false;
          }, 2000);
          
        } catch (error) {
          console.error('❌ Error during save operation:', error);
          alert('Failed to save simulation screenshot. Check console for details.');
          
          // Restore button state on error
          saveBtn.textContent = originalText;
          saveBtn.disabled = false;
        }
      }
    })
  }

  if (loadBtn && loadInput) {
    // Update file input to accept both PNG and JSON for backwards compatibility
    loadInput.accept = '.json,.png';
    
    loadBtn.addEventListener('click', () => loadInput.click())
    loadInput.addEventListener('change', async (event) => {
      const files = (event.target as HTMLInputElement).files
      if (files && files.length > 0 && gpuSim) {
        const file = files[0];
        const fileName = file.name.toLowerCase();
        
        let success = false;
        
        if (fileName.endsWith('.png')) {
          success = await loadSimulationFromImage(file);
          if (success) {
            console.log('🖼️ GPU simulation loaded successfully from PNG');
          }
        } else if (fileName.endsWith('.json')) {
          success = await gpuSim.loadSimulationFile(file);
          if (success) {
            console.log('📁 GPU simulation loaded successfully from JSON');
            
            // Try to load kernel selections from the file for backwards compatibility
            try {
              const fileText = await file.text();
              const simulationData = JSON.parse(fileText);
              restoreUIFromSimulationData(simulationData);
            } catch (error) {
              console.warn('Could not restore UI state from JSON file:', error);
            }
          }
        }
        
        if (!success) {
          alert('Failed to load simulation file')
        }
        
        // Clear the input so the same file can be loaded again
        loadInput.value = ''
      }
    })
  }

  const kernelKSelect = document.getElementById('kernel-k-select') as HTMLSelectElement | null;
  const kernelGSelect = document.getElementById('kernel-g-select') as HTMLSelectElement | null;

  const handleKernelChange = async () => {
    if (speciesSlider) {
      const count = parseInt(speciesSlider.value);
      await createSimulation(count);
    }
  };

  if (kernelKSelect) {
    kernelKSelect.addEventListener('change', handleKernelChange);
  }
  if (kernelGSelect) {
    kernelGSelect.addEventListener('change', handleKernelChange);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  setupUI()
  setupDragAndDrop()
  await createSimulation(1)
}) 