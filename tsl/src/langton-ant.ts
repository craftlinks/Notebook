import './styles.css'
import * as THREE from 'three/webgpu'
import { Fn, instancedArray, instanceIndex, int, vec4, positionLocal, If, Loop, hash } from 'three/tsl'

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
  
  // Multi-ant buffer: stores [hasAnt, direction] for each cell
  // hasAnt: 0 = no ant, 1 = has ant
  // direction: 0=North, 1=East, 2=South, 3=West
  const multiAntGrid = instancedArray(totalCells * 2, 'int')
  
  // Helper function to convert 2D coordinates to 1D index
  const getIndex = Fn(([x, y]: any) => {
    return y.mul(gridWidth).add(x)
  })
  
  // Initialize grid - all cells start white (0)
  const initializeGrid = Fn(() => {
    const cell = grid.element(instanceIndex)
    cell.assign(0) // All cells start white
  })()
  
  // Initialize single ant in center facing north
  const initializeAnt = Fn(() => {
    const antX = antState.element(0)
    const antY = antState.element(1)
    const antDir = antState.element(2)
    
    antX.assign(int(100)) // gridWidth / 2 = 100
    antY.assign(int(100)) // gridHeight / 2 = 100
    antDir.assign(int(0))
  })()
  
  // Clear multi-ant grid
  const clearMultiAnts = Fn(() => {
    const hasAntIndex = instanceIndex.mul(2)
    const directionIndex = instanceIndex.mul(2).add(1)
    
    multiAntGrid.element(hasAntIndex).assign(0)
    multiAntGrid.element(directionIndex).assign(0)
  })()
  
  // Initialize multi-ant grid with 30% ant density
  const initializeMultiAnts = Fn(() => {
    const cellIndex = instanceIndex
    const hasAntIndex = cellIndex.mul(2)
    const directionIndex = cellIndex.mul(2).add(1)
    
    const hasAnt = multiAntGrid.element(hasAntIndex)
    const direction = multiAntGrid.element(directionIndex)
    
    // Use hash for pseudo-random placement (30% chance)
    const randomValue = hash(instanceIndex.add(54321))
    
    If(randomValue.lessThan(0.3), () => {
      hasAnt.assign(1) // Place ant
      // Random direction (0-3)
      const randomDir = hash(instanceIndex.add(98765)).mul(4).floor().toInt()
      direction.assign(randomDir)
    }).Else(() => {
      hasAnt.assign(0) // No ant
      direction.assign(0) // Direction doesn't matter
    })
  })()
  
  // Langton's Ant step function - optimized to only run on first thread
  const stepAnt = Fn(() => {
    // Only run on the first GPU thread to avoid redundant work
    If(instanceIndex.equal(0), () => {
      const antX = antState.element(0)
      const antY = antState.element(1)
      const antDir = antState.element(2)
      
      // Run 10 steps in a single compute shader for better performance
      Loop(10, () => {
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
    })
  })()
  
  // Multi-ant step function - uses a two-phase approach to avoid race conditions
  const stepMultiAntsPhase1 = Fn(() => {
    const cellIndex = instanceIndex
    const x = cellIndex.mod(gridWidth)
    const y = cellIndex.div(gridWidth).toInt()
    
    const hasAntIndex = cellIndex.mul(2)
    const directionIndex = cellIndex.mul(2).add(1)
    
    const hasAnt = multiAntGrid.element(hasAntIndex)
    const direction = multiAntGrid.element(directionIndex)
    
    // Only process cells that have ants
    If(hasAnt.equal(1), () => {
      // Get current cell color and apply Langton's Ant rules
      const currentCell = grid.element(cellIndex)
      
      If(currentCell.equal(0), () => {
        // On white: turn right, flip to black
        direction.assign(direction.add(1).mod(4))
        currentCell.assign(1)
      }).Else(() => {
        // On black: turn left, flip to white  
        direction.assign(direction.add(3).mod(4))
        currentCell.assign(0)
      })
      
      // Mark this ant for removal (we'll move it in phase 2)
      hasAnt.assign(2) // Use 2 as "marked for movement"
    })
  })()
  
  const stepMultiAntsPhase2 = Fn(() => {
    const cellIndex = instanceIndex
    const x = cellIndex.mod(gridWidth)
    const y = cellIndex.div(gridWidth).toInt()
    
    const hasAntIndex = cellIndex.mul(2)
    const directionIndex = cellIndex.mul(2).add(1)
    
    const hasAnt = multiAntGrid.element(hasAntIndex)
    const direction = multiAntGrid.element(directionIndex)
    
    // Only process ants marked for movement
    If(hasAnt.equal(2), () => {
      // Calculate new position
      const newX = x.toVar()
      const newY = y.toVar()
      
      If(direction.equal(0), () => {
        newY.assign(newY.sub(1)) // North
      }).ElseIf(direction.equal(1), () => {
        newX.assign(newX.add(1)) // East
      }).ElseIf(direction.equal(2), () => {
        newY.assign(newY.add(1)) // South
      }).Else(() => {
        newX.assign(newX.sub(1)) // West
      })
      
      // Wrap boundaries
      newX.assign(newX.add(gridWidth).mod(gridWidth))
      newY.assign(newY.add(gridHeight).mod(gridHeight))
      
      // Clear current position
      hasAnt.assign(0)
      
      // Set new position (still potential for conflicts, but reduced)
      const newCellIndex = newY.mul(gridWidth).add(newX)
      const newHasAntIndex = newCellIndex.mul(2)
      const newDirectionIndex = newCellIndex.mul(2).add(1)
      
      multiAntGrid.element(newHasAntIndex).assign(1)
      multiAntGrid.element(newDirectionIndex).assign(direction)
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
    multiAntGrid,
    gridWidth,
    gridHeight,
    stepAnt,
    stepMultiAntsPhase1,
    stepMultiAntsPhase2,
    initializeGrid,
    initializeAnt,
    initializeMultiAnts,
    clearMultiAnts
  }
}

// Export for use in visualization
export { initLangtonAnt }