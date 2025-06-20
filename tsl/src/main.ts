import './styles.css'
import * as THREE from 'three/webgpu'
import { Fn, instancedArray, instanceIndex } from 'three/tsl'

async function initComputeShader() {
  // Initialize WebGPU renderer
  const renderer = new THREE.WebGPURenderer()
  await renderer.init()
  
  // Create a simple compute shader that multiplies numbers by 2
  const count = 10
  const inputBuffer = instancedArray(count, 'float')
  const outputBuffer = instancedArray(count, 'float')
  
  // Initialize input data
  const initCompute = Fn(() => {
    const input = inputBuffer.element(instanceIndex)
    input.assign(instanceIndex.add(1).toFloat()) // Values 1, 2, 3, ..., 10
  })()
  
  // Main compute function: multiply each value by 2
  const multiplyCompute = Fn(() => {
    const input = inputBuffer.element(instanceIndex)
    const output = outputBuffer.element(instanceIndex)
    output.assign(input.mul(2))
  })()
  
  // Execute compute shaders
  await renderer.computeAsync(initCompute.compute(count))
  await renderer.computeAsync(multiplyCompute.compute(count))
  
  // Read buffer contents
  const inputArray = await renderer.getArrayBufferAsync(inputBuffer.value)
  const outputArray = await renderer.getArrayBufferAsync(outputBuffer.value)
  
  const result = {
    input: Array.from(new Float32Array(inputArray)),
    output: Array.from(new Float32Array(outputArray))
  }
  
  console.log('TSL Compute Shader Example:')
  console.log('Input values:', result.input)
  console.log('Output values (input * 2):', result.output)
  console.log('Compute shaders executed successfully!')
  
  return result
}

// Export for website integration
export { initComputeShader }

// Run automatically for console output
initComputeShader().catch(console.error)

console.log('TSL Check: Successfully imported and created TSL function')
// console.log('TSL Function:', tslFunction)
// console.log('Material with TSL colorNode:', material)
