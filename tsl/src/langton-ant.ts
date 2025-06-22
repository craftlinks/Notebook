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
  
  // Create buffers for RGB channels - each stores density values (0-100)
  // 0 = no color, 100 = full color intensity
  const gridR = instancedArray(totalCells, 'int')
  const gridG = instancedArray(totalCells, 'int')
  const gridB = instancedArray(totalCells, 'int')
  
  // Ant state: [x, y, direction] where direction: 0=North, 1=East, 2=South, 3=West
  const antState = instancedArray(3, 'int')
  
  // Multi-ant buffer: stores [hasAnt, direction, colorChannel] for each cell
  // hasAnt: 0 = no ant, 1 = has ant
  // direction: 0=North, 1=East, 2=South, 3=West
  // colorChannel: 0=Red, 1=Green, 2=Blue
  const multiAntGrid = instancedArray(totalCells * 3, 'int')
  
  // Helper function to convert 2D coordinates to 1D index
  const getIndex = Fn(([x, y]: any) => {
    return y.mul(gridWidth).add(x)
  })
  
  // Initialize grid - all cells start white (0 in all channels)
  const initializeGrid = Fn(() => {
    const cellR = gridR.element(instanceIndex)
    const cellG = gridG.element(instanceIndex)
    const cellB = gridB.element(instanceIndex)
    cellR.assign(0) // All cells start with no red
    cellG.assign(0) // All cells start with no green
    cellB.assign(0) // All cells start with no blue
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
    const hasAntIndex = instanceIndex.mul(3)
    const directionIndex = instanceIndex.mul(3).add(1)
    const colorIndex = instanceIndex.mul(3).add(2)
    
    multiAntGrid.element(hasAntIndex).assign(0)
    multiAntGrid.element(directionIndex).assign(0)
    multiAntGrid.element(colorIndex).assign(0)
  })()
  
  // Initialize multi-ant grid with 1% ant density
  const initializeMultiAnts = Fn(() => {
    const cellIndex = instanceIndex
    const hasAntIndex = cellIndex.mul(3)
    const directionIndex = cellIndex.mul(3).add(1)
    const colorIndex = cellIndex.mul(3).add(2)
    
    const hasAnt = multiAntGrid.element(hasAntIndex)
    const direction = multiAntGrid.element(directionIndex)
    const colorChannel = multiAntGrid.element(colorIndex)
    
    // Use hash for pseudo-random placement (1% chance)
    const randomValue = hash(instanceIndex.add(54321))
    
    If(randomValue.lessThan(0.01), () => {
      hasAnt.assign(1) // Place ant
      // Random direction (0-3)
      const randomDir = hash(instanceIndex.add(98765)).mul(4).floor().toInt()
      direction.assign(randomDir)
      // Random color channel (0=Red, 1=Green, 2=Blue)
      const randomColor = hash(instanceIndex.add(13579)).mul(3).floor().toInt()
      colorChannel.assign(randomColor)
    }).Else(() => {
      hasAnt.assign(0) // No ant
      direction.assign(0) // Direction doesn't matter
      colorChannel.assign(0) // Color doesn't matter
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
        // Get current cell index and RGB values
        const currentIndex = antY.mul(gridWidth).add(antX)
        const currentR = gridR.element(currentIndex)
        const currentG = gridG.element(currentIndex)
        const currentB = gridB.element(currentIndex)
        
        // Calculate total intensity to determine if cell is "dark" or "light"
        const totalIntensity = currentR.add(currentG).add(currentB)
        
        // Langton's Ant rules (conservative - only affect own color):
        // If on light (total intensity < 50): turn right, add to red channel
        // If on dark (total intensity >= 50): turn left, subtract from red channel only
        If(totalIntensity.lessThan(50), () => {
          antDir.assign(antDir.add(1).mod(4))
          currentR.assign(100) // Single ant contributes to red channel
        }).Else(() => {
          antDir.assign(antDir.add(3).mod(4))
          // Only subtract from red channel (conservative approach)
          const newR = currentR.sub(100)
          If(newR.lessThan(0), () => {
            currentR.assign(0) // Clamp to minimum
          }).Else(() => {
            currentR.assign(newR)
          })
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
    
    const hasAntIndex = cellIndex.mul(3)
    const directionIndex = cellIndex.mul(3).add(1)
    const colorIndex = cellIndex.mul(3).add(2)
    
    const hasAnt = multiAntGrid.element(hasAntIndex)
    const direction = multiAntGrid.element(directionIndex)
    const antColor = multiAntGrid.element(colorIndex)
    
    // Only process cells that have ants
    If(hasAnt.equal(1), () => {
      // Get current cell RGB values
      const currentR = gridR.element(cellIndex)
      const currentG = gridG.element(cellIndex)
      const currentB = gridB.element(cellIndex)
      const totalIntensity = currentR.add(currentG).add(currentB)
      
      // Apply conservative Langton's Ant rules based on total intensity
      If(totalIntensity.lessThan(50), () => {
        // On light: turn right, add color to ant's own channel
        direction.assign(direction.add(1).mod(4))
        If(antColor.equal(0), () => {
          currentR.assign(100) // Red ant adds to red
        }).ElseIf(antColor.equal(1), () => {
          currentG.assign(100) // Green ant adds to green
        }).Else(() => {
          currentB.assign(100) // Blue ant adds to blue
        })
      }).Else(() => {
        // On dark: turn left, subtract from ant's own channel only
        direction.assign(direction.add(3).mod(4))
        If(antColor.equal(0), () => {
          // Red ant subtracts from red only
          const newR = currentR.sub(100)
          If(newR.lessThan(0), () => {
            currentR.assign(0)
          }).Else(() => {
            currentR.assign(newR)
          })
        }).ElseIf(antColor.equal(1), () => {
          // Green ant subtracts from green only
          const newG = currentG.sub(100)
          If(newG.lessThan(0), () => {
            currentG.assign(0)
          }).Else(() => {
            currentG.assign(newG)
          })
        }).Else(() => {
          // Blue ant subtracts from blue only
          const newB = currentB.sub(100)
          If(newB.lessThan(0), () => {
            currentB.assign(0)
          }).Else(() => {
            currentB.assign(newB)
          })
        })
      })
      
      // Mark this ant for removal (we'll move it in phase 2)
      hasAnt.assign(2) // Use 2 as "marked for movement"
    })
  })()
  
  const stepMultiAntsPhase2 = Fn(() => {
    const cellIndex = instanceIndex
    const x = cellIndex.mod(gridWidth)
    const y = cellIndex.div(gridWidth).toInt()
    
    const hasAntIndex = cellIndex.mul(3)
    const directionIndex = cellIndex.mul(3).add(1)
    const colorIndex = cellIndex.mul(3).add(2)
    
    const hasAnt = multiAntGrid.element(hasAntIndex)
    const direction = multiAntGrid.element(directionIndex)
    const antColor = multiAntGrid.element(colorIndex)
    
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
      const newHasAntIndex = newCellIndex.mul(3)
      const newDirectionIndex = newCellIndex.mul(3).add(1)
      const newColorIndex = newCellIndex.mul(3).add(2)
      
      multiAntGrid.element(newHasAntIndex).assign(1)
      multiAntGrid.element(newDirectionIndex).assign(direction)
      multiAntGrid.element(newColorIndex).assign(antColor)
    })
  })()
  
  // Create a step counter to control fading rate
  const stepCounter = instancedArray(1, 'int')
  
  // Fade function to gradually reduce density of unvisited cells
  const fadeGrid = Fn(() => {
    const cellIndex = instanceIndex
    const cellR = gridR.element(cellIndex)
    const cellG = gridG.element(cellIndex)
    const cellB = gridB.element(cellIndex)
    
    // Only process on the first thread to increment the counter
    If(cellIndex.equal(0), () => {
      const counter = stepCounter.element(0)
      counter.assign(counter.add(1))
    })
    
    const counter = stepCounter.element(0)
    const shouldFade = counter.mod(10).equal(0)
    
    // Fade each RGB channel independently
    If(shouldFade, () => {
      // Fade red channel
      If(cellR.greaterThan(0), () => {
        const newR = cellR.sub(1)
        If(newR.lessThan(0), () => {
          cellR.assign(0)
        }).Else(() => {
          cellR.assign(newR)
        })
      })
      
      // Fade green channel
      If(cellG.greaterThan(0), () => {
        const newG = cellG.sub(1)
        If(newG.lessThan(0), () => {
          cellG.assign(0)
        }).Else(() => {
          cellG.assign(newG)
        })
      })
      
      // Fade blue channel
      If(cellB.greaterThan(0), () => {
        const newB = cellB.sub(1)
        If(newB.lessThan(0), () => {
          cellB.assign(0)
        }).Else(() => {
          cellB.assign(newB)
        })
      })
    })
  })()
  
  // Initialize
  console.log('Initializing Langton\'s Ant...')
  await renderer.computeAsync(initializeGrid.compute(totalCells))
  await renderer.computeAsync(initializeAnt.compute(1))
  
  // Initialize step counter
  const initCounter = Fn(() => {
    stepCounter.element(0).assign(0)
  })()
  await renderer.computeAsync(initCounter.compute(1))
  
  console.log('Langton\'s Ant initialized!')

  return {
    renderer,
    gridR,
    gridG,
    gridB,
    antState,
    multiAntGrid,
    stepCounter,
    gridWidth,
    gridHeight,
    stepAnt,
    stepMultiAntsPhase1,
    stepMultiAntsPhase2,
    fadeGrid,
    initializeGrid,
    initializeAnt,
    initializeMultiAnts,
    clearMultiAnts
  }
}

// Export for use in visualization
export { initLangtonAnt }