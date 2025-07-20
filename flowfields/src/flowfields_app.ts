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
    private gridSize = 10;
    
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
                hash(instanceIndex.add(uint(1))).mul(2).sub(1).mul(this.gridSize * 0.4),
                hash(instanceIndex.add(uint(2))).mul(2).sub(1).mul(this.gridSize * 0.4)
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
            const flowVel = vec2(sin(position.y), sin(position.x));
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
            return speed.mul(0.03).add(0.02);
        })();
        
        this.particleMesh = new THREE.InstancedMesh(geometry, material, this.particleCount);
        this.scene.add(this.particleMesh);
    }
    
    public async update(): Promise<void> {
        if (this.updateCompute) {
            try {
                await this.renderer.computeAsync(this.updateCompute);
            } catch (error) {
                console.error('Compute error:', error);
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