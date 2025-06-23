import './styles.css'
import * as THREE from 'three/webgpu'
import { Fn, instancedArray, instanceIndex, int, If, Loop, hash, atomicAdd, atomicSub, atomicStore, atomicLoad } from 'three/tsl'

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
  const multiAntGrid = instancedArray(totalCells * 3, 'int').toAtomic()
  
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
    
    atomicStore(multiAntGrid.element(hasAntIndex), 0)
    atomicStore(multiAntGrid.element(directionIndex), 0)
    atomicStore(multiAntGrid.element(colorIndex), 0)
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
    
    If(randomValue.lessThan(0.05), () => {
      atomicStore(hasAnt, 1) // Place ant
      // Random direction (0-3)
      const randomDir = hash(instanceIndex.add(98765)).mul(4).floor().toInt()
      atomicStore(direction, randomDir)
      // Random color channel (0=Red, 1=Green, 2=Blue)
      const randomColor = hash(instanceIndex.add(13579)).mul(3).floor().toInt()
      atomicStore(colorChannel, randomColor)
    }).Else(() => {
      atomicStore(hasAnt, 0) // No ant
      atomicStore(direction, 0) // Direction doesn't matter
      atomicStore(colorChannel, 0) // Color doesn't matter
    })
  })()
  
  // Rule system selector - uniform to control which rule system is active
  // 0 = Chromatic Ecosystem, 1 = Simple Langton, 2 = Competitive, 3 = Symbiotic
  const ruleSystemMode = instancedArray(1, 'int')
  
  // Initialize rule system to Chromatic Ecosystem (0)
  const initRuleSystem = Fn(() => {
    ruleSystemMode.element(0).assign(0)
  })()
  
  // Helper function that writes the selected rule mode _into the GPU buffer_.
  // We have to dispatch a 1-thread compute shader because `ruleSystemMode` lives
  // in GPU memory – assigning on the CPU alone has no effect.
  const switchRuleSystem = async (mode: number) => {
    const setMode = Fn(() => {
      ruleSystemMode.element(0).assign(int(mode))
    })()

    // Fire-and-forget is fine here, but returning the promise allows callers to
    // `await` if they want to ensure the update completed before the next step.
    return renderer.computeAsync(setMode.compute(1))
  }

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
        // If on light (total intensity < 100): turn right, add to red channel
        // If on dark (total intensity >= 100): turn left, subtract from red channel only
        If(totalIntensity.lessThan(100), () => {
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
    
    const loadedHasAnt = atomicLoad(hasAnt).toInt().toVar()
    // Only process cells that have ants
    If(loadedHasAnt.equal(1), () => {
      // Get current cell RGB values
      const currentR = gridR.element(cellIndex)
      const currentG = gridG.element(cellIndex)
      const currentB = gridB.element(cellIndex)
      const totalIntensity = currentR.add(currentG).add(currentB)
      
      // Apply the selected rule system based on ruleSystemMode
      const currentRuleMode = ruleSystemMode.element(0)
      
      If(currentRuleMode.equal(0), () => {
        // Chromatic Ecosystem Rules
        If(totalIntensity.lessThan(100), () => {
          // On light cells: turn right, but behavior depends on color dominance
          atomicStore(direction, atomicLoad(direction).toInt().add(1).mod(4))
          
          // Find dominant color channel
          const isRedDominant = currentR.greaterThanEqual(currentG).and(currentR.greaterThanEqual(currentB))
          const isGreenDominant = currentG.greaterThan(currentR).and(currentG.greaterThanEqual(currentB))
          
          // Chromatic interaction rules
          If(atomicLoad(antColor).toInt().equal(0), () => {
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
          }).ElseIf(atomicLoad(antColor).toInt().equal(1), () => {
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
          atomicStore(direction, atomicLoad(direction).toInt().add(3).mod(4))
          
          // Calculate color influence for fading
          const colorIntensity = currentR.add(currentG).add(currentB)
          const fadeAmount = colorIntensity.div(6).max(10).min(50) // Adaptive fade
          
          If(atomicLoad(antColor).toInt().equal(0), () => {
            // Red ant causes purple shift when fading
            currentR.assign(currentR.sub(fadeAmount).max(0))
            If(currentB.greaterThan(20), () => {
              currentB.assign(currentB.sub(fadeAmount.div(2)).max(0)) // Slower blue fade
            })
          }).ElseIf(atomicLoad(antColor).toInt().equal(1), () => {
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
      }).ElseIf(currentRuleMode.equal(1), () => {
        // Simple Langton Rules
        If(totalIntensity.lessThan(100), () => {
          // On light cells: turn right, add color based on ant type
          atomicStore(direction, atomicLoad(direction).toInt().add(1).mod(4))
          
          If(atomicLoad(antColor).toInt().equal(0), () => {
            currentR.assign(100) // Red ant adds red
          }).ElseIf(atomicLoad(antColor).toInt().equal(1), () => {
            currentG.assign(100) // Green ant adds green
          }).Else(() => {
            currentB.assign(100) // Blue ant adds blue
          })
        }).Else(() => {
          // On dark cells: turn left, remove color
          atomicStore(direction, atomicLoad(direction).toInt().add(3).mod(4))
          
          If(atomicLoad(antColor).toInt().equal(0), () => {
            currentR.assign(currentR.sub(50).max(0)) // Red ant removes red
          }).ElseIf(atomicLoad(antColor).toInt().equal(1), () => {
            currentG.assign(currentG.sub(50).max(0)) // Green ant removes green
          }).Else(() => {
            currentB.assign(currentB.sub(50).max(0)) // Blue ant removes blue
          })
        })
      }).ElseIf(currentRuleMode.equal(2), () => {
        // Competitive Rules
        If(totalIntensity.lessThan(100), () => {
          // On light cells: turn right, aggressively claim territory
          atomicStore(direction, atomicLoad(direction).toInt().add(1).mod(4))
          
          If(atomicLoad(antColor).toInt().equal(0), () => {
            // Red ant: aggressive takeover
            currentR.assign(100)
            currentG.assign(currentG.sub(30).max(0))
            currentB.assign(currentB.sub(30).max(0))
          }).ElseIf(atomicLoad(antColor).toInt().equal(1), () => {
            // Green ant: balanced approach
            currentG.assign(100)
            currentR.assign(currentR.sub(15).max(0))
            currentB.assign(currentB.sub(15).max(0))
          }).Else(() => {
            // Blue ant: defensive expansion
            currentB.assign(100)
            If(currentR.add(currentG).greaterThan(50), () => {
              currentR.assign(currentR.sub(20).max(0))
              currentG.assign(currentG.sub(20).max(0))
            })
          })
        }).Else(() => {
          // On dark cells: turn left, retreat or defend
          atomicStore(direction, atomicLoad(direction).toInt().add(3).mod(4))
          
          // Gradual decay based on ant color
          If(atomicLoad(antColor).toInt().equal(0), () => {
            currentR.assign(currentR.sub(25).max(0))
          }).ElseIf(atomicLoad(antColor).toInt().equal(1), () => {
            currentG.assign(currentG.sub(25).max(0))
          }).Else(() => {
            currentB.assign(currentB.sub(25).max(0))
          })
        })
      }).Else(() => {
        // Symbiotic Rules (mode 3)
        If(totalIntensity.lessThan(50), () => {
          // On light cells: turn right, build complementary colors
          atomicStore(direction, atomicLoad(direction).toInt().add(1).mod(4))
          
          If(atomicLoad(antColor).toInt().equal(0), () => {
            // Red ant: create warm tones
            currentR.assign(currentR.add(40).min(100))
            If(currentG.lessThan(20), () => {
              currentG.assign(currentG.add(20).min(100)) // Add yellow tints
            })
          }).ElseIf(atomicLoad(antColor).toInt().equal(1), () => {
            // Green ant: bridge colors
            currentG.assign(currentG.add(40).min(100))
            If(currentR.greaterThan(30), () => {
              currentR.assign(currentR.add(10).min(100)) // Enhance existing red
            })
            If(currentB.greaterThan(30), () => {
              currentB.assign(currentB.add(10).min(100)) // Enhance existing blue
            })
          }).Else(() => {
            // Blue ant: create cool tones
            currentB.assign(currentB.add(40).min(100))
            If(currentG.lessThan(20), () => {
              currentG.assign(currentG.add(15).min(100)) // Add cyan tints
            })
          })
        }).Else(() => {
          // On dark cells: turn left, preserve existing colors
          atomicStore(direction, atomicLoad(direction).toInt().add(3).mod(4))
          
          // Gentle fade that preserves color balance
          const fadeAmount = int(15)
          currentR.assign(currentR.sub(fadeAmount).max(0))
          currentG.assign(currentG.sub(fadeAmount).max(0))
          currentB.assign(currentB.sub(fadeAmount).max(0))
        })
      })
      
      // Mark this ant for removal (we'll move it in phase 2)
      atomicStore(hasAnt, 2) // Use 2 as "marked for movement"
    })
  })()
  
  const stepMultiAntsPhase2 = Fn(() => {
    const cellIndex = instanceIndex
    const hasAntIndex = cellIndex.mul(3)
    const hasAnt = multiAntGrid.element(hasAntIndex)
    
    const loadedHasAnt2 = atomicLoad(hasAnt).toInt().toVar()
    // Only process ants marked for movement
    If(loadedHasAnt2.equal(2), () => {
      const x = cellIndex.mod(gridWidth)
      const y = cellIndex.div(gridWidth).toInt()
      
      const direction = atomicLoad(multiAntGrid.element(hasAntIndex.add(1))).toInt()
      const antColor = atomicLoad(multiAntGrid.element(hasAntIndex.add(2))).toInt()
      
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
      
      const newCellIndex = newY.mul(gridWidth).add(newX)
      const newHasAntIndex = newCellIndex.mul(3)
      const newTargetHasAnt = multiAntGrid.element(newHasAntIndex)
      
      const claimValue = 2
      const originalValue = atomicAdd(newTargetHasAnt, claimValue)
      
      If(originalValue.equal(0), () => {
        // Success: We claimed the new cell
        // Move ant's data to the new location
        atomicStore(multiAntGrid.element(newHasAntIndex.add(1)), direction)
        atomicStore(multiAntGrid.element(newHasAntIndex.add(2)), antColor)
        
        // Clear the old cell
        atomicStore(hasAnt, 0)
      }).Else(() => {
        // Collision: The target cell was already occupied or claimed.
        // Revert the claim and have the ant stay in its original position.
        atomicSub(newTargetHasAnt, claimValue)
        atomicStore(hasAnt, 1)
      })
    })
  })()
  
  // A new third phase to finalize the move
  const stepMultiAntsPhase3 = Fn(() => {
    const cellIndex = instanceIndex
    const hasAntIndex = cellIndex.mul(3)
    const hasAnt = multiAntGrid.element(hasAntIndex)
    
    const loadedHasAnt3 = atomicLoad(hasAnt).toInt().toVar()
    // An ant with state 2 has successfully moved in phase 2.
    // We now set its state to 1 (active) for the next simulation step.
    If(loadedHasAnt3.equal(2), () => {
      atomicStore(hasAnt, 1)
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
  
  // Initialize step counter and rule system
  const initCounter = Fn(() => {
    stepCounter.element(0).assign(0)
  })()
  await renderer.computeAsync(initCounter.compute(1))
  await renderer.computeAsync(initRuleSystem.compute(1))
  
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
    stepMultiAntsPhase3,
    fadeGrid,
    initializeGrid,
    initializeAnt,
    initializeMultiAnts,
    clearMultiAnts,
    // Expose a convenient string-based selector for external UI code.
    ruleSystemMode,
    switchRuleSystem: async (ruleName: string) => {
      const ruleMap = {
        'chromaticEcosystem': 0,
        'simpleLangton': 1,
        'competitive': 2,
        'symbiotic': 3
      } as const

      const mode = ruleMap[ruleName as keyof typeof ruleMap]
      if (mode !== undefined) {
        await switchRuleSystem(mode)
      }
    }
  }
}

// Export for use in visualization
export { initLangtonAnt }