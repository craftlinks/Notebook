/**
 * @fileoverview Main application controller for the particle simulation
 */

import { SystemManager } from './SystemManager.js';
import { PerformanceMonitor } from './PerformanceMonitor.js';
import { ParticleSimulation } from './ParticleSimulation.js';
import { Renderer } from './Renderer.js';
import { MAX_FORCE_RADIUS } from './Types.js';

/**
 * Main application controller
 */
export class Application {
    constructor() {
        // Core WebGPU objects
        /** @type {HTMLCanvasElement} */
        this.canvas = null;
        /** @type {GPUCanvasContext} */
        this.context = null;
        /** @type {GPUTextureFormat} */
        this.surfaceFormat = null;
        /** @type {GPUDevice} */
        this.device = null;

        // Core simulation components
        /** @type {Renderer} */
        this.renderer = null;
        /** @type {ParticleSimulation} */
        this.simulation = null;
        /** @type {SystemManager} */
        this.systemManager = new SystemManager();
        /** @type {PerformanceMonitor} */
        this.performanceMonitor = new PerformanceMonitor();

        // Application state
        /** @type {SystemDescription} */
        this.currentSystemDescription = null;
        this.lastFrameTimestamp = window.performance.now() / 1000.0;
        this.frameID = 0;
        this.framesInFlight = 0;
        this.paused = false;

        // Simulation parameters
        this.particleCount = 65536;
        this.speciesCount = 8;
        this.simulationBox = [[-512, 512], [-288, 288]];
        this.friction = 10.0;
        this.centralForce = 0.0;
        this.symmetricForces = false;
        this.loopingBorders = false;
        this.customRules = false;

        // Bind methods to preserve 'this' context
        this.redraw = this.redraw.bind(this);
        this.resize = this.resize.bind(this);
    }

    /**
     * Initialize the application
     * @returns {Promise<void>} Initialization promise
     */
    async initialize() {
        this.canvas = document.getElementById("mainCanvas");
        
        // Initialize UI if available
        if (typeof UI !== 'undefined') {
            UI.initializeUI();
        }

        if (!navigator || !navigator.gpu) {
            alert("Your browser doesn't support WebGPU");
            return;
        }

        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) {
            alert("Your browser doesn't support WebGPU (failed to create adapter)");
            return;
        }

        this.performanceMonitor.initialize(adapter);

        this.device = await adapter.requestDevice({
            requiredFeatures: this.performanceMonitor.timestampQuerySupported ? ['timestamp-query'] : [],
        });

        if (!this.device) {
            alert("Your browser doesn't support WebGPU (failed to create device)");
            return;
        }

        this.context = this.canvas.getContext('webgpu');
        this.surfaceFormat = navigator.gpu.getPreferredCanvasFormat();
        this.context.configure({
            device: this.device,
            format: this.surfaceFormat,
        });

        // Initialize core components
        this.simulation = new ParticleSimulation(this.device);
        
        // Load initial system
        await this.loadSystem(this.systemManager.createInitialSystem());
        
        // Initialize renderer
        this.renderer = new Renderer(this.device, this.context, this.canvas);
        await this.renderer.initialize(this.simulation.getParticleBindGroupLayout());
        
        this.resize();
        this.renderer.centerView(this.simulationBox);

        // Start render loop
        this.redraw();

        // Set up event handlers
        window.onresize = this.resize;
    }

    /**
     * Main render loop
     */
    redraw() {
        if (this.framesInFlight > 3) {
            requestAnimationFrame(this.redraw);
            return;
        }

        const now = window.performance.now() / 1000.0;
        const dt = now - this.lastFrameTimestamp;
        this.lastFrameTimestamp = now;

        const uiState = (typeof UI !== 'undefined') ? UI.getActionState() : { actionPoint: null, actionDrag: null, zoomAnchor: null };
        
        // Update camera using Renderer
        const pixelsPerUnit = this.renderer.updateCameraSmooth(dt, uiState);
        if (typeof UI !== 'undefined') {
            UI.updatePanelVisibility(dt);
        }

        // Prepare simulation parameters
        const simulationParams = this.createSimulationParams(dt, uiState);

        // Get performance monitoring helper
        const queryHelper = this.performanceMonitor.getQueryHelper(this.device);
     
        const encoder = this.device.createCommandEncoder({});

        if (!this.paused) {
            // Run simulation step
            this.simulation.step(encoder, simulationParams, queryHelper);
        }
     
        // Render using the Renderer class
        const particleBindGroup = this.simulation.getParticleBindGroupForRendering();
        this.renderer.render(encoder, particleBindGroup, this.particleCount, pixelsPerUnit, queryHelper);

        // Resolve performance queries
        if (queryHelper) {
            encoder.resolveQuerySet(queryHelper.querySet, 0, queryHelper.querySet.count, queryHelper.resolveBuffer, 0);
            encoder.copyBufferToBuffer(queryHelper.resolveBuffer, 0, queryHelper.readBuffer, 0, queryHelper.resolveBuffer.size);
        }
     
        const commandBuffer = encoder.finish();
        this.device.queue.submit([commandBuffer]);

        // Process performance results
        if (queryHelper) {
            this.performanceMonitor.processQueryResults(queryHelper, this.paused);
        }

        ++this.framesInFlight;
        this.device.queue.onSubmittedWorkDone().then(() => { --this.framesInFlight; });
        ++this.frameID;

        requestAnimationFrame(this.redraw);
    }

    /**
     * Create simulation parameters for current frame
     * @param {number} dt - Delta time
     * @param {Object} uiState - UI interaction state
     * @returns {Object} Simulation parameters
     */
    createSimulationParams(dt, uiState) {
        const simDt = Math.min(0.025, dt);
        const frictionFactor = Math.exp(-simDt * this.friction);
        
        const actionX = uiState.actionPoint ? 
            this.renderer.cameraCenter[0] + this.renderer.cameraExtentX * (2.0 * uiState.actionPoint[0] / this.canvas.width - 1.0) : 0.0;
        const actionY = uiState.actionPoint ? 
            this.renderer.cameraCenter[1] + this.renderer.cameraExtentY * (1.0 - 2.0 * uiState.actionPoint[1] / this.canvas.height) : 0.0;
        const actionVX = uiState.actionDrag ? 
            this.renderer.cameraExtentX * (2.0 * uiState.actionDrag[0] / this.canvas.width) : 0.0;
        const actionVY = uiState.actionDrag ? 
            this.renderer.cameraExtentY * (-2.0 * uiState.actionDrag[1] / this.canvas.height) : 0.0;
        const actionForce = uiState.actionPoint ? 20.0 : 0.0;
        const actionRadius = this.renderer.cameraExtentX / 16.0;

        if (typeof UI !== 'undefined') {
            UI.clearActionDrag();
        }

        return {
            left: this.simulationBox[0][0],
            right: this.simulationBox[0][1], 
            bottom: this.simulationBox[1][0],
            top: this.simulationBox[1][1],
            friction: frictionFactor,
            dt: simDt,
            binSize: MAX_FORCE_RADIUS,
            speciesCount: this.speciesCount,
            centralForce: this.centralForce,
            loopingBorders: this.loopingBorders,
            actionX: actionX,
            actionY: actionY,
            actionVX: actionVX,
            actionVY: actionVY,
            actionForce: actionForce,
            actionRadius: actionRadius
        };
    }

    /**
     * Load a new system configuration
     * @param {SystemDescription} systemDescription - System description to load
     */
    async loadSystem(systemDescription) {
        this.currentSystemDescription = systemDescription;

        // Validate and set defaults
        this.systemManager.validateSystemDescription(systemDescription);

        // Update global state
        this.particleCount = systemDescription.particleCount;
        this.speciesCount = systemDescription.species.length;
        this.friction = systemDescription.friction;
        this.centralForce = systemDescription.centralForce;
        this.symmetricForces = systemDescription.symmetricForces;
        this.loopingBorders = systemDescription.loopingBorders;
        this.customRules = false;

        // Update simulation box
        this.simulationBox = this.systemManager.calculateSimulationBox(systemDescription.simulationSize);

        // Update UI
        if (typeof UI !== 'undefined') {
            UI.updateUIElements();
        }

        // Initialize simulation with new system
        await this.simulation.initialize(systemDescription);
    }

    /**
     * Reload forces for current system
     * @param {SystemDescription} systemDescription - System description with force data
     */
    reloadForces(systemDescription) {
        this.simulation.updateForces(systemDescription);
    }

    /**
     * Handle window resize
     */
    resize() {
        if (!this.canvas) return;
        
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;

        if (this.renderer) {
            this.renderer.resize();
        }
    }

    /**
     * Toggle pause state
     */
    togglePause() {
        this.paused = !this.paused;
    }

    /**
     * Get current pause state
     * @returns {boolean} Whether the simulation is paused
     */
    isPaused() {
        return this.paused;
    }

    /**
     * Center the view on the simulation area
     */
    centerView() {
        if (this.renderer) {
            this.renderer.centerView(this.simulationBox);
        }
    }

    /**
     * Generate a new random system
     */
    randomizeSystem() {
        this.currentSystemDescription.seed = randomSeed();
        this.loadSystem(this.systemManager.generateSystem(this.currentSystemDescription));
    }

    /**
     * Restart with current system
     */
    restartSystem() {
        this.loadSystem(this.currentSystemDescription);
    }
} 