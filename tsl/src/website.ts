// Website integration for TSL examples
import { initGameOfLife } from './game-of-life'
import { initLangtonAnt } from './langton-ant'
import { BoidsSimulation, type InterSpeciesRule } from './boids'
import { BoidsVisualization } from './boids-visualization'
import hljs from 'highlight.js/lib/core';
import typescript from 'highlight.js/lib/languages/typescript';
import * as THREE from 'three/webgpu'
import { Fn, instanceIndex, vec4, If, instancedArray, positionLocal, atomicLoad } from 'three/tsl'

hljs.registerLanguage('typescript', typescript);

// Basic compute shader example output
let basicComputeResult: any = null

// Game of Life simulation state
let gameOfLifeState: any = null
let golVisualizationState: any = null

// Langton's Ant simulation state
let langtonAntState: any = null

// Shared renderer for all TSL examples
let sharedRenderer: THREE.WebGPURenderer | null = null;

// Boids simulation state

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

// Update Langton's Ant output
async function updateLangtonAntOutput() {
  const outputElement = document.getElementById('langton-ant-output')
  if (!outputElement) return

  try {
    outputElement.innerHTML = `
      <div class="output-success">
        <div><strong>Grid Size:</strong> 200 × 200 = 40,000 cells</div>
        <div><strong>Status:</strong> Ant initialized at center facing north.</div>
        <div><strong>Rules:</strong> White→Turn Right+Black, Black→Turn Left+White</div>
        <div style="margin-top: 1rem;">
          <canvas id="langton-canvas" style="
            border: 1px solid var(--border-color);
            background: #000;
            image-rendering: pixelated;
            width: 512px;
            height: 512px;
            cursor: pointer;
          " width="512" height="512"></canvas>
        </div>
      </div>
    `
    
    // Initialize the Langton's Ant visualization
    await initLangtonAntVisualization()
    
  } catch (error) {
    console.error('Langton\'s Ant error:', error)
    outputElement.innerHTML = `
      <div class="output-error">
        <div>Error running Langton's Ant:</div>
        <div>${(error as Error).message}</div>
      </div>
    `
  }
}

// Initialize Langton's Ant visualization
async function initLangtonAntVisualization() {
  try {
    const canvas = document.getElementById('langton-canvas') as HTMLCanvasElement
    if (!canvas) {
      console.error('Canvas element not found')
      return
    }

    // Create a dedicated renderer for Langton's Ant
    const langtonRenderer = new THREE.WebGPURenderer({ canvas, antialias: true })
    await langtonRenderer.init()
    
    // Set canvas size and clear color
    langtonRenderer.setSize(canvas.width, canvas.height)
    langtonRenderer.setClearColor(0x000000, 1.0) // Black background

    // Initialize Langton's Ant simulation only
    langtonAntState = await initLangtonAnt({ 
      canvas, 
      renderer: langtonRenderer 
    })

    // Create scene and camera for visualization
    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 10)
    camera.position.z = 1
    
    // Create a plane geometry scaled to the size of one cell
    const cellSize = 1 / langtonAntState.gridWidth
    const geometry = new THREE.PlaneGeometry(cellSize, cellSize)

    // Use an instanced mesh to represent the grid
    const mesh = new THREE.InstancedMesh(geometry, undefined, langtonAntState.gridWidth * langtonAntState.gridHeight)
    scene.add(mesh)

    // Buffer to hold the color of each cell
    const colorBuffer = instancedArray(langtonAntState.gridWidth * langtonAntState.gridHeight, 'vec4')
    
    // Dynamic color computation that handles RGB channels and both ant modes
    const updateColors = Fn(() => {
      const cellR = langtonAntState.gridR.element(instanceIndex)
      const cellG = langtonAntState.gridG.element(instanceIndex)
      const cellB = langtonAntState.gridB.element(instanceIndex)
      const outputColor = colorBuffer.element(instanceIndex)
      
      // Convert 1D index to 2D coordinates
      const x = instanceIndex.mod(langtonAntState.gridWidth)
      const y = instanceIndex.div(langtonAntState.gridWidth).toInt()
      
      // Multi-ant data
      const hasAntIndex = instanceIndex.mul(3)
      const antColorIndex = instanceIndex.mul(3).add(2)
      const hasAnt = langtonAntState.multiAntGrid.element(hasAntIndex)
      const antColorChannel = langtonAntState.multiAntGrid.element(antColorIndex)
      
      // Single ant position
      const antX = langtonAntState.antState.element(0)
      const antY = langtonAntState.antState.element(1)
      
      // Check for ants first (both single and multi modes will be rendered)
      If(atomicLoad(hasAnt).toInt().equal(1), () => {
        // Multi-ant mode - show ant with bright color based on its channel
        If(atomicLoad(antColorChannel).toInt().equal(0), () => {
          outputColor.assign(vec4(1.0, 0.5, 0.5, 1.0)) // Bright red ant
                  }).ElseIf(atomicLoad(antColorChannel).toInt().equal(1), () => {
          outputColor.assign(vec4(0.5, 1.0, 0.5, 1.0)) // Bright green ant
        }).Else(() => {
          outputColor.assign(vec4(0.5, 0.5, 1.0, 1.0)) // Bright blue ant
        })
      }).ElseIf(x.equal(antX).and(y.equal(antY)), () => {
        outputColor.assign(vec4(1.0, 0.5, 0.5, 1.0)) // Single ant (red)
      }).Else(() => {
        // Calculate RGB color based on channel densities (0-100 maps to 0.0-1.0)
        const red = cellR.toFloat().div(100.0)
        const green = cellG.toFloat().div(100.0)
        const blue = cellB.toFloat().div(100.0)
        
        // Only show white background when ALL channels are exactly 0
        const totalColor = red.add(green).add(blue)
        If(totalColor.equal(0.0), () => {
          outputColor.assign(vec4(0.0, 0.0, 0.0, 1.0)) // Black background for faded cells
        }).Else(() => {
          outputColor.assign(vec4(red, green, blue, 1.0))
        })
      })
    })()

    const colorCompute = updateColors.compute(langtonAntState.gridWidth * langtonAntState.gridHeight)

    // TSL material that uses the color buffer
    const material = new THREE.MeshBasicNodeMaterial()
    material.colorNode = colorBuffer.toAttribute();
    
    material.positionNode = Fn(() => {
      const { gridWidth, gridHeight } = langtonAntState;
      
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

    mesh.material = material
    mesh.frustumCulled = false

    // Setup complete

    // Add visualization state to langtonAntState
    langtonAntState.scene = scene
    langtonAntState.camera = camera
    langtonAntState.mesh = mesh
    langtonAntState.colorCompute = colorCompute

    // Animation state
    let isRunning = false
    let stepCount = 0
    let isMultiAntMode = false
    
    // Run Langton's Ant step
    const runLangtonAntStep = async () => {
      if (!langtonAntState) return
      
      // First, fade the grid
      await langtonRenderer.computeAsync(langtonAntState.fadeGrid.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
      
      if (isMultiAntMode) {
        // Three-phase approach to avoid race conditions
        await langtonRenderer.computeAsync(langtonAntState.stepMultiAntsPhase1.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
        await langtonRenderer.computeAsync(langtonAntState.stepMultiAntsPhase2.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
        await langtonRenderer.computeAsync(langtonAntState.stepMultiAntsPhase3.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
      } else {
        await langtonRenderer.computeAsync(langtonAntState.stepAnt.compute(1))
      }
      stepCount++
    }

    // Set up control buttons
    const startBtn = document.getElementById('langton-start-btn')
    const stopBtn = document.getElementById('langton-stop-btn')
    const resetBtn = document.getElementById('langton-reset-btn')
    const fastBtn = document.getElementById('langton-fast-btn')
    const densityToggle = document.getElementById('langton-density-toggle') as HTMLInputElement
    const stepInfo = document.getElementById('langton-step-info')

    const updateStepDisplay = () => {
      if (stepInfo) {
        const mode = isMultiAntMode ? ' (Multi-Ant)' : ' (Single)'
        stepInfo.textContent = `Steps: ${stepCount}${mode}`
      }
    }

    // Toggle handler
    densityToggle?.addEventListener('change', () => {
      isMultiAntMode = densityToggle.checked
      updateStepDisplay()
    })

    startBtn?.addEventListener('click', () => {
      if (!isRunning) {
        isRunning = true
        startLangtonAntAnimation()
      }
    })

    stopBtn?.addEventListener('click', () => {
      isRunning = false
    })

    resetBtn?.addEventListener('click', async () => {
      stepCount = 0
      // Reset grid
      await langtonRenderer.computeAsync(langtonAntState.initializeGrid.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
      
      // Clear multi-ant grid first
      await langtonRenderer.computeAsync(langtonAntState.clearMultiAnts.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
      
      // Reset step counter for fading
      const resetCounter = Fn(() => {
        langtonAntState.stepCounter.element(0).assign(0)
      })()
      await langtonRenderer.computeAsync(resetCounter.compute(1))
      
      // Initialize based on mode
      if (isMultiAntMode) {
        await langtonRenderer.computeAsync(langtonAntState.initializeMultiAnts.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
      } else {
        await langtonRenderer.computeAsync(langtonAntState.initializeAnt.compute(1))
      }
      
      await langtonRenderer.computeAsync(colorCompute)
      langtonRenderer.render(scene, camera)
      updateStepDisplay()
    })

    fastBtn?.addEventListener('click', async () => {
      for (let i = 0; i < 1000; i++) {
        await runLangtonAntStep()
      }
      await langtonRenderer.computeAsync(colorCompute)
      langtonRenderer.render(scene, camera)
      updateStepDisplay()
    })

    // Animation loop function
    const startLangtonAntAnimation = () => {
      langtonRenderer.setAnimationLoop(async () => {
        if (!isRunning) return
        
        // First, fade the grid
        await langtonRenderer.computeAsync(langtonAntState.fadeGrid.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
        
        if (isMultiAntMode) {
          // Run three-phase multi-ant step
          await langtonRenderer.computeAsync(langtonAntState.stepMultiAntsPhase1.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
          await langtonRenderer.computeAsync(langtonAntState.stepMultiAntsPhase2.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
          await langtonRenderer.computeAsync(langtonAntState.stepMultiAntsPhase3.compute(langtonAntState.gridWidth * langtonAntState.gridHeight))
          stepCount += 1
        } else {
          // Run batched steps (10 steps done inside the shader)
          await langtonRenderer.computeAsync(langtonAntState.stepAnt.compute(1))
          stepCount += 10
        }
        
        // Only await the final color update and render
        await langtonRenderer.computeAsync(colorCompute)
        langtonRenderer.render(scene, camera)
        
        // Only update display every few frames to reduce DOM updates
        if (stepCount % 50 === 0) {
          updateStepDisplay()
        }
      })
    }

    // Initial render
    console.log('Rendering initial frame...')
    console.log('RGB grids available:', !!langtonAntState.gridR, !!langtonAntState.gridG, !!langtonAntState.gridB)
    
    await langtonRenderer.computeAsync(colorCompute)
    langtonRenderer.render(scene, camera)
    updateStepDisplay()

    console.log('Langton\'s Ant visualization initialized')

  } catch (error) {
    console.error('Error initializing Langton\'s Ant visualization:', error)
  }
}

async function runBasicExample() {
  await updateBasicExampleOutput();
}

async function runGameOfLife() {
  await updateGameOfLifeOutput();
}

async function runLangtonAnt() {
  await updateLangtonAntOutput();
}

async function runBoidsSimulation() {
  const container = document.getElementById('boids-container');
  if (!container) {
    console.error('Boids container not found');
    return;
  }

  let currentBoidCount = 4096;
  let cleanup = () => {};

  const startNewSimulation = async (numSpecies: number, count: number) => {
    // Clean up previous simulation instance
    cleanup();
    container.innerHTML = '';

    // Basic setup
    const renderer = new THREE.WebGPURenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);

    await renderer.init();

    // --- Generate dynamic configs for species ---
    const speciesConfigs: any[] = [];
    const baseColors: THREE.Color[] = [
      new THREE.Color(0x00ff00), new THREE.Color(0xff0000), new THREE.Color(0x0000ff),
      new THREE.Color(0xffff00), new THREE.Color(0x00ffff), new THREE.Color(0xff00ff),
      new THREE.Color(0xffa500), new THREE.Color(0x800080), new THREE.Color(0x008000),
      new THREE.Color(0x800000), // Max 10 for performance
    ];
    const colors: THREE.Color[] = [];
    for (let i = 0; i < numSpecies; i++) {
      speciesConfigs.push({
        separation: 15.0 + Math.random() * 10,
        alignment: 15.0 + Math.random() * 10,
        cohesion: 10.0 + Math.random() * 10,
        freedom: 0.75 + Math.random() * 0.1,
        speedLimit: 7.0 + Math.random() * 2,
      });
      colors.push(baseColors[i % baseColors.length]);
    }

    // Boids Simulation
    const boidsSimulation = new BoidsSimulation({ count, numSpecies, species: speciesConfigs });

    // Update boid count display
    const boidCountDisplay = document.getElementById('boid-count-display');
    if (boidCountDisplay) {
      boidCountDisplay.textContent = `(${boidsSimulation.getConfig().count} Boids)`;
    }

    // Boids Visualization
    const boidsVisualization = new BoidsVisualization(boidsSimulation, {
      particleSize: 6.0,
      useTriangles: true,
      colors: colors,
    });

    // Update behavior based on dropdown
    const behaviorSelect = document.getElementById('boid-behavior-select') as HTMLSelectElement;
    const updateBehavior = () => {
      boidsSimulation.updateConfig({
        interSpeciesRule: behaviorSelect.value as InterSpeciesRule
      });
    };
    behaviorSelect.addEventListener('change', updateBehavior);
    updateBehavior();

    const camera = boidsVisualization.getCamera();
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    camera.position.z = 700;

    // Mouse interaction
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2(1, 1);

    function onMouseMove(event: MouseEvent) {
      if (!container) return;
      const rect = container.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    }
    container.addEventListener('mousemove', onMouseMove, false);

    // Handle window resizing
    function onWindowResize() {
      if (container) {
        boidsVisualization.onWindowResize(container.clientWidth, container.clientHeight);
        renderer.setSize(container.clientWidth, container.clientHeight);
      }
    }
    window.addEventListener('resize', onWindowResize);

    // State management
    let isVisible = false;
    let isManuallyPaused = false;
    let animationId: number | null = null;
    const shouldRun = () => isVisible && !isManuallyPaused;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          isVisible = entry.isIntersecting;
          if (shouldRun() && !animationId) startAnimation();
          else if (!shouldRun() && animationId) stopAnimation();
        });
      },
      { threshold: 0.1 }
    );
    observer.observe(container);

    renderer.domElement.addEventListener('click', () => {
      isManuallyPaused = !isManuallyPaused;
      if (shouldRun() && !animationId) startAnimation();
      else if (!shouldRun() && animationId) stopAnimation();
    });

    // Animation loop
    let lastTime = performance.now();
    function animate() {
      if (!shouldRun()) {
        animationId = null;
        return;
      }
      const now = performance.now();
      const deltaTime = Math.min((now - lastTime) / 1000, 1/30);
      lastTime = now;
      raycaster.setFromCamera(mouse, camera);
      boidsSimulation.update(deltaTime, raycaster.ray.origin, raycaster.ray.direction);
      boidsSimulation.compute(renderer);
      boidsVisualization.render(renderer);
      animationId = requestAnimationFrame(animate);
    }

    function startAnimation() {
      if (!animationId && shouldRun()) {
        lastTime = performance.now();
        animationId = requestAnimationFrame(animate);
      }
    }

    function stopAnimation() {
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    }
    
    // Set up cleanup function for this instance
    cleanup = () => {
      stopAnimation();
      observer.disconnect();
      container.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('resize', onWindowResize);
      behaviorSelect.removeEventListener('change', updateBehavior);
      
      // Dispose visualization resources first, then the renderer
      boidsVisualization.dispose();
      renderer.dispose();

      // Finally, clean up the DOM element
      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement);
      }
    };
  };

  // Initial simulation start
  const speciesCountInput = document.getElementById('species-count-input') as HTMLInputElement;
  startNewSimulation(parseInt(speciesCountInput.value, 10), currentBoidCount);

  // Listener for species count changes
  speciesCountInput.addEventListener('change', () => {
    const numSpecies = parseInt(speciesCountInput.value, 10);
    if (!isNaN(numSpecies) && numSpecies > 0 && numSpecies <= 10) {
      startNewSimulation(numSpecies, currentBoidCount);
    }
  });

  const increaseBoidsBtn = document.getElementById('increase-boids-btn');
  increaseBoidsBtn?.addEventListener('click', () => {
    currentBoidCount = Math.min(currentBoidCount * 2, 16384);
    startNewSimulation(parseInt(speciesCountInput.value, 10), currentBoidCount);
  });

  const decreaseBoidsBtn = document.getElementById('decrease-boids-btn');
  decreaseBoidsBtn?.addEventListener('click', () => {
    currentBoidCount = Math.max(currentBoidCount / 2, 256);
    startNewSimulation(parseInt(speciesCountInput.value, 10), currentBoidCount);
  });

  console.log('Boids simulation initialized - will start when visible');
}

// Initialize website functionality
async function initWebsite() {
  console.log('Initializing TSL Compute Shaders website...')
  
  // Highlight all code blocks
  hljs.highlightAll();

  // Update example outputs
  await runBasicExample()
  await runGameOfLife()
  await runLangtonAnt()
  await runBoidsSimulation()
  
  console.log('Website initialization complete!')
}

// Start website initialization when DOM is loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWebsite)
} else {
  initWebsite()
}

// Export for potential external use
export { initWebsite, updateBasicExampleOutput, updateGameOfLifeOutput }