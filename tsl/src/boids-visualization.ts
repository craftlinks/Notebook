import * as THREE from 'three/webgpu';
import { 
  Fn, 
  normalize, 
  length, 
  mix,
  vec3,
  vec4,
  instanceIndex,
  positionLocal,
  cameraProjectionMatrix,
  cameraViewMatrix,
  mat3,
  cross,
  uint
} from 'three/tsl';
import { BoidsSimulation } from './boids';

export interface BoidsVisualizationConfig {
  particleSize: number;
  color1: THREE.Color;
  color2: THREE.Color;
  color3: THREE.Color;
  useTriangles: boolean; // true for triangles, false for quads
}

export class BoidsVisualization {
  private scene: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private mesh!: THREE.InstancedMesh;
  private material!: THREE.NodeMaterial;
  private config: BoidsVisualizationConfig;
  private storage: any; // Use any type to avoid import issues
  private count: number;

  constructor(
    simulation: BoidsSimulation,
    config: Partial<BoidsVisualizationConfig> = {}
  ) {
    this.config = {
      particleSize: 1.0,
      color1: new THREE.Color(0xff0000), // Red for species 1
      color2: new THREE.Color(0x00ff00), // Green for species 2
      color3: new THREE.Color(0x0000ff), // Blue for species 3
      useTriangles: true,
      ...config
    };

    this.storage = simulation.getStorage();
    this.count = simulation.getConfig().count;

    this.scene = new THREE.Scene();
    this.setupCamera();
    this.setupGeometry();
    this.setupMaterial();
    this.setupMesh();
  }

  private setupCamera(): void {
    this.camera = new THREE.PerspectiveCamera(
      50, 
      window.innerWidth / window.innerHeight, 
      1, 
      10000
    );
    this.camera.position.set(0, 0, 1600);
  }

  private setupGeometry(): THREE.BufferGeometry {
    if (this.config.useTriangles) {
      // Simple triangle pointing upward (in local space)
      const geometry = new THREE.BufferGeometry();
      const vertices = new Float32Array([
        0.0,  0.5, 0.0,  // top vertex
       -0.1, -0.5, 0.0,  // bottom left
        0.1, -0.5, 0.0   // bottom right
      ]);
      geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      return geometry;
    } else {
      // Simple quad as fallback
      return new THREE.PlaneGeometry(0.6, 0.6);
    }
  }

  private setupMaterial(): void {
    this.material = new THREE.NodeMaterial();
    
    // Create vertex shader that positions and orients each boid
    const boidVertexShader = Fn(() => {
      // Get the current instance index (which boid we're rendering)
      const boidIndex = instanceIndex;
      
      // Get position and velocity from compute storage
      const boidPosition = this.storage.positionStorage.element(boidIndex);
      const boidVelocity = this.storage.velocityStorage.element(boidIndex);
      
      // Transform local vertex position
      const localPos = positionLocal.toVar();
      localPos.mulAssign(this.config.particleSize);
      
      // Create a rotation matrix to align the boid with its velocity
      const velocity = normalize(boidVelocity.add(vec3(0.001, 0.001, 0.001))); // Add epsilon to avoid zero velocity

      const forward = velocity.toVar('forward');
      const up = vec3(0.0, 1.0, 0.0).toVar('up');
      const right = normalize(cross(up, forward)).toVar('right');
      const newUp = normalize(cross(forward, right)).toVar('newUp');
      
      const rotationMatrix = mat3(
        right.x, forward.x, newUp.x,
        right.y, forward.y, newUp.y,
        right.z, forward.z, newUp.z
      ).toVar();
      
      const rotatedPos = rotationMatrix.mul(localPos);
      
      // Translate to boid position
      const worldPos = rotatedPos.add(boidPosition);
      
      // Transform to clip space
      return cameraProjectionMatrix.mul(cameraViewMatrix).mul(vec4(worldPos, 1.0));
    });

    // Create fragment shader for coloring based on speed
    const boidFragmentShader = Fn(() => {
      const boidIndex = instanceIndex;
      const species = this.storage.speciesStorage.element(boidIndex);
      
      const color1 = vec3(this.config.color1.r, this.config.color1.g, this.config.color1.b);
      const color2 = vec3(this.config.color2.r, this.config.color2.g, this.config.color2.b);
      const color3 = vec3(this.config.color3.r, this.config.color3.g, this.config.color3.b);
      
      const finalColor = species.equal(uint(0)).select(
        color1,
        species.equal(uint(1)).select(color2, color3)
      );
      
      return vec4(finalColor, 1.0);
    });

    // Assign shaders to material
    this.material.vertexNode = boidVertexShader();
    this.material.colorNode = boidFragmentShader();
    this.material.side = THREE.DoubleSide;
    this.material.transparent = true;
  }

  private setupMesh(): void {
    const geometry = this.setupGeometry();
    this.mesh = new THREE.InstancedMesh(geometry, this.material, this.count);
    this.mesh.frustumCulled = false; // Disable frustum culling for performance
    this.scene.add(this.mesh);
  }

  public render(renderer: THREE.WebGPURenderer): void {
    renderer.render(this.scene, this.camera);
  }

  public getScene(): THREE.Scene {
    return this.scene;
  }

  public getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  public updateConfig(config: Partial<BoidsVisualizationConfig>): void {
    Object.assign(this.config, config);
    
    // Recreate material if colors changed
    if (config.color1 || config.color2 || config.color3) {
      this.setupMaterial();
      this.mesh.material = this.material;
    }
    
    // Recreate geometry if triangle/quad setting changed
    if (config.useTriangles !== undefined) {
      const newGeometry = this.setupGeometry();
      this.mesh.geometry.dispose();
      this.mesh.geometry = newGeometry;
    }
  }

  public onWindowResize(width: number, height: number): void {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  public dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.scene.clear();
  }
}