import * as THREE from 'three/webgpu';
import { 
    float, 
    vec2, 
    vec3,
    vec4, 
    Fn, 
    instanceIndex, 
    instancedArray,
    sin,
    length,
    hash,
    mix,
    color,
    uint,
    mod,
    mul,
    atan,
    If,
    select,
    floor,
    max,
    min,
    Loop,
    uniform
} from 'three/tsl';
import type { EquationSystem } from './parser';
import { loadEquationSystem } from './parser';
import type { GeneratedTSL, UIUniforms } from './tsl_generator';
import { generateTSL } from './tsl_generator';
import { UIManager } from './ui_manager';

/**
 * Simplified Flow Field Visualization System
 * Based on the working TSL example pattern
 */
class FlowFieldSystem {
    private renderer!: THREE.WebGPURenderer;
    private scene!: THREE.Scene;
    private camera!: THREE.OrthographicCamera;
    private aspectUniform!: any;
    
    private particleCount = 32768; // Reduce for debugging
    private gridSize = 32;
    private trailLength = 16; // Reduce for debugging
    private timeUniform!: any;
    
    // Grid properties
    /*
    private gridResolution = 64; // Increased from 32
    private gridCount = this.gridResolution * this.gridResolution;
    private gridPositionBuffer!: any;
    private gridVectorBuffer!: any;
    private gridMesh!: THREE.InstancedMesh;
    private gridUpdateCompute!: any;
    */
    
    // Particle properties
    private positionBuffer!: any;
    private velocityBuffer!: any;
    private lifeBuffer!: any;
    private resetFlagBuffer!: any;
    private fadeTimerBuffer!: any; // Timer for trail fading when particle resets
    private updateCompute!: any;
    
    // Dynamically generated equation system
    private equationSystem!: EquationSystem;
    private tslSystem!: GeneratedTSL;
    private uiUniforms!: UIUniforms;
    private uiManager!: UIManager;
    
    // Trail system
    private trailPositionsBuffer!: any; // Ring buffer: [particleCount * trailLength * 2] (x,y positions)
    private trailMetaBuffer!: any; // [particleCount * 2] (head_index, length)
    private trailUpdateCompute!: any;
    private trailPointUpdateCompute!: any;
    private trailMesh!: THREE.InstancedMesh;
    
    constructor(canvas: HTMLCanvasElement) {
        // Create the UI Manager
        this.uiManager = new UIManager();
        this.init(canvas);
    }
    
    private async init(canvas: HTMLCanvasElement): Promise<void> {
        await this.initRenderer(canvas);
        this.initScene();

        this.timeUniform = uniform(0.0);
        
        // Initial particle buffer creation (only needs to happen once)
        this.positionBuffer = instancedArray(this.particleCount, 'vec2');
        this.velocityBuffer = instancedArray(this.particleCount, 'vec2');
        this.lifeBuffer = instancedArray(this.particleCount, 'vec2');
        this.resetFlagBuffer = instancedArray(this.particleCount, 'uint');
        this.fadeTimerBuffer = instancedArray(this.particleCount, 'float');

        // Initialize the UI, which will trigger the first system load
        await this.uiManager.initialize(this.loadAndReinitializeSystem.bind(this));
        
        this.initTrailSystem();
    }
    
    private async initRenderer(canvas: HTMLCanvasElement): Promise<void> {
        this.renderer = new THREE.WebGPURenderer({ 
            canvas,
            antialias: true 
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.setClearColor(0x001122);
        
        await this.renderer.init();
    }
    
    private initScene(): void {
        this.scene = new THREE.Scene();
        
        const aspect = window.innerWidth / window.innerHeight;
        this.aspectUniform = uniform(aspect);

        const frustumSize = this.gridSize;
        this.camera = new THREE.OrthographicCamera(
            -frustumSize * aspect / 2, frustumSize * aspect / 2,
            frustumSize / 2, -frustumSize / 2,
            0.1, 1000
        );
        this.camera.position.z = 10;
    }
    
    /**
     * Loads a new equation file, regenerates TSL, and rebuilds the compute shader.
     * This is the core of the dynamic system switching.
     * @param url - The URL of the equation file to load.
     */
    public async loadAndReinitializeSystem(url: string): Promise<void> {
        console.log(`Loading new system from: ${url}`);
        
        // 1. Load, Parse, and Generate
        this.equationSystem = await loadEquationSystem(url);
        
        const normalizedPosition = this.positionBuffer.element(instanceIndex).div(
            vec2(
                float(this.gridSize * 0.5).mul(this.aspectUniform),
                float(this.gridSize * 0.5)
            )
        );

        this.tslSystem = generateTSL(this.equationSystem, normalizedPosition, this.timeUniform);
        this.uiUniforms = this.tslSystem.uniforms;

        // 2. Update the UI with the new system's info
        this.uiManager.createUIForSystem(this.equationSystem, this.uiUniforms);

        // 3. Re-initialize particle state (resets particles to new random positions)
        await this.initParticles();

        console.log("System re-initialization complete.");
    }

    private async initParticles(): Promise<void> {
        // This function now just resets the state of existing buffers.
        // The buffers themselves are created once in init().

        // Generate random seeds at compile time to break index patterns
        const seedLife = Math.floor(Math.random() * 0xffffff);
        const seedAge = Math.floor(Math.random() * 0xffffff);
        
        // Initialize particles
        const init = Fn(() => {
            const position = this.positionBuffer.element(instanceIndex);
            const velocity = this.velocityBuffer.element(instanceIndex);
            const life = this.lifeBuffer.element(instanceIndex);
            
            // Assign random lifetime. This will be used when the particle spawns.
            const maxLife = hash(instanceIndex.mul(uint(109)).add(uint(seedLife))).mul(15).add(3); // 3-18 seconds

            // Assign a random spawn delay
            const spawnDelay = hash(instanceIndex.mul(uint(113)).add(uint(seedAge))).mul(10.0);
            life.assign(vec2(spawnDelay.negate(), maxLife));

            // Start particles off-screen
            position.assign(vec2(-9999, -9999));
            velocity.assign(vec2(0, 0));

            // Initialize reset counter and fade timer
            this.resetFlagBuffer.element(instanceIndex).assign(uint(10));
            this.fadeTimerBuffer.element(instanceIndex).assign(float(0));
        });
        
        const initCompute = init().compute(this.particleCount);
        
        // Rebuild the main update compute shader with the new TSL function
        const update = Fn(() => {
            const position = this.positionBuffer.element(instanceIndex);
            const velocity = this.velocityBuffer.element(instanceIndex);
            const life = this.lifeBuffer.element(instanceIndex);
            const resetCounter = this.resetFlagBuffer.element(instanceIndex);
            const fadeTimer = this.fadeTimerBuffer.element(instanceIndex);
            
            const deltaTime = float(1/60);
            const fadeTime = float(2.0);
            const age = life.x;
            const maxLife = life.y;

            age.addAssign(deltaTime);

            If(age.greaterThanEqual(0), () => {

                const prevAge = age.sub(deltaTime);
                If(prevAge.lessThan(0), () => {
                    const spawnWidth = float(this.gridSize * 0.5).mul(this.aspectUniform);
                    const spawnHeight = float(this.gridSize * 0.5);
                    const spawnSeed = instanceIndex.mul(uint(149)).add(uint(floor(age.mul(1000))));
                    const newPos = vec2(
                        hash(spawnSeed.add(uint(97))).mul(2).sub(1).mul(spawnWidth),
                        hash(spawnSeed.add(uint(103))).mul(2).sub(1).mul(spawnHeight)
                    );
                    position.assign(newPos);
                    velocity.assign(vec2(0, 0));
                    age.assign(0);
                    resetCounter.assign(uint(0));
                });

                resetCounter.assign(resetCounter.add(uint(1)).min(uint(10)));
                
                // DYNAMICALLY GENERATED FLOW FIELD
                const flowVector = this.tslSystem.computeFn();
                const velocityScale = float(this.tslSystem.config?.velocity_scale ?? 1.0);
                const smoothing = float(this.tslSystem.config?.smoothing_factor ?? 0.1);
                const flowVel = flowVector.mul(velocityScale);
                velocity.assign(mix(velocity, flowVel, smoothing));
                position.addAssign(velocity.mul(deltaTime));
                
                // Fading logic...
                If(fadeTimer.greaterThan(0), () => {
                    fadeTimer.addAssign(deltaTime);
                    If(fadeTimer.greaterThanEqual(fadeTime), () => {
                        const resetSeed = instanceIndex.mul(uint(127)).add(uint(floor(fadeTimer.mul(1000)))).add(uint(resetCounter));
                        const spawnWidth = float(this.gridSize * 0.5).mul(this.aspectUniform);
                        const spawnHeight = float(this.gridSize * 0.5);
                        const newPos = vec2(
                            hash(resetSeed.add(uint(31))).mul(2).sub(1).mul(spawnWidth),
                            hash(resetSeed.add(uint(37))).mul(2).sub(1).mul(spawnHeight)
                        );
                        position.assign(newPos);
                        velocity.assign(vec2(0,0));
                        age.assign(0);
                        const newMaxLife = hash(resetSeed.add(uint(41))).mul(15).add(3);
                        life.y.assign(newMaxLife);
                        resetCounter.assign(uint(0));
                        fadeTimer.assign(float(0));
                    });
                }).Else(() => {
                    const halfSizeX = float(this.gridSize * 0.5).mul(this.aspectUniform);
                    const halfSizeY = float(this.gridSize * 0.5);
                    const farOutOfBounds = position.x.abs().greaterThan(halfSizeX.mul(1.2)).or(position.y.abs().greaterThan(halfSizeY.mul(1.2)));
                    const deathThreshold = hash(instanceIndex.mul(uint(139))).mul(0.5).add(0.8);
                    const adjustedMaxLife = maxLife.mul(deathThreshold);
                    const shouldStartFade = age.greaterThan(adjustedMaxLife).or(farOutOfBounds);
                    If(shouldStartFade, () => {
                        fadeTimer.assign(float(0.01));
                    });
                });

            }).Else(() => {
                position.assign(vec2(-9999, -9999));
            });
        });
        
        this.updateCompute = update().compute(this.particleCount);
        
        // Execute the initialization compute shader
        await this.renderer.computeAsync(initCompute);
    }

    // ===========================
    // Trail System (Ring Buffer)
    // ===========================
    private initTrailSystem(): void {
        // Ring buffer for trail positions: [particleCount * trailLength * 2] floats (x,y per position)
        const totalTrailElements = this.particleCount * this.trailLength * 2;
        this.trailPositionsBuffer = instancedArray(totalTrailElements, 'float');
        
        // Meta buffer: [particleCount * 2] -> head_index, current_length
        this.trailMetaBuffer = instancedArray(this.particleCount * 2, 'uint');

        // Initialize trail buffers
        const trailInit = Fn(() => {
            // Initialize all trail positions to (0,0)
            const totalElements = uint(totalTrailElements);
            const idx = instanceIndex;
            
            If(idx.lessThan(totalElements), () => {
                this.trailPositionsBuffer.element(idx).assign(0);
            });
            
            // Initialize meta buffer (head_index=0, length=0 for each particle)
            const metaElements = uint(this.particleCount * 2);
            If(idx.lessThan(metaElements), () => {
                this.trailMetaBuffer.element(idx).assign(uint(0));
            });
        });

        const trailInitCompute = trailInit().compute(Math.max(totalTrailElements, this.particleCount * 2));
        this.renderer.computeAsync(trailInitCompute);

        // Trail update compute - adds current particle position to ring buffer
        const trailUpdate = Fn(() => {
            const particleId = instanceIndex;
            
            // Get particle data
            const currentPos = this.positionBuffer.element(particleId);
            const resetCounter = this.resetFlagBuffer.element(particleId);
            const fadeTimer = this.fadeTimerBuffer.element(particleId);
            
            const trailStart = mul(particleId, uint(this.trailLength * 2));
            const metaIndex = mul(particleId, uint(2));
            
            // If particle was just reset (counter < 2), clear trail and start fresh
            If(resetCounter.lessThan(uint(2)), () => {
                // On the very first frame of a reset (counter is 0), clear the whole trail
                If(resetCounter.equals(uint(0)), () => {
                    Loop(uint(this.trailLength), ({ i }) => {
                        const clearIndex = trailStart.add(mul(i, uint(2)));
                        this.trailPositionsBuffer.element(clearIndex).assign(float(-9999));
                        this.trailPositionsBuffer.element(clearIndex.add(uint(1))).assign(float(-9999));
                    });
                });
                
                // For the first two frames, manage the trail start carefully
                // Store current position at head
                const headIndex = resetCounter; // 0 on first frame, 1 on second
                const writeIndex = trailStart.add(mul(headIndex, uint(2)));
                this.trailPositionsBuffer.element(writeIndex).assign(currentPos.x);
                this.trailPositionsBuffer.element(writeIndex.add(uint(1))).assign(currentPos.y);
                
                // Set head and length directly
                this.trailMetaBuffer.element(metaIndex).assign(headIndex.add(uint(1))); // Next write pos
                this.trailMetaBuffer.element(metaIndex.add(uint(1))).assign(headIndex.add(uint(1))); // Length
                
            }).Else(() => {
                // Always add a new point unless the particle was just reset
                const headIndex = this.trailMetaBuffer.element(metaIndex);
                const currentLength = this.trailMetaBuffer.element(metaIndex.add(uint(1)));
                
                // Calculate position in ring buffer to write new position
                const writeIndex = trailStart.add(mul(headIndex, uint(2))); // *2 because x,y per position
                
                // Store current position at head
                this.trailPositionsBuffer.element(writeIndex).assign(currentPos.x);
                this.trailPositionsBuffer.element(writeIndex.add(uint(1))).assign(currentPos.y);
                
                // Update head index (ring buffer)
                const newHeadIndex = mod(headIndex.add(uint(1)), uint(this.trailLength));
                this.trailMetaBuffer.element(metaIndex).assign(newHeadIndex);
                
                // Update length (max out at trailLength)
                const newLength = min(currentLength.add(uint(1)), uint(this.trailLength));
                this.trailMetaBuffer.element(metaIndex.add(uint(1))).assign(newLength);
            });
        });
        
        this.trailUpdateCompute = trailUpdate().compute(this.particleCount);

        // Create trail visualization
        this.createTrailVisualization();
        
        console.log(`Trail system initialized:
        - Particles: ${this.particleCount}
        - Trail length: ${this.trailLength}
        - Total trail points: ${this.particleCount * this.trailLength}
        - Trail positions buffer size: ${this.particleCount * this.trailLength * 2}`);
    }

    private createTrailVisualization(): void {
        // Create line segments between consecutive trail points
        const maxLineSegments = this.particleCount * (this.trailLength - 1); // N-1 segments per trail
        
        // Create instanced array for line segment data
        const linePositionsBuffer = instancedArray(maxLineSegments, 'vec3'); // center position
        const lineVectorsBuffer = instancedArray(maxLineSegments, 'vec3'); // direction and length
        const lineColorsBuffer = instancedArray(maxLineSegments, 'vec4');
        
        // Initialize line segments
        const lineInit = Fn(() => {
            const idx = instanceIndex;
            linePositionsBuffer.element(idx).assign(vec3(-9999, -9999, 0));
            lineVectorsBuffer.element(idx).assign(vec3(0, 0, 0));
            lineColorsBuffer.element(idx).assign(vec4(0, 0, 0, 0));
        });
        
        const lineInitCompute = lineInit().compute(maxLineSegments);
        this.renderer.computeAsync(lineInitCompute);
        
        // Create compute shader to update line segments
        const updateLines = Fn(() => {
            const idx = instanceIndex;
            const particleId = uint(floor(float(idx).div(float(this.trailLength - 1))));
            const segmentId = mod(idx, uint(this.trailLength - 1));
            
            // Get meta info for this particle
            const metaIndex = mul(particleId, uint(2));
            const headIndex = this.trailMetaBuffer.element(metaIndex);
            const currentLength = this.trailMetaBuffer.element(metaIndex.add(uint(1)));
            
            // Get fade timer for this particle
            const fadeTimer = this.fadeTimerBuffer.element(particleId);
            const fadeTime = float(2.0); // Match fade duration from particle update
            
            // Check if this segment should be visible
            // Need at least 2 points (currentLength >= 2) and segmentId must be within valid range
            const hasEnoughPoints = currentLength.greaterThanEqual(uint(2));
            const segmentInRange = segmentId.lessThan(currentLength.sub(uint(1)));
            const isValidSegment = hasEnoughPoints.and(segmentInRange);
            
            If(isValidSegment, () => {
                // Get start and end point indices in ring buffer
                const trailStart = mul(particleId, uint(this.trailLength * 2));
                
                // Determine chronological indices in the ring buffer without
                // relying on negative offsets (which caused head-to-tail jumps).
                // `headIndex` points to the NEXT slot that will be written.
                // The oldest valid point therefore is:
                //     oldest = (headIndex + trailLength - currentLength) % trailLength
                const oldestIndex = mod(
                    headIndex.add(uint(this.trailLength)).sub(currentLength),
                    uint(this.trailLength)
                );

                // Build the segment by connecting consecutive points:
                //   segmentId == 0  -> (oldest, oldest + 1)
                //   segmentId == 1  -> (oldest + 1, oldest + 2)  … etc.
                const startRingIndex = mod(oldestIndex.add(segmentId), uint(this.trailLength));
                const endRingIndex   = mod(startRingIndex.add(uint(1)), uint(this.trailLength));

                const startPosIndex = trailStart.add(mul(startRingIndex, uint(2)));
                const endPosIndex   = trailStart.add(mul(endRingIndex,   uint(2)));

                const startX = this.trailPositionsBuffer.element(startPosIndex);
                const startY = this.trailPositionsBuffer.element(startPosIndex.add(uint(1)));
                const endX   = this.trailPositionsBuffer.element(endPosIndex);
                const endY   = this.trailPositionsBuffer.element(endPosIndex.add(uint(1)));
                    
                // First, check if either point is invalid. If so, hide the segment immediately.
                const isInvalid = startX.lessThanEqual(float(-9000)).or(endX.lessThanEqual(float(-9000)));

                If(isInvalid, () => {
                     // Hide segment
                     linePositionsBuffer.element(idx).assign(vec3(-9999, -9999, 0));
                     lineVectorsBuffer.element(idx).assign(vec3(0, 0, 0));
                     lineColorsBuffer.element(idx).assign(vec4(0, 0, 0, 0));
                }).Else(()=> {
                    // Calculate line center and vector
                    const centerX = startX.add(endX).mul(0.5);
                    const centerY = startY.add(endY).mul(0.5);
                    const vecX = endX.sub(startX);
                    const vecY = endY.sub(startY);
                    const vecLength = length(vec2(vecX, vecY));
                    
                    // Skip segments that are too long (likely connecting across respawn)
                    const maxReasonableLength = float(2.0); // Adjust this threshold
                    const isReasonableLength = vecLength.lessThan(maxReasonableLength);
                    
                    If(isReasonableLength, () => {
                        // Set line data for reasonable segments with valid positions
                        linePositionsBuffer.element(idx).assign(vec3(centerX, centerY, float(0)));
                        lineVectorsBuffer.element(idx).assign(vec3(vecX, vecY, vecLength));
                        
                        // Set color with fade (newer segments brighter)
                        const fadeRatio = float(segmentId).div(max(float(currentLength), float(1)));
                        const baseAlpha = mix(float(0.2), float(0.9), fadeRatio);
                        
                        // Apply fade timer effect - fade out the entire trail when particle is fading
                        const fadeEffect = select(
                            fadeTimer.greaterThan(0),
                            float(1).sub(fadeTimer.div(fadeTime)).max(0), // Fade from 1 to 0 over fadeTime
                            float(1) // No fade when fadeTimer is 0
                        );
                        
                        const finalAlpha = baseAlpha.mul(fadeEffect);
                        const baseColor = mix(color('#0066ff'), color('#ff6600'), fadeRatio);
                        lineColorsBuffer.element(idx).assign(vec4(baseColor, finalAlpha));
                    }).Else(() => {
                        // Hide unreasonable or invalid segments
                        linePositionsBuffer.element(idx).assign(vec3(-9999, -9999, 0));
                        lineVectorsBuffer.element(idx).assign(vec3(0, 0, 0));
                        lineColorsBuffer.element(idx).assign(vec4(0, 0, 0, 0));
                    });
                });
            }).Else(() => {
                // Hide segment
                linePositionsBuffer.element(idx).assign(vec3(-9999, -9999, 0));
                lineVectorsBuffer.element(idx).assign(vec3(0, 0, 0));
                lineColorsBuffer.element(idx).assign(vec4(0, 0, 0, 0));
            });
        });
        
        this.trailPointUpdateCompute = updateLines().compute(maxLineSegments);
        
        // Create line material
        const material = new THREE.SpriteNodeMaterial({
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        
        // Set material nodes
        material.positionNode = linePositionsBuffer.toAttribute();
        material.colorNode = lineColorsBuffer.toAttribute();
        
        // Scale based on line length and make it thin
        material.scaleNode = Fn(() => {
            const vec = lineVectorsBuffer.toAttribute();
            return vec2(vec.z, float(0.02)); // length x thin height
        })();
        
        // Rotate to align with line direction
        material.rotationNode = Fn(() => {
            const vec = lineVectorsBuffer.toAttribute();
            return atan(vec.y, vec.x);
        })();
        
        // Create geometry and mesh
        const geometry = new THREE.PlaneGeometry(1, 1); // Will be scaled and rotated
        this.trailMesh = new THREE.InstancedMesh(geometry, material, maxLineSegments);
        this.scene.add(this.trailMesh);
    }

    /*
    // ===========================
    // Grid Vector Visualization
    // ===========================
    private initGridVectors(): void {
        // Create buffers for grid positions and vectors
        this.gridPositionBuffer = instancedArray(this.gridCount, 'vec2');
        this.gridVectorBuffer = instancedArray(this.gridCount, 'vec2');

        // Compute shader to initialize grid positions and vectors
        const gridInit = Fn(() => {
            const idx = instanceIndex;
            

            const res = uint(this.gridResolution);
            const xIdx = idx.mod(res).toFloat();
            const yIdx = idx.div(res).toFloat();

            const halfSize = float(this.gridSize * 0.5);
            const gridSizeF = float(this.gridSize);
            const resF = float(this.gridResolution);

            // Center grid points in their cells
            const posX = xIdx.toFloat().add(0.5).div(resF).mul(gridSizeF).sub(halfSize);
            const posY = yIdx.toFloat().add(0.5).div(resF).mul(gridSizeF).sub(halfSize);

            // Assign position
            this.gridPositionBuffer.element(idx).assign(vec2(posX, posY));

            // Flow field vector: v = (sin(y), sin(x))
            const vx = sin(posY);
            const vy = sin(posX);
            this.gridVectorBuffer.element(idx).assign(vec2(vx, vy));
        });

        const gridInitCompute = gridInit().compute(this.gridCount);
        this.renderer.computeAsync(gridInitCompute);

        // Create compute shader to update vectors each frame (keeps grid arrows synced with flow equation)
        const gridUpdate = Fn(() => {
            const idx = instanceIndex;

            // Position is static already stored; fetch position from buffer
            const pos = this.gridPositionBuffer.element(idx);

            // Lotka-Volterra predator-prey model
            // dx/dt = alpha * x - beta * x * y  (prey)
            // dy/dt = delta * x * y - gamma * y (predators)
            const x_pos = pos.x.div(float(this.gridSize * 0.5)); // Normalize to [-1, 1] range
            const y_pos = pos.y.div(float(this.gridSize * 0.5));
            
            // Map position to positive population values (prey, predators)
            const prey = x_pos.add(1.0).mul(2.0);
            const predators = y_pos.add(1.0).mul(2.0);
            
            // Lotka-Volterra parameters
            const alpha = float(1.0);
            const beta = float(0.5);
            const delta = float(0.5);
            const gamma = float(2.0);

            // Lotka-Volterra equations
            const dx_dt = prey.mul(alpha).sub(beta.mul(prey).mul(predators));
            const dy_dt = delta.mul(prey).mul(predators).sub(gamma.mul(predators));
            
            // Scale the flow field to reasonable magnitude for visualization
            const flow = vec2(dx_dt, dy_dt).mul(0.25);

            this.gridVectorBuffer.element(idx).assign(flow);
        });

        this.gridUpdateCompute = gridUpdate().compute(this.gridCount);

        // Create arrow geometry (simple elongated quad)
        const arrowWidth = 1;
        const arrowHeight = 0.05; // Increased from 0.02 for better visibility
        const geometry = new THREE.PlaneGeometry(arrowWidth, arrowHeight);

        const material = new THREE.SpriteNodeMaterial({
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        });

        // Position from buffer
        material.positionNode = this.gridPositionBuffer.toAttribute();

        // Rotation based on vector direction
        material.rotationNode = Fn(() => {
            const vec = this.gridVectorBuffer.toAttribute();
            return atan(vec.y, vec.x);
        })();

        // Scale: based on vector magnitude (increased for better visibility)
        material.scaleNode = Fn(() => {
            const vec = this.gridVectorBuffer.toAttribute();
            const mag = length(vec);
            return mag.mul(0.15).add(0.1); // Increased from 0.04 and 0.02
        })();

        // Color: blue to orange based on angle
        material.colorNode = Fn(() => {
            const vec = this.gridVectorBuffer.toAttribute();
            const ang = atan(vec.y, vec.x).add(float(Math.PI)).div(float(Math.PI * 2)); // 0-1
            return vec4(mix(color('#0066ff'), color('#ff6600'), ang), 1.0); // Full opacity
        })();

        // Create instanced mesh
        this.gridMesh = new THREE.InstancedMesh(geometry, material, this.gridCount);
        this.scene.add(this.gridMesh);
    }
    */
    
    public async update(): Promise<void> {
        // Update time
        this.timeUniform.value += 1/60;

        // Update particles
        if (this.updateCompute) {
            try {
                await this.renderer.computeAsync(this.updateCompute);
            } catch (error) {
                console.error('Particle compute error:', error);
            }
        }

        // Update trails (add current positions to ring buffer)
        if (this.trailUpdateCompute) {
            try {
                await this.renderer.computeAsync(this.trailUpdateCompute);
            } catch (error) {
                console.error('Trail compute error:', error);
            }
        }

        // Update trail point visualization
        if (this.trailPointUpdateCompute) {
            try {
                await this.renderer.computeAsync(this.trailPointUpdateCompute);
            } catch (error) {
                console.error('Trail point compute error:', error);
            }
        }

        /*
        // Update grid vectors each frame
        if (this.gridUpdateCompute) {
            try {
                await this.renderer.computeAsync(this.gridUpdateCompute);
            } catch (error) {
                console.error('Grid compute error:', error);
            }
        }
        */
        
        try {
            await this.renderer.renderAsync(this.scene, this.camera);
        } catch (error) {
            console.error('Render error:', error);
        }
    }
    
    public onResize(): void {
        const aspect = window.innerWidth / window.innerHeight;
        this.aspectUniform.value = aspect;
        
        const frustumSize = this.gridSize;
        
        this.camera.left = -frustumSize * aspect / 2;
        this.camera.right = frustumSize * aspect / 2;
        this.camera.top = frustumSize / 2;
        this.camera.bottom = -frustumSize / 2;
        this.camera.updateProjectionMatrix();
        
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }
}

/**
 * Application class
 */
class FlowFieldApp {
    private flowField!: FlowFieldSystem;
    private canvas!: HTMLCanvasElement;
    
    constructor() {
        this.init();
    }
    
    private async init(): Promise<void> {
        // Create canvas
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'fixed';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.zIndex = '-1';
        document.body.appendChild(this.canvas);
        
        // Initialize flow field system
        this.flowField = new FlowFieldSystem(this.canvas);
        
        // Setup event listeners
        window.addEventListener('resize', () => this.flowField?.onResize());
        
        // Wait for initialization, then start animation
        setTimeout(() => this.animate(), 200);
    }
    
    private animate = async (): Promise<void> => {
        requestAnimationFrame(this.animate);
        if (this.flowField) {
            await this.flowField.update();
        }
    };
}

// Start the application
new FlowFieldApp();