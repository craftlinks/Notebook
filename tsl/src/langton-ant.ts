import './styles.css'
import * as THREE from 'three/webgpu'
import { Fn, instancedArray, instanceIndex, int, vec4, positionLocal, If } from 'three/tsl'

async function initLangtonAnt({ canvas, renderer: existingRenderer }: { canvas?: HTMLCanvasElement; renderer?: THREE.WebGPURenderer } = {}) {
  // Initialize WebGPU renderer
  const renderer = existingRenderer || new THREE.WebGPURenderer({ canvas, antialias: true })
  if (!existingRenderer) {
    await renderer.init()
  }
  
  if (canvas) {
    renderer.setSize(canvas.width, canvas.height)
  }
  
  // Grid dimensions - much larger for Langton's Ant to see emergent patterns
  const gridWidth = 200
  const gridHeight = 200
  const totalCells = gridWidth * gridHeight
  
  // Create buffer for grid (0 = white, 1 = black)
  const grid = instancedArray(totalCells, 'int')
  
  // Ant state: [x, y, direction] where direction: 0=North, 1=East, 2=South, 3=West
  const antState = instancedArray(3, 'int')
  
  // Helper function to convert 2D coordinates to 1D index
  const getIndex = Fn(([x, y]: any) => {
    return y.mul(gridWidth).add(x)
  })
  
  // Initialize grid - all cells start white (0)
  const initializeGrid = Fn(() => {
    const cell = grid.element(instanceIndex)
    cell.assign(0) // All cells start white
  })()
  
  // Initialize ant in center facing north
  const initializeAnt = Fn(() => {
    const antX = antState.element(0)
    const antY = antState.element(1)
    const antDir = antState.element(2)
    
    antX.assign(int(100)) // gridWidth / 2 = 100
    antY.assign(int(100)) // gridHeight / 2 = 100
    antDir.assign(int(0))
  })()
  
  // Langton's Ant step function - optimized to only run on first thread
  const stepAnt = Fn(() => {
    // Only run on the first GPU thread to avoid redundant work
    If(instanceIndex.equal(0), () => {
      const antX = antState.element(0)
      const antY = antState.element(1)
      const antDir = antState.element(2)
      
      // Get current cell index and value (inline for performance)
      const currentIndex = antY.mul(gridWidth).add(antX)
      const currentCell = grid.element(currentIndex)
      
      // Langton's Ant rules:
      // If on white (0): turn right, flip to black (1)  
      // If on black (1): turn left, flip to white (0)
      If(currentCell.equal(0), () => {
        antDir.assign(antDir.add(1).mod(4))
        currentCell.assign(1)
      }).Else(() => {
        antDir.assign(antDir.add(3).mod(4))
        currentCell.assign(0)
      })
      
      // Move ant forward based on direction
      // 0=North(y-1), 1=East(x+1), 2=South(y+1), 3=West(x-1)
      If(antDir.equal(0), () => {
        antY.assign(antY.sub(1))
      }).ElseIf(antDir.equal(1), () => {
        antX.assign(antX.add(1))
      }).ElseIf(antDir.equal(2), () => {
        antY.assign(antY.add(1))
      }).Else(() => {
        antX.assign(antX.sub(1))
      })
      
      // Wrap around boundaries
      antX.assign(antX.add(gridWidth).mod(gridWidth))
      antY.assign(antY.add(gridHeight).mod(gridHeight))
    })
  })()
  
  
  // Initialize
  console.log('Initializing Langton\'s Ant...')
  await renderer.computeAsync(initializeGrid.compute(totalCells))
  await renderer.computeAsync(initializeAnt.compute(1))
  
  console.log('Langton\'s Ant initialized!')

  return {
    renderer,
    grid,
    antState,
    gridWidth,
    gridHeight,
    stepAnt,
    initializeGrid,
    initializeAnt
  }
}

// Export for use in visualization
export { initLangtonAnt }