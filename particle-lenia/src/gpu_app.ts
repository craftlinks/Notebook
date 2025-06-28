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
  return {
    mu_k: 1.5 + Math.random() * 8.0,
    sigma_k: 0.2 + Math.random() * 3.0,
    w_k: 0.005 + Math.random() * 0.12,
    mu_g: 0.1 + Math.random() * 0.8,
    sigma_g: 0.025 + Math.random() * 0.35,
    c_rep: 0.3 + Math.random() * 2.4,
    kernel_k_type: kernelTypes[Math.floor(Math.random() * kernelTypes.length)],
    kernel_g_type: kernelTypes[Math.floor(Math.random() * kernelTypes.length)]
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
      if (gpuSim['renderer']) {
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
    const pointCount = speciesCount === 1 ? 25_000 : 10_000
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
        gpuSim.saveSimulation()
        console.log('GPU simulation saved')
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
          
          // Update species slider and display to match loaded simulation
          const currentSpeciesCount = gpuSim.getSpeciesCount()
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
}

document.addEventListener('DOMContentLoaded', async () => {
  setupUI()
  await createSimulation(1)
}) 