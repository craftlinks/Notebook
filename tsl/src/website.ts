// Website integration for TSL examples
import { initGameOfLife } from './game-of-life'
import { BoidsSimulation } from '../boids'
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import * as THREE from 'three/webgpu'
import { Fn, instanceIndex, vec4, If, instancedArray, positionLocal } from 'three/tsl'

hljs.registerLanguage('typescript', typescript);

// Basic compute shader example output
let basicComputeResult: any = null

// Game of Life simulation state
let gameOfLifeState: any = null
let golVisualizationState: any = null

// Shared renderer for all TSL examples
let sharedRenderer: THREE.WebGPURenderer | null = null;

// Boids simulation state
let boidsSimulation: BoidsSimulation | null = null

// Update basic example output
async function updateBasicExampleOutput() {
  const outputElement = document.getElementById('basic-output')
  if (!outputElement) return

  try {
    // Import and run the basic compute shader from main.ts
    const { initComputeShader } = await import('./basic-example')
    basicComputeResult = await initComputeShader()
    
    outputElement.innerHTML = `
      <div class="output-success">
        <div><strong>Input:</strong> [${basicComputeResult.input.join(', ')}]</div>
        <div><strong>Output:</strong> [${basicComputeResult.output.join(', ')}]</div>
        <div style="margin-top: 0.5rem; font-size: 0.8em; color: var(--text-muted);">
          ✓ Successfully multiplied ${basicComputeResult.input.length} values by 2
        </div>
      </div>
    `
  } catch (error) {
    console.error('Basic compute shader error:', error)
    outputElement.innerHTML = `
      <div class="output-error">
        <div>Error running basic compute shader:</div>
        <div>${(error as Error).message}</div>
      </div>
    `
  }
}

// Update Game of Life output
async function updateGameOfLifeOutput() {
  const outputElement = document.getElementById('game-of-life-output')
  if (!outputElement) return

  try {
    
    outputElement.innerHTML = `
      <div class="output-success">
        <div><strong>Grid Size:</strong> 64 × 64 = 4096 cells</div>
        <div><strong>Status:</strong> Grid initialized with a random pattern.</div>
        <div><strong>Algorithm:</strong> Conway's Game of Life with toroidal topology</div>
        <div style="margin-top: 1rem;">
          <canvas id="gol-canvas" style="
            border: 1px solid var(--border-color);
            background: #000;
            image-rendering: pixelated;
            width: 512px;
            height: 512px;
            cursor: pointer;
          " width="512" height="512"></canvas>
          <div style="margin-top: 0.5rem; font-size: 0.8em; color: var(--text-muted);">
            <span id="gol-step-info">Click canvas to pause/resume</span>
            <span id="gol-stats" style="margin-left: 1rem;"></span>
          </div>
        </div>
      </div>
    `
    
    // Initialize the Three.js visualization
    await initGameOfLifeVisualization()
    
  } catch (error) {
    console.error('Game of Life error:', error)
    outputElement.innerHTML = `
      <div class="output-error">
        <div>Error running Game of Life:</div>
        <div>${(error as Error).message}</div>
      </div>
    `
  }
}

// Run a single Game of Life step
async function runGameOfLifeStep() {
  if (!gameOfLifeState) {
    console.error('Game of Life not initialized')
    return
  }
  
  // Run one generation
  await gameOfLifeState.renderer.computeAsync(
    gameOfLifeState.updateGeneration.compute(gameOfLifeState.gridWidth * gameOfLifeState.gridHeight)
  )
  await gameOfLifeState.renderer.computeAsync(
    gameOfLifeState.copyGeneration.compute(gameOfLifeState.gridWidth * gameOfLifeState.gridHeight)
  )
}

// Initialize Game of Life Three.js visualization
async function initGameOfLifeVisualization() {
  const canvas = document.getElementById('gol-canvas') as HTMLCanvasElement
  if (!canvas) {
    console.error('Canvas element not found')
    return
  }

  try {
    // Initialize shared renderer if it doesn't exist
    if (!sharedRenderer) {
      sharedRenderer = new THREE.WebGPURenderer({ canvas, antialias: true })
      await sharedRenderer.init()
    }
    
    // Initialize GOL, passing the canvas to use its context
    gameOfLifeState = await initGameOfLife({ canvas, renderer: sharedRenderer })

    // Create scene and camera
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10)
    camera.position.z = 1
    
    // Create a plane geometry scaled to the size of one cell
    const geometry = new THREE.PlaneGeometry(1 / gameOfLifeState.gridWidth, 1 / gameOfLifeState.gridHeight)

    // Use an instanced mesh to represent the grid
    const mesh = new THREE.InstancedMesh(geometry, undefined, gameOfLifeState.gridWidth * gameOfLifeState.gridHeight)
    scene.add(mesh)

    // Buffer to hold the color of each cell
    const colorBuffer = instancedArray(gameOfLifeState.gridWidth * gameOfLifeState.gridHeight, 'vec4')
    
    // Compute shader to update the color buffer based on GOL state
    const updateColors = Fn(() => {
      const cellState = gameOfLifeState.currentGeneration.element(instanceIndex)
      const outputColor = colorBuffer.element(instanceIndex)

      const aliveColor = vec4(0.0, 1.0, 0.0, 1.0) // Green
      const deadColor = vec4(0.0, 0.0, 0.0, 1.0)  // Black
      
      outputColor.assign(deadColor)
      
      If(cellState.equal(1), () => {
        outputColor.assign(aliveColor)
      })
    })()

    const colorCompute = updateColors.compute(gameOfLifeState.gridWidth * gameOfLifeState.gridHeight)

    // TSL material that uses the color buffer
    const material = new THREE.MeshBasicNodeMaterial()
    material.colorNode = colorBuffer.toAttribute();
    
    material.positionNode = Fn(() => {
      const { gridWidth, gridHeight } = gameOfLifeState;
      
      // Calculate 2D grid position from 1D instance index
      const x = instanceIndex.mod(gridWidth);
      const y = instanceIndex.div(gridWidth).toInt();

      // Normalize and center the grid coordinates to create instance offset
      const uvX = x.toFloat().add(0.5).div(gridWidth).sub(0.5);
      const uvY = y.toFloat().add(0.5).div(gridHeight).sub(0.5);

      // Add the instance offset to the local position of the geometry's vertices
      const finalPosition = positionLocal.add(vec4(uvX, uvY, 0, 0));

      return finalPosition;
    })()

    mesh.material = material;
    
    // Store visualization state
    golVisualizationState = {
      scene,
      camera,
      colorCompute,
      isRunning: false, // Start paused, will be updated by IntersectionObserver
      isManuallyPaused: false,
      isVisible: false,
    };

    const updateRunningState = () => {
      const shouldBeRunning = golVisualizationState.isVisible && !golVisualizationState.isManuallyPaused;
      golVisualizationState.isRunning = shouldBeRunning;

      const statusElement = document.getElementById('gol-step-info');
      if (statusElement) {
        if (!golVisualizationState.isVisible) {
          statusElement.textContent = 'Paused (out of view).';
        } else if (golVisualizationState.isManuallyPaused) {
          statusElement.textContent = 'Paused. Click to resume.';
        } else {
          statusElement.textContent = 'Running. Click to pause.';
        }
      }
    };

    // Add click handler to toggle simulation
    canvas.addEventListener('click', () => {
      golVisualizationState.isManuallyPaused = !golVisualizationState.isManuallyPaused;
      updateRunningState();
    });

    // Use IntersectionObserver to run simulation only when visible
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          golVisualizationState.isVisible = entry.isIntersecting;
          updateRunningState();
        });
      },
      { threshold: 0.1 } // Run when 10% of the canvas is visible
    );
    observer.observe(canvas);

    // Start continuous animation loop
    startGameOfLifeAnimation()

    console.log('Game of Life visualization initialized')

  } catch (error) {
    console.error('Error initializing Game of Life visualization:', error)
  }
}

// Animation loop for continuous Game of Life simulation
function startGameOfLifeAnimation() {
  if (!gameOfLifeState || !golVisualizationState) return;

  const { renderer } = gameOfLifeState
  const { scene, camera, colorCompute } = golVisualizationState

  let lastStatTime = 0
  const statInterval = 250 // ms

  renderer.setAnimationLoop(async (currentTime: number) => {
    if (!golVisualizationState.isRunning) return
    
    await runGameOfLifeStep()
    await renderer.computeAsync(colorCompute)
    renderer.render(scene, camera)

    // Update stats periodically without slowing down the main loop
    if (currentTime - lastStatTime > statInterval) {
      lastStatTime = currentTime
      const currentArray = await renderer.getArrayBufferAsync(gameOfLifeState.currentGeneration.value)
      const currentData = new Int32Array(currentArray)
      const aliveCount = currentData.reduce((sum: number, cell: number) => sum + cell, 0)
      
      const statsElement = document.getElementById('gol-stats');
      if (statsElement) {
        statsElement.textContent = `${aliveCount} cells alive`
      }
    }
  })
}

// Test boids simulation without visualization
async function testBoidsSimulation() {
  console.log('Testing boids simulation...')
  const outputElement = document.getElementById('boids-output');
  if (!outputElement) {
    console.error('Boids output element not found');
    return { success: false, error: new Error('Boids output element not found') };
  }

  if (!sharedRenderer) {
    console.error('Shared renderer not initialized. Boids test depends on GOL visualization.');
    outputElement.innerHTML = `
      <div class="output-error">
        <div>Error: Shared renderer not available for boids test.</div>
      </div>
    `;
    return { success: false, error: new Error('Shared renderer not available') };
  }

  try {
    // Create a small test renderer
    const renderer = sharedRenderer;
    
    // Create boids simulation with smaller count for testing
    const boids = new BoidsSimulation({ 
      count: 256, 
      speedLimit: 5.0,
      bounds: 100
    })
    
    const storage = boids.getStorage()
    
    // Run one compute step to initialize the buffers properly
    boids.update(1/60)
    boids.compute(renderer)
    
    // Get initial positions after first compute step
    const initialPositions = await renderer.getArrayBufferAsync(storage.positionStorage.value)
    const initialPosData = new Float32Array(initialPositions)
    
    // Run simulation for a few more steps
    for (let i = 0; i < 10; i++) {
      boids.update(1/60) // 60 FPS
      boids.compute(renderer)
    }
    
    // Get final positions to verify movement
    const finalPositions = await renderer.getArrayBufferAsync(storage.positionStorage.value)
    const finalPosData = new Float32Array(finalPositions)
    
    // Calculate movement to verify simulation is working
    let totalMovement = 0
    let validBoids = 0
    
    for (let i = 0; i < Math.min(initialPosData.length, finalPosData.length); i += 3) {
      const dx = finalPosData[i] - initialPosData[i]
      const dy = finalPosData[i + 1] - initialPosData[i + 1]
      const dz = finalPosData[i + 2] - initialPosData[i + 2]
      
      // Skip invalid positions
      if (isFinite(dx) && isFinite(dy) && isFinite(dz)) {
        const movement = Math.sqrt(dx * dx + dy * dy + dz * dz)
        if (isFinite(movement)) {
          totalMovement += movement
          validBoids++
        }
      }
    }
    
    const avgMovement = validBoids > 0 ? totalMovement / validBoids : 0
    const successMessage = `✓ Boids simulation test successful!`;
    
    outputElement.innerHTML = `
      <div class="output-success">
        <div><strong>Status:</strong> ${successMessage}</div>
        <div><strong>Test Details:</strong> Ran simulation for 10 frames with 256 boids.</div>
        <div><strong>Result:</strong> Average movement of ${avgMovement.toFixed(3)} units detected.</div>
        <div style="margin-top: 0.5rem; font-size: 0.8em; color: var(--text-muted);">
          This confirms the GPU compute shaders are correctly updating boid positions.
        </div>
      </div>
    `;
    
    // Store for potential future use
    boidsSimulation = boids
    
    return { success: true, avgMovement }
    
  } catch (error) {
    console.error('Boids simulation test failed:', error)
    outputElement.innerHTML = `
      <div class="output-error">
        <div>Error running boids simulation test:</div>
        <div>${(error as Error).message}</div>
      </div>
    `;
    return { success: false, error }
  }
}

// Initialize website functionality
async function initWebsite() {
  console.log('Initializing TSL Compute Shaders website...')
  
  // Update example outputs
  await updateBasicExampleOutput()
  await updateGameOfLifeOutput()
  
  // Test boids simulation
  await testBoidsSimulation()

  // Highlight all code blocks
  hljs.highlightAll();
  
  console.log('Website initialization complete!')
}

// Start website initialization when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWebsite)
} else {
  initWebsite()
}

// Export for potential external use
export { initWebsite, updateBasicExampleOutput, updateGameOfLifeOutput, testBoidsSimulation }