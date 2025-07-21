import * as THREE from 'three/webgpu';
import { 
    float, 
    vec2, 
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
    atan
} from 'three/tsl';

/**
 * Simplified Flow Field Visualization System
 * Based on the working TSL example pattern
 */
class FlowFieldSystem {
    private renderer!: THREE.WebGPURenderer;
    private scene!: THREE.Scene;
    private camera!: THREE.OrthographicCamera;
    
    private particleCount = 16384;
    private gridSize = 32;
    // New grid properties
    private gridResolution = 32;
    private gridCount = this.gridResolution * this.gridResolution;
    private gridPositionBuffer!: any;
    private gridVectorBuffer!: any;
    private gridMesh!: THREE.InstancedMesh;
    private gridUpdateCompute!: any;
    
    private positionBuffer!: any;
    private velocityBuffer!: any;
    private updateCompute!: any;
    private particleMesh!: THREE.InstancedMesh;
    
    constructor(canvas: HTMLCanvasElement) {
        this.init(canvas);
    }
    
    private async init(canvas: HTMLCanvasElement): Promise<void> {
        await this.initRenderer(canvas);
        this.initScene();
        this.initParticles();
        this.initGridVectors(); // <- add grid visualization
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
        const frustumSize = this.gridSize;
        this.camera = new THREE.OrthographicCamera(
            -frustumSize * aspect / 2, frustumSize * aspect / 2,
            frustumSize / 2, -frustumSize / 2,
            0.1, 1000
        );
        this.camera.position.z = 10;
    }
    
    private initParticles(): void {
        // Create buffers following the exact pattern from the working example
        this.positionBuffer = instancedArray(this.particleCount, 'vec2');
        this.velocityBuffer = instancedArray(this.particleCount, 'vec2');
        
        // Initialize particles
        const init = Fn(() => {
            const position = this.positionBuffer.element(instanceIndex);
            const velocity = this.velocityBuffer.element(instanceIndex);
            
            // Random initial position
            const randomPos = vec2(
                hash(instanceIndex.add(uint(1))).mul(2).sub(1).mul(this.gridSize * 0.2),
                hash(instanceIndex.add(uint(2))).mul(2).sub(1).mul(this.gridSize * 0.2)
            );
            
            position.assign(randomPos);
            velocity.assign(vec2(0, 0));
        });
        
        const initCompute = init().compute(this.particleCount);
        
        // Update compute shader
        const update = Fn(() => {
            const position = this.positionBuffer.element(instanceIndex);
            const velocity = this.velocityBuffer.element(instanceIndex);
            
            // Flow field equations: vx = sin(y), vy = sin(x)
            const flowVel = vec2((float(1.1)).mul(position.x), (float(-1)).mul(position.y));
            velocity.assign(flowVel);
            
            // Update position
            const deltaTime = float(1/60);
            position.addAssign(velocity.mul(deltaTime));
            
            // Boundary wrapping
            const halfSize = float(this.gridSize * 0.5);
            position.assign(vec2(
                mod(position.x.add(halfSize), float(this.gridSize)).sub(halfSize),
                mod(position.y.add(halfSize), float(this.gridSize)).sub(halfSize)
            ));
        });
        
        this.updateCompute = update().compute(this.particleCount);
        
        // Initialize
        this.renderer.computeAsync(initCompute);
        
        // Create rendering
        this.createParticleRendering();
    }
    
    private createParticleRendering(): void {
        const geometry = new THREE.PlaneGeometry(1, 1);
        const material = new THREE.SpriteNodeMaterial({ 
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false
        });
        
        // Position from buffer
        material.positionNode = this.positionBuffer.toAttribute();
        
        // Color based on velocity
        material.colorNode = Fn(() => {
            const vel = this.velocityBuffer.toAttribute();
            const speed = length(vel);
            const normalizedSpeed = speed.div(2).clamp(0, 1);
            
            return vec4(
                mix(color('#0066ff'), color('#ff6600'), normalizedSpeed),
                0.8
            );
        })();
        
        // Scale based on velocity
        material.scaleNode = Fn(() => {
            const vel = this.velocityBuffer.toAttribute();
            const speed = length(vel);
            return speed.mul(0.015).add(0.01);
        })();
        
        this.particleMesh = new THREE.InstancedMesh(geometry, material, this.particleCount);
        this.scene.add(this.particleMesh);
    }

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

            const posX = xIdx.div(float(this.gridResolution)).mul(gridSizeF).sub(halfSize);
            const posY = yIdx.div(float(this.gridResolution)).mul(gridSizeF).sub(halfSize);

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

            // Flow field equations (mirror particle velocity logic)
            const flow = vec2((float(1.1)).mul(pos.x), (float(-1)).mul(pos.y));

            this.gridVectorBuffer.element(idx).assign(flow);
        });

        this.gridUpdateCompute = gridUpdate().compute(this.gridCount);

        // Create arrow geometry (simple elongated quad)
        const arrowWidth = 1;
        const arrowHeight = 0.02;
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

        // Scale: based on vector magnitude
        material.scaleNode = Fn(() => {
            const vec = this.gridVectorBuffer.toAttribute();
            const mag = length(vec);
            return mag.mul(0.04).add(0.02);
        })();

        // Color: blue to orange based on angle
        material.colorNode = Fn(() => {
            const vec = this.gridVectorBuffer.toAttribute();
            const ang = atan(vec.y, vec.x).add(float(Math.PI)).div(float(Math.PI * 2)); // 0-1
            return vec4(mix(color('#0066ff'), color('#ff6600'), ang), 0.9);
        })();

        // Create instanced mesh
        this.gridMesh = new THREE.InstancedMesh(geometry, material, this.gridCount);
        this.scene.add(this.gridMesh);
    }
    
    public async update(): Promise<void> {
        if (this.updateCompute) {
            try {
                await this.renderer.computeAsync(this.updateCompute);
            } catch (error) {
                console.error('Compute error:', error);
            }
        }

        // Update grid vectors each frame
        if (this.gridUpdateCompute) {
            try {
                await this.renderer.computeAsync(this.gridUpdateCompute);
            } catch (error) {
                console.error('Grid compute error:', error);
            }
        }
        
        try {
            await this.renderer.renderAsync(this.scene, this.camera);
        } catch (error) {
            console.error('Render error:', error);
        }
    }
    
    public onResize(): void {
        const aspect = window.innerWidth / window.innerHeight;
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