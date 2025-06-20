import './styles.css'
import * as THREE from 'three/webgpu'
import { Fn, instancedArray, instanceIndex, int, hash, float, If } from 'three/tsl'

async function initGameOfLife({ canvas }: { canvas?: HTMLCanvasElement } = {}) {
  // Initialize WebGPU renderer
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true })
  await renderer.init()
  
  if (canvas) {
    renderer.setSize(canvas.width, canvas.height)
  }
  
  // Grid dimensions
  const gridWidth = 64
  const gridHeight = 64
  const totalCells = gridWidth * gridHeight
  
  // Create buffers for current and next generation
  const currentGeneration = instancedArray(totalCells, 'int')
  const nextGeneration = instancedArray(totalCells, 'int')
  
  // Helper function to convert 2D coordinates to 1D index
  const getIndex = Fn(([x, y]: any) => {
    return y.mul(gridWidth).add(x)
  })
  
  // Helper function to get cell state with boundary wrapping
  const getCell = Fn(([buffer, x, y]: any) => {
    // Wrap coordinates for toroidal topology
    const wrappedX = x.add(gridWidth).mod(gridWidth)
    const wrappedY = y.add(gridHeight).mod(gridHeight)
    // @ts-ignore - TSL function call signature issue
    const index = getIndex(wrappedX, wrappedY)
    return buffer.element(index)
  })
  
  // Initialize grid with random pattern
  const initializeGrid = Fn(() => {
    const currentCell = currentGeneration.element(instanceIndex)
    
    // Use hash function for pseudo-random initialization
    const randomValue = hash(instanceIndex.add(12345))
    
    // 30% chance for a cell to be alive initially
    If(randomValue.lessThan(0.3), () => {
      currentCell.assign(1) // Alive
    }).Else(() => {
      currentCell.assign(0) // Dead
    })
  })()
  
  // Game of Life update logic
  const updateGeneration = Fn(() => {
    // Convert 1D index to 2D coordinates
    const x = instanceIndex.mod(gridWidth)
    const y = instanceIndex.div(gridWidth).toInt()
    
    // Count living neighbors
    const neighbors = int(0).toVar()
  
    
    // Manual neighbor counting (TSL doesn't support dynamic loops over arrays)
    // @ts-ignore - TSL function call signature issue
    neighbors.addAssign(getCell(currentGeneration, x.sub(1), y.sub(1)))
    // @ts-ignore - TSL function call signature issue
    neighbors.addAssign(getCell(currentGeneration, x.sub(1), y))
    // @ts-ignore - TSL function call signature issue
    neighbors.addAssign(getCell(currentGeneration, x.sub(1), y.add(1)))
    // @ts-ignore - TSL function call signature issue
    neighbors.addAssign(getCell(currentGeneration, x, y.sub(1)))
    // @ts-ignore - TSL function call signature issue
    neighbors.addAssign(getCell(currentGeneration, x, y.add(1)))
    // @ts-ignore - TSL function call signature issue
    neighbors.addAssign(getCell(currentGeneration, x.add(1), y.sub(1)))
    // @ts-ignore - TSL function call signature issue
    neighbors.addAssign(getCell(currentGeneration, x.add(1), y))
    // @ts-ignore - TSL function call signature issue
    neighbors.addAssign(getCell(currentGeneration, x.add(1), y.add(1)))
    
    // Get current cell state
    const currentCell = currentGeneration.element(instanceIndex)
    const nextCell = nextGeneration.element(instanceIndex)
    
    // Apply Game of Life rules
    If(currentCell.equal(1), () => {
      // Living cell
      If(neighbors.lessThan(2), () => {
        nextCell.assign(0) // Dies from underpopulation
      }).ElseIf(neighbors.greaterThan(3), () => {
        nextCell.assign(0) // Dies from overpopulation
      }).Else(() => {
        nextCell.assign(1) // Survives (2 or 3 neighbors)
      })
    }).Else(() => {
      // Dead cell
      If(neighbors.equal(3), () => {
        nextCell.assign(1) // Birth (exactly 3 neighbors)
      }).Else(() => {
        nextCell.assign(0) // Stays dead
      })
    })
  })()
  
  // Copy next generation to current generation
  const copyGeneration = Fn(() => {
    const current = currentGeneration.element(instanceIndex)
    const next = nextGeneration.element(instanceIndex)
    current.assign(next)
  })()
  
  // Initialize the grid
  console.log('Initializing Game of Life grid...')
  await renderer.computeAsync(initializeGrid.compute(totalCells))
  
  console.log('Game of Life initialized!')
  
  return {
    renderer,
    currentGeneration,
    nextGeneration,
    gridWidth,
    gridHeight,
    updateGeneration,
    copyGeneration
  }
}

// Export for use in visualization
export { initGameOfLife }