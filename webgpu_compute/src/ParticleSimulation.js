/**
 * Particle Life Simulation using WebGPU compute shaders
 * Abstracts away WebGPU boilerplate to focus on simulation logic
 */

import { ComputeHelper } from './ComputeHelper.js';
import { ShaderLoader } from './ShaderLoader.js';
import { INITIAL_VELOCITY } from './Types.js';

export class ParticleSimulation {
    /**
     * @param {GPUDevice} device 
     * @param {Object} config - Simulation configuration
     */
    constructor(device, config) {
        this.device = device;
        this.config = config;
        this.compute = new ComputeHelper(device);
        this.shaderLoader = new ShaderLoader();
        this.initialized = false;
        
        // Simulation state
        this.particleCount = 0;
        this.speciesCount = 0;
        this.gridSize = [0, 0];
        this.binCount = 0;
        this.prefixSumIterations = 0;
        
        // Cached shader sources
        this.shaderSources = null;
    }

    /**
     * Initialize the simulation with given parameters
     * @param {SystemDescription} systemDescription 
     */
    async initialize(systemDescription) {
        this.particleCount = systemDescription.particleCount;
        this.speciesCount = systemDescription.species.length;
        
        // Calculate grid parameters
        const simWidth = systemDescription.simulationSize[0];
        const simHeight = systemDescription.simulationSize[1];
        const maxForceRadius = 32.0; // Should be configurable
        
        this.gridSize = [
            Math.ceil(simWidth / maxForceRadius), 
            Math.ceil(simHeight / maxForceRadius)
        ];
        this.binCount = this.gridSize[0] * this.gridSize[1];
        this.prefixSumIterations = Math.ceil(Math.ceil(Math.log2(this.binCount + 1)) / 2) * 2;

        // Load shader sources
        if (!this.shaderSources) {
            this.shaderSources = await this.shaderLoader.loadParticleSimulationShaders();
        }

        // Create buffers
        this.createBuffers(systemDescription);
        
        // Create bind group layouts
        this.createBindGroupLayouts();
        
        // Create pipelines
        this.createPipelines();
        
        // Create bind groups
        this.createBindGroups();
        
        this.initialized = true;
    }

    /**
     * Create all required buffers
     */
    createBuffers(systemDescription) {
        // Particle data (x, y, vx, vy, species)
        const particleData = this.generateInitialParticles(systemDescription);
        this.compute.createBuffer('particles', 20, this.particleCount, 
            GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
            particleData);
        
        this.compute.createBuffer('particlesTemp', 20, this.particleCount, 
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);

        // Species colors
        const speciesData = this.generateSpeciesData(systemDescription);
        this.compute.createBuffer('species', 16, this.speciesCount,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE, speciesData);

        // Force matrix
        const forceData = this.generateForceData(systemDescription);
        this.compute.createBuffer('forces', 16, this.speciesCount * this.speciesCount,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE, forceData);

        // Spatial binning buffers
        this.compute.createBuffer('binOffset', 4, this.binCount + 1,
            GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
        
        this.compute.createBuffer('binOffsetTemp', 4, this.binCount + 1,
            GPUBufferUsage.STORAGE);

        // Simulation parameters
        this.compute.createBuffer('simulationOptions', 64, 1,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM);

        // Prefix sum step sizes
        const stepSizeData = this.generatePrefixSumStepSizes();
        this.compute.createBuffer('prefixSumStepSize', 256, this.prefixSumIterations,
            GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM, stepSizeData);
    }

    /**
     * Create bind group layouts with simplified configuration
     */
    createBindGroupLayouts() {
        // Particles (read-write)
        this.compute.createBindGroupLayout('particlesRW', [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }
        ]);

        // Particles (read-only)
        this.compute.createBindGroupLayout('particlesRO', [
            { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }
        ]);

        // Simulation options
        this.compute.createBindGroupLayout('simulationOptions', [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }
        ]);

        // Spatial binning
        this.compute.createBindGroupLayout('binning', [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
        ]);

        // Prefix sum
        this.compute.createBindGroupLayout('prefixSum', [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } }
        ]);

        // Particle sorting
        this.compute.createBindGroupLayout('particleSort', [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
        ]);

        // Force computation
        this.compute.createBindGroupLayout('forceComputation', [
            { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
            { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
            { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } }
        ]);
    }

    /**
     * Create compute pipelines
     */
    createPipelines() {
        this.compute.createComputePipeline('binClearSize', this.shaderSources.binning, 'clearBinSize',
            ['particlesRO', 'simulationOptions', 'binning']);
        
        this.compute.createComputePipeline('binFillSize', this.shaderSources.binning, 'fillBinSize',
            ['particlesRO', 'simulationOptions', 'binning']);
        
        this.compute.createComputePipeline('prefixSum', this.shaderSources.prefixSum, 'prefixSumStep',
            ['prefixSum']);
        
        this.compute.createComputePipeline('sortClearSize', this.shaderSources.particleSort, 'clearBinSize',
            ['particleSort', 'simulationOptions']);
        
        this.compute.createComputePipeline('sortParticles', this.shaderSources.particleSort, 'sortParticles',
            ['particleSort', 'simulationOptions']);
        
        this.compute.createComputePipeline('computeForces', this.shaderSources.computeForces, 'computeForces',
            ['forceComputation', 'simulationOptions']);
        
        this.compute.createComputePipeline('advanceParticles', this.shaderSources.particleAdvance, 'particleAdvance',
            ['particlesRW', 'simulationOptions']);
    }

    /**
     * Create bind groups
     */
    createBindGroups() {
        // Particles bind groups
        this.compute.createBindGroup('particlesRW', 'particlesRW', [
            { binding: 0, resource: { buffer: this.compute.getBuffer('particles') } },
            { binding: 1, resource: { buffer: this.compute.getBuffer('forces') } }
        ]);

        this.compute.createBindGroup('particlesRO', 'particlesRO', [
            { binding: 0, resource: { buffer: this.compute.getBuffer('particles') } },
            { binding: 1, resource: { buffer: this.compute.getBuffer('species') } }
        ]);

        // Simulation options
        this.compute.createBindGroup('simulationOptions', 'simulationOptions', [
            { binding: 0, resource: { buffer: this.compute.getBuffer('simulationOptions') } }
        ]);

        // Binning
        this.compute.createBindGroup('binning', 'binning', [
            { binding: 0, resource: { buffer: this.compute.getBuffer('binOffset') } }
        ]);

        // Prefix sum (create two for ping-pong)
        this.compute.createBindGroup('prefixSum0', 'prefixSum', [
            { binding: 0, resource: { buffer: this.compute.getBuffer('binOffset') } },
            { binding: 1, resource: { buffer: this.compute.getBuffer('binOffsetTemp') } },
            { binding: 2, resource: { buffer: this.compute.getBuffer('prefixSumStepSize'), size: 4 } }
        ]);

        this.compute.createBindGroup('prefixSum1', 'prefixSum', [
            { binding: 0, resource: { buffer: this.compute.getBuffer('binOffsetTemp') } },
            { binding: 1, resource: { buffer: this.compute.getBuffer('binOffset') } },
            { binding: 2, resource: { buffer: this.compute.getBuffer('prefixSumStepSize'), size: 4 } }
        ]);

        // Particle sorting
        this.compute.createBindGroup('particleSort', 'particleSort', [
            { binding: 0, resource: { buffer: this.compute.getBuffer('particles') } },
            { binding: 1, resource: { buffer: this.compute.getBuffer('particlesTemp') } },
            { binding: 2, resource: { buffer: this.compute.getBuffer('binOffset') } },
            { binding: 3, resource: { buffer: this.compute.getBuffer('binOffsetTemp') } }
        ]);

        // Force computation
        this.compute.createBindGroup('forceComputation', 'forceComputation', [
            { binding: 0, resource: { buffer: this.compute.getBuffer('particlesTemp') } },
            { binding: 1, resource: { buffer: this.compute.getBuffer('particles') } },
            { binding: 2, resource: { buffer: this.compute.getBuffer('binOffset') } },
            { binding: 3, resource: { buffer: this.compute.getBuffer('forces') } }
        ]);
    }

    /**
     * Run one simulation step
     * @param {GPUCommandEncoder} encoder 
     * @param {Object} simulationParams - Current simulation parameters
     * @param {Object} [queryHelper] - Optional timestamp query helper
     */
    step(encoder, simulationParams, queryHelper) {
        if (!this.initialized) return;

        // Update simulation parameters
        this.updateSimulationParams(simulationParams);

        // Copy particles to temp buffer
        encoder.copyBufferToBuffer(
            this.compute.getBuffer('particles'), 0,
            this.compute.getBuffer('particlesTemp'), 0,
            this.compute.getBuffer('particles').size
        );

        // Spatial binning phase
        this.compute.executeComputePass(encoder, {
            timestampWrites: queryHelper?.next(),
            steps: [
                {
                    pipeline: 'binClearSize',
                    bindGroups: ['particlesRO', 'simulationOptions', 'binning'],
                    workgroups: Math.ceil((this.binCount + 1) / 64)
                },
                {
                    pipeline: 'binFillSize',
                    bindGroups: ['particlesRO', 'simulationOptions', 'binning'],
                    workgroups: Math.ceil(this.particleCount / 64)
                },
                ...this.generatePrefixSumSteps(),
                {
                    pipeline: 'sortClearSize',
                    bindGroups: ['particleSort'],
                    workgroups: Math.ceil((this.binCount + 1) / 64)
                },
                {
                    pipeline: 'sortParticles',
                    bindGroups: ['particleSort'],
                    workgroups: Math.ceil(this.particleCount / 64)
                }
            ]
        });

        // Force computation phase
        this.compute.executeComputePass(encoder, {
            timestampWrites: queryHelper?.next(),
            steps: [
                {
                    pipeline: 'computeForces',
                    bindGroups: ['forceComputation', 'simulationOptions'],
                    workgroups: Math.ceil(this.particleCount / 64)
                }
            ]
        });

        // Particle advancement phase
        this.compute.executeComputePass(encoder, {
            timestampWrites: queryHelper?.next(),
            steps: [
                {
                    pipeline: 'advanceParticles',
                    bindGroups: ['particlesRW', 'simulationOptions'],
                    workgroups: Math.ceil(this.particleCount / 64)
                }
            ]
        });
    }

    /**
     * Generate prefix sum computation steps
     */
    generatePrefixSumSteps() {
        const steps = [];
        for (let i = 0; i < this.prefixSumIterations; i++) {
            steps.push({
                pipeline: 'prefixSum',
                bindGroups: [i % 2 === 0 ? 'prefixSum0' : 'prefixSum1'],
                dynamicOffsets: [[i * 256]],
                workgroups: Math.ceil((this.binCount + 1) / 64)
            });
        }
        return steps;
    }

    /**
     * Update simulation parameters buffer
     */
    updateSimulationParams(params) {
        const data = new Float32Array([
            params.left, params.right, params.bottom, params.top,
            params.friction, params.dt, params.binSize, params.speciesCount,
            params.centralForce, params.loopingBorders ? 1.0 : 0.0,
            params.actionX, params.actionY, params.actionVX, params.actionVY,
            params.actionForce, params.actionRadius
        ]);
        this.compute.updateBuffer('simulationOptions', data);
    }

    /**
     * Get the particles buffer for rendering
     */
    getParticlesBuffer() {
        return this.compute.getBuffer('particles');
    }

    /**
     * Get the species buffer for rendering
     */
    getSpeciesBuffer() {
        return this.compute.getBuffer('species');
    }

    /**
     * Get particle bind group for rendering
     */
    getParticleBindGroupForRendering() {
        return this.compute.getBindGroup('particlesRO');
    }

    /**
     * Get particle bind group layout for renderer initialization
     */
    getParticleBindGroupLayout() {
        return this.compute.getBindGroupLayout('particlesRO');
    }

    /**
     * Update forces when system changes
     */
    updateForces(systemDescription) {
        const forceData = this.generateForceData(systemDescription);
        this.compute.updateBuffer('forces', forceData);
    }

    // Helper methods for data generation
    generateInitialParticles(systemDescription) {
        const data = new Float32Array(this.particleCount * 5);
        const initialVelocity = 10.0;
        
        // Set default spawn weights if not provided
        for (let i = 0; i < this.speciesCount; i++) {
            if (systemDescription.species[i].spawnWeight == undefined) {
                systemDescription.species[i].spawnWeight = 1.0;
            }
        }

        // Calculate total spawn weight
        let speciesWeightSum = 0.0;
        for (let i = 0; i < this.speciesCount; i++) {
            speciesWeightSum += systemDescription.species[i].spawnWeight;
        }

        // Generate particles
        const simulationWidth = systemDescription.simulationSize[0];
        const simulationHeight = systemDescription.simulationSize[1]; 
        const left = -simulationWidth / 2;
        const right = simulationWidth / 2;
        const bottom = -simulationHeight / 2;
        const top = simulationHeight / 2;

        for (let i = 0; i < this.particleCount; i++) {
            // Choose species based on spawn weights
            let speciesPick = Math.random() * speciesWeightSum;
            let speciesId = this.speciesCount - 1;
            
            for (let j = 0; j < this.speciesCount; j++) {
                if (speciesPick < systemDescription.species[j].spawnWeight) {
                    speciesId = j;
                    break;  
                }
                speciesPick -= systemDescription.species[j].spawnWeight;
            }

            // Set particle data (x, y, vx, vy, species)
            data[i * 5 + 0] = left + Math.random() * (right - left);
            data[i * 5 + 1] = bottom + Math.random() * (top - bottom);
            data[i * 5 + 2] = INITIAL_VELOCITY * (-1.0 + Math.random() * 2.0);
            data[i * 5 + 3] = INITIAL_VELOCITY * (-1.0 + Math.random() * 2.0);
            data[i * 5 + 4] = speciesId;
        }
        
        return data;
    }

    generateSpeciesData(systemDescription) {
        const data = new Float32Array(this.speciesCount * 4);
        for (let i = 0; i < this.speciesCount; i++) {
            data[i * 4 + 0] = systemDescription.species[i].color[0];
            data[i * 4 + 1] = systemDescription.species[i].color[1];
            data[i * 4 + 2] = systemDescription.species[i].color[2];
            data[i * 4 + 3] = 1.0;
        }
        return data;
    }

    generateForceData(systemDescription) {
        const data = new Float32Array(this.speciesCount * this.speciesCount * 4);
        for (let i = 0; i < this.speciesCount; i++) {
            for (let j = 0; j < this.speciesCount; j++) {
                const idx = i * this.speciesCount + j;
                data[idx * 4 + 0] = systemDescription.species[i].forces[j].strength;
                data[idx * 4 + 1] = systemDescription.species[i].forces[j].radius;
                data[idx * 4 + 2] = Math.abs(systemDescription.species[i].forces[j].collisionStrength);
                data[idx * 4 + 3] = systemDescription.species[i].forces[j].collisionRadius;
            }
        }
        return data;
    }

    generatePrefixSumStepSizes() {
        const data = new Uint32Array(this.prefixSumIterations * 64);
        for (let i = 0; i < this.prefixSumIterations; i++) {
            data[i * 64] = Math.pow(2, i);
        }
        return data;
    }

    /**
     * Get shader loading statistics
     */
    getShaderInfo() {
        return {
            loaded: !!this.shaderSources,
            cacheInfo: this.shaderLoader.getCacheInfo(),
            availableShaders: this.shaderSources ? Object.keys(this.shaderSources) : []
        };
    }
} 