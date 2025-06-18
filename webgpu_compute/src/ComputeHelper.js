/**
 * Helper class to simplify WebGPU compute operations
 */
export class ComputeHelper {
    /**
     * @param {GPUDevice} device 
     */
    constructor(device) {
        this.device = device;
        this.pipelines = new Map();
        this.bindGroupLayouts = new Map();
        this.buffers = new Map();
        this.bindGroups = new Map();
    }

    /**
     * Create a buffer with automatic sizing
     * @param {string} name - Buffer identifier
     * @param {number} elementSize - Size per element in bytes
     * @param {number} elementCount - Number of elements
     * @param {number} usage - GPUBufferUsage flags
     * @param {ArrayBuffer} [initialData] - Optional initial data
     */
    createBuffer(name, elementSize, elementCount, usage, initialData = null) {
        const size = elementSize * elementCount;
        const buffer = this.device.createBuffer({ size, usage });
        
        if (initialData) {
            this.device.queue.writeBuffer(buffer, 0, initialData);
        }
        
        this.buffers.set(name, buffer);
        return buffer;
    }

    /**
     * Create a compute pipeline from shader code
     * @param {string} name - Pipeline identifier
     * @param {string} shaderCode - WGSL shader code
     * @param {string} entryPoint - Entry point function name
     * @param {string[]} bindGroupLayoutNames - Names of bind group layouts to use
     */
    createComputePipeline(name, shaderCode, entryPoint, bindGroupLayoutNames) {
        const module = this.device.createShaderModule({ code: shaderCode });
        const layouts = bindGroupLayoutNames.map(name => this.bindGroupLayouts.get(name));
        
        const pipeline = this.device.createComputePipeline({
            layout: this.device.createPipelineLayout({ bindGroupLayouts: layouts }),
            compute: { module, entryPoint }
        });
        
        this.pipelines.set(name, pipeline);
        return pipeline;
    }

    /**
     * Create a bind group layout
     * @param {string} name - Layout identifier  
     * @param {Object[]} entries - Bind group layout entries
     */
    createBindGroupLayout(name, entries) {
        const layout = this.device.createBindGroupLayout({ entries });
        this.bindGroupLayouts.set(name, layout);
        return layout;
    }

    /**
     * Create a bind group
     * @param {string} name - Bind group identifier
     * @param {string} layoutName - Name of the layout to use
     * @param {Object[]} entries - Bind group entries
     */
    createBindGroup(name, layoutName, entries) {
        const layout = this.bindGroupLayouts.get(layoutName);
        const bindGroup = this.device.createBindGroup({ layout, entries });
        this.bindGroups.set(name, bindGroup);
        return bindGroup;
    }

    /**
     * Execute a compute pass
     * @param {GPUCommandEncoder} encoder
     * @param {Object} passConfig - Configuration for the compute pass
     */
    executeComputePass(encoder, passConfig) {
        const computePass = encoder.beginComputePass(passConfig.timestampWrites ? 
            { timestampWrites: passConfig.timestampWrites } : {});

        for (const step of passConfig.steps) {
            computePass.setPipeline(this.pipelines.get(step.pipeline));
            
            step.bindGroups?.forEach((bindGroupName, index) => {
                const bindGroup = this.bindGroups.get(bindGroupName);
                const dynamicOffsets = step.dynamicOffsets?.[index] || [];
                computePass.setBindGroup(index, bindGroup, dynamicOffsets);
            });
            
            computePass.dispatchWorkgroups(step.workgroups);
        }

        computePass.end();
    }

    /**
     * Get buffer by name
     * @param {string} name 
     * @returns {GPUBuffer}
     */
    getBuffer(name) {
        return this.buffers.get(name);
    }

    /**
     * Get pipeline by name
     * @param {string} name 
     * @returns {GPUComputePipeline}
     */
    getPipeline(name) {
        return this.pipelines.get(name);
    }

    /**
     * Get bind group by name
     * @param {string} name 
     * @returns {GPUBindGroup}
     */
    getBindGroup(name) {
        return this.bindGroups.get(name);
    }

    /**
     * Update buffer data
     * @param {string} name - Buffer name
     * @param {ArrayBuffer} data - New data
     * @param {number} [offset=0] - Byte offset
     */
    updateBuffer(name, data, offset = 0) {
        const buffer = this.buffers.get(name);
        this.device.queue.writeBuffer(buffer, offset, data);
    }

    /**
     * Get bind group layout by name
     * @param {string} name 
     * @returns {GPUBindGroupLayout}
     */
    getBindGroupLayout(name) {
        return this.bindGroupLayouts.get(name);
    }
} 