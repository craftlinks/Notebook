# TSL Compute Shaders: A Complete Guide

## Introduction

Three.js Shading Language (TSL) provides powerful compute shader capabilities that allow you to perform parallel computations on the GPU. This guide demonstrates how to set up, execute, and read results from compute shaders using TSL.

## What are Compute Shaders?

Compute shaders are GPU programs designed for general-purpose parallel computing (GPGPU). Unlike vertex and fragment shaders that are part of the graphics pipeline, compute shaders can perform arbitrary calculations on data. They excel at:

- Data processing on arrays
- Mathematical computations
- Particle simulations  
- Image processing
- Physics calculations

## Basic Setup

### Prerequisites

```javascript
import * as THREE from 'three/webgpu'
import { Fn, instancedArray, instanceIndex } from 'three/tsl'
```

### WebGPU Renderer Initialization

Compute shaders in TSL require the WebGPU renderer:

```javascript
const renderer = new THREE.WebGPURenderer()
await renderer.init()
```

## Core TSL Compute Concepts

### 1. instancedArray - Data Storage

`instancedArray` creates GPU buffers for storing data that can be accessed by compute shaders:

```javascript
const inputBuffer = instancedArray(count, 'float')
const outputBuffer = instancedArray(count, 'float')
```

**Parameters:**
- `count`: Number of elements in the array
- `type`: Data type ('float', 'int', 'vec3', etc.)

### 2. instanceIndex - Array Indexing

`instanceIndex` provides the current index when iterating through array elements in parallel. Each compute thread gets a unique index:

```javascript
const input = inputBuffer.element(instanceIndex)  // Access element at current index
```

### 3. Fn() - TSL Functions

`Fn()` creates TSL functions that can be executed as compute shaders:

```javascript
const computeFunction = Fn(() => {
  // Compute logic here
})()
```

## Complete Working Example

Here's our working compute shader that multiplies an array of numbers by 2:

```javascript
async function initComputeShader() {
  // Initialize WebGPU renderer
  const renderer = new THREE.WebGPURenderer()
  await renderer.init()
  
  // Create buffers for 10 float values
  const count = 10
  const inputBuffer = instancedArray(count, 'float')
  const outputBuffer = instancedArray(count, 'float')
  
  // Initialize input data: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const initCompute = Fn(() => {
    const input = inputBuffer.element(instanceIndex)
    input.assign(instanceIndex.add(1).toFloat()) // Convert index to 1-based
  })()
  
  // Main computation: multiply each value by 2
  const multiplyCompute = Fn(() => {
    const input = inputBuffer.element(instanceIndex)
    const output = outputBuffer.element(instanceIndex)
    output.assign(input.mul(2)) // output = input * 2
  })()
  
  // Execute compute shaders
  await renderer.computeAsync(initCompute.compute(count))
  await renderer.computeAsync(multiplyCompute.compute(count))
  
  // Read results back to CPU
  const inputArray = await renderer.getArrayBufferAsync(inputBuffer.value)
  const outputArray = await renderer.getArrayBufferAsync(outputBuffer.value)
  
  console.log('Input values:', Array.from(new Float32Array(inputArray)))
  // Output: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  
  console.log('Output values (input * 2):', Array.from(new Float32Array(outputArray)))
  // Output: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]
}
```

## Step-by-Step Breakdown

### Step 1: Buffer Creation
```javascript
const inputBuffer = instancedArray(count, 'float')
const outputBuffer = instancedArray(count, 'float')
```
Creates two GPU buffers, each storing `count` float values.

### Step 2: Data Initialization
```javascript
const initCompute = Fn(() => {
  const input = inputBuffer.element(instanceIndex)
  input.assign(instanceIndex.add(1).toFloat())
})()
```
**What happens:**
- `instanceIndex` gives each thread its unique index (0, 1, 2, ...)
- `.add(1)` converts to 1-based indexing (1, 2, 3, ...)
- `.toFloat()` ensures proper type conversion
- `.assign()` stores the value in the buffer

### Step 3: Main Computation
```javascript
const multiplyCompute = Fn(() => {
  const input = inputBuffer.element(instanceIndex)
  const output = outputBuffer.element(instanceIndex)
  output.assign(input.mul(2))
})()
```
**What happens:**
- Each thread reads its corresponding input value
- Multiplies by 2 using `.mul(2)`
- Stores result in the output buffer

### Step 4: Execution
```javascript
await renderer.computeAsync(initCompute.compute(count))
await renderer.computeAsync(multiplyCompute.compute(count))
```
**Key points:**
- `.compute(count)` creates a compute pass with `count` threads
- Each thread runs in parallel
- `computeAsync()` executes asynchronously on GPU

### Step 5: Reading Results
```javascript
const inputArray = await renderer.getArrayBufferAsync(inputBuffer.value)
const outputArray = await renderer.getArrayBufferAsync(outputBuffer.value)
```
Transfers data from GPU memory back to CPU for inspection.

## TSL vs Traditional GLSL Compute

### Traditional GLSL Approach:
```glsl
#version 450

layout(local_size_x = 1, local_size_y = 1, local_size_z = 1) in;

layout(set = 0, binding = 0, std430) restrict readonly buffer InputBuffer {
    float input_data[];
};

layout(set = 0, binding = 1, std430) restrict writeonly buffer OutputBuffer {
    float output_data[];
};

void main() {
    uint index = gl_GlobalInvocationID.x;
    output_data[index] = input_data[index] * 2.0;
}
```

### TSL Equivalent:
```javascript
const computeFunction = Fn(() => {
  const input = inputBuffer.element(instanceIndex)
  const output = outputBuffer.element(instanceIndex)
  output.assign(input.mul(2))
})()
```

**TSL Advantages:**
- No manual buffer binding setup
- Automatic type conversions
- JavaScript integration
- Cross-platform (WebGL/WebGPU)
- Better error handling

## Advanced Concepts

### Variable Management
```javascript
// Create reusable variables
const scaleFactor = float(2).toVar()
output.assign(input.mul(scaleFactor))
```

### Conditional Logic
```javascript
const conditionalCompute = Fn(() => {
  const input = inputBuffer.element(instanceIndex)
  const output = outputBuffer.element(instanceIndex)
  
  If(input.greaterThan(5), () => {
    output.assign(input.mul(2))
  }).Else(() => {
    output.assign(input)
  })
})()
```

### Working with Vector Data
```javascript
const positionBuffer = instancedArray(count, 'vec3')
const velocityBuffer = instancedArray(count, 'vec3')

const updatePositions = Fn(() => {
  const position = positionBuffer.element(instanceIndex)
  const velocity = velocityBuffer.element(instanceIndex)
  
  // position += velocity * deltaTime
  position.addAssign(velocity.mul(deltaTime))
})()
```

## Performance Considerations

1. **Buffer Size**: Larger buffers benefit more from parallelization
2. **Memory Access**: Sequential access patterns are more efficient
3. **Thread Count**: Should match your data size
4. **Data Types**: Use appropriate precision (float vs int)

## Common Use Cases

- **Particle Systems**: Update positions, velocities, physics
- **Image Processing**: Filters, convolutions, transformations  
- **Mathematical Operations**: Matrix multiplication, FFT
- **Simulation**: Fluid dynamics, cloth simulation
- **Data Processing**: Sorting, searching, aggregation

## Debugging Tips

1. **Start Simple**: Begin with basic operations like our example
2. **Log Buffer Contents**: Use `getArrayBufferAsync()` to inspect data
3. **Check Buffer Sizes**: Ensure input/output buffers match your data
4. **Validate Types**: TSL provides automatic conversions but be explicit

## Conclusion

TSL compute shaders provide a powerful, JavaScript-native way to leverage GPU parallel processing. The abstraction layer simplifies traditional GPU programming while maintaining performance and flexibility. Start with simple examples like this one and gradually build up to more complex computations.

## Resources

- [TSL Documentation](https://github.com/mrdoob/three.js/wiki/Three.js-Shading-Language)
- [WebGPU Compute Shaders](https://www.w3.org/TR/webgpu/#compute-shaders)
- [Three.js Examples](https://threejs.org/examples/)