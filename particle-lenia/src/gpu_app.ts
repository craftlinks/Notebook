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
      overlay.textContent = 'Drop simulation file here'
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
      
      // Check if it's a JSON file
      if (!file.name.toLowerCase().endsWith('.json')) {
        alert('Please drop a JSON simulation file')
        return
      }

      if (gpuSim) {
        const success = await gpuSim.loadSimulationFile(file)
        if (success) {
          console.log('Simulation loaded successfully via drag and drop')
          
          // Try to load kernel selections from the dropped file
          try {
            const fileText = await file.text();
            const simulationData = JSON.parse(fileText);
            
            if (simulationData.kernelSelections) {
              const kernelKSelect = document.getElementById('kernel-k-select') as HTMLSelectElement;
              const kernelGSelect = document.getElementById('kernel-g-select') as HTMLSelectElement;
              
              if (kernelKSelect && simulationData.kernelSelections.kernel_k) {
                kernelKSelect.value = simulationData.kernelSelections.kernel_k;
              }
              if (kernelGSelect && simulationData.kernelSelections.kernel_g) {
                kernelGSelect.value = simulationData.kernelSelections.kernel_g;
              }
              
              console.log('Kernel selections restored from drag-and-drop:', simulationData.kernelSelections);
            }
          } catch (error) {
            console.warn('Could not restore kernel selections from dropped file:', error);
          }
          
          // Update species slider and display to match loaded simulation
          const currentSpeciesCount = gpuSim.getSpeciesCount()
          const speciesSlider = document.getElementById('species-slider') as HTMLInputElement | null
          const speciesCountDisplay = document.getElementById('species-count')
          
          if (speciesSlider && speciesCountDisplay) {
            speciesSlider.value = currentSpeciesCount.toString()
            speciesCountDisplay.textContent = currentSpeciesCount.toString()
          }
          
          updateInfo()
        } else {
          alert('Failed to load simulation file')
        }
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

  // Stub save / load functionality – console log for now
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      if (gpuSim) {
        // Before saving, update the kernel selections in the simulation data
        const kernelKSelect = document.getElementById('kernel-k-select') as HTMLSelectElement;
        const kernelGSelect = document.getElementById('kernel-g-select') as HTMLSelectElement;
        
        // Save current kernel selections as metadata
        const simulationData = JSON.parse(gpuSim.exportSimulation());
        simulationData.kernelSelections = {
          kernel_k: kernelKSelect ? kernelKSelect.value : 'gaussian',
          kernel_g: kernelGSelect ? kernelGSelect.value : 'gaussian'
        };
        
        // Save the enhanced simulation data
        const blob = new Blob([JSON.stringify(simulationData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = url;
        a.download = `gpu-particle-lenia-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log('GPU simulation saved with kernel selections');
      }
    })
  }

  if (loadBtn && loadInput) {
    loadBtn.addEventListener('click', () => loadInput.click())
    loadInput.addEventListener('change', async (event) => {
      const files = (event.target as HTMLInputElement).files
      if (files && files.length > 0 && gpuSim) {
        const success = await gpuSim.loadSimulationFile(files[0])
        if (success) {
          console.log('GPU simulation loaded successfully')
          
          // Try to load kernel selections from the file
          try {
            const fileText = await files[0].text();
            const simulationData = JSON.parse(fileText);
            
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
            console.warn('Could not restore kernel selections from file:', error);
          }
          
          // Update species slider and display to match loaded simulation
          const currentSpeciesCount = gpuSim.getSpeciesCount()
          const speciesSlider = document.getElementById('species-slider') as HTMLInputElement | null
          const speciesCountDisplay = document.getElementById('species-count')
          
          if (speciesSlider && speciesCountDisplay) {
            speciesSlider.value = currentSpeciesCount.toString()
            speciesCountDisplay.textContent = currentSpeciesCount.toString()
          }
          
          updateInfo()
        } else {
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