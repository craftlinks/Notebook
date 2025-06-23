import './styles.css'
import * as THREE from 'three/webgpu'
import { Fn, instancedArray, instanceIndex, int, If, Loop, hash } from 'three/tsl'

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
      
      // Apply Chromatic Ecosystem Rules - complex color interactions
      If(totalIntensity.lessThan(50), () => {
        // On light cells: turn right, but behavior depends on color dominance
        direction.assign(direction.add(1).mod(4))
        
        // Find dominant color channel
        const isRedDominant = currentR.greaterThanEqual(currentG).and(currentR.greaterThanEqual(currentB))
        const isGreenDominant = currentG.greaterThan(currentR).and(currentG.greaterThanEqual(currentB))
        
        // Chromatic interaction rules
        If(antColor.equal(0), () => {
          // Red ant behavior
          If(isRedDominant, () => {
            currentR.assign(currentR.add(50).min(100)) // Strengthen red dominance
          }).ElseIf(isGreenDominant, () => {
            currentG.assign(currentG.sub(30).max(0)) // Compete with green
            currentR.assign(100) // Assert red presence
          }).Else(() => {
            // Blue dominant or mixed
            currentB.assign(currentB.sub(20).max(0)) // Weaken blue
            currentR.assign(80) // Moderate red addition
          })
        }).ElseIf(antColor.equal(1), () => {
          // Green ant behavior (symbiotic with red, competitive with blue)
          If(isRedDominant, () => {
            currentG.assign(60) // Moderate green in red areas
            currentR.assign(currentR.add(20).min(100)) // Boost red slightly
          }).ElseIf(isGreenDominant, () => {
            currentG.assign(100) // Maintain green dominance
          }).Else(() => {
            // Blue dominant or mixed
            currentB.assign(currentB.sub(40).max(0)) // Strongly compete with blue
            currentG.assign(100) // Assert green presence
          })
        }).Else(() => {
          // Blue ant behavior (creates cool zones, competitive with warm colors)
          If(isRedDominant.or(isGreenDominant), () => {
            // In warm areas, create cooling effect
            currentR.assign(currentR.sub(25).max(0))
            currentG.assign(currentG.sub(25).max(0))
            currentB.assign(currentB.add(60).min(100))
          }).Else(() => {
            // In blue or mixed areas, strengthen blue
            currentB.assign(100)
          })
        })
      }).Else(() => {
        // On dark cells: turn left, color decay with cross-channel effects
        direction.assign(direction.add(3).mod(4))
        
        // Calculate color influence for fading
        const colorIntensity = currentR.add(currentG).add(currentB)
        const fadeAmount = colorIntensity.div(6).max(10).min(50) // Adaptive fade
        
        If(antColor.equal(0), () => {
          // Red ant causes purple shift when fading
          currentR.assign(currentR.sub(fadeAmount).max(0))
          If(currentB.greaterThan(20), () => {
            currentB.assign(currentB.sub(fadeAmount.div(2)).max(0)) // Slower blue fade
          })
        }).ElseIf(antColor.equal(1), () => {
          // Green ant causes yellow-to-red shift when fading
          currentG.assign(currentG.sub(fadeAmount).max(0))
          If(currentR.greaterThan(currentG), () => {
            currentR.assign(currentR.sub(fadeAmount.div(3)).max(0)) // Preserve some red
          })
        }).Else(() => {
          // Blue ant causes cyan shift when fading
          currentB.assign(currentB.sub(fadeAmount).max(0))
          If(currentG.greaterThan(10), () => {
            currentG.assign(currentG.sub(fadeAmount.div(2)).max(0)) // Slower green fade
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

      // Set new position, preventing collisions
      const newCellIndex = newY.mul(gridWidth).add(newX)
      const newHasAntIndex = newCellIndex.mul(3)
      const newDirectionIndex = newCellIndex.mul(3).add(1)
      const newColorIndex = newCellIndex.mul(3).add(2)
      
      const targetHasAnt = multiAntGrid.element(newHasAntIndex)
      
      // Only move if the target cell is not occupied by another moving ant
      If(targetHasAnt.lessThan(2), () => {
        // Clear current position
        hasAnt.assign(0)

        // Set new position
        multiAntGrid.element(newHasAntIndex).assign(1)
        multiAntGrid.element(newDirectionIndex).assign(direction)
        multiAntGrid.element(newColorIndex).assign(antColor)
      }).Else(() => {
        // Collision detected, ant stays in place but is no longer marked for movement
        hasAnt.assign(1)
      })
    })
  })()
  
  // Create a step counter to control fading rate
  const stepCounter = instancedArray(1, 'int')
  
  // Fade function to gradually reduce density of unvisited cells
  const fadeGrid = Fn(() => {
    const cellIndex = instanceIndex
    const counter = stepCounter.element(0) // Read once at the start

    // Increment on first thread for the next frame
    If(cellIndex.equal(0), () => {
      stepCounter.element(0).assign(counter.add(1))
    })

    const cellR = gridR.element(cellIndex)
    const cellG = gridG.element(cellIndex)
    const cellB = gridB.element(cellIndex)

    const shouldFade = counter.mod(10).equal(0)

    // Fade each RGB channel independently when fade cycle occurs
    If(shouldFade, () => {
      // Fade red channel
      If(cellR.greaterThan(0), () => {
        cellR.assign(cellR.sub(1))
      })
      
      // Fade green channel
      If(cellG.greaterThan(0), () => {
        cellG.assign(cellG.sub(1))
      })
      
      // Fade blue channel
      If(cellB.greaterThan(0), () => {
        cellB.assign(cellB.sub(1))
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