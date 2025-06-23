import * as THREE from 'three/webgpu';
import { 
  Fn, 
  normalize, 
  vec3,
  vec4,
  instanceIndex,
  positionLocal,
  cameraProjectionMatrix,
  cameraViewMatrix,
  mat3,
  uint,
  Switch,
  property,
  cross
} from 'three/tsl';
import { BoidsSimulation } from './boids';

export interface BoidsVisualizationConfig {
  particleSize: number;
  colors: THREE.Color[];
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
      colors: [
        new THREE.Color(0xff0000), // Red
        new THREE.Color(0x00ff00), // Green
        new THREE.Color(0x0000ff)  // Blue
      ],
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
      
      // Align local +Y axis (triangle tip) to velocity using an orthonormal basis
      const forward = normalize(boidVelocity.add(vec3(0.0001, 0.0001, 0.0001))).toVar('forward');

      // Choose a reference up vector that is not parallel to forward
      const worldUp = vec3(0.0, 0.0, 1.0).toVar('worldUp');

      // Build right and up vectors for the boid's local frame
      const right = normalize(cross(worldUp, forward)).toVar('right');
      const newUp = normalize(cross(forward, right)).toVar('newUp');

      // Construct a rotation matrix whose columns map local (X,Y,Z) -> (right, forward, newUp)
      const rotationMatrix = mat3(
        right.x, forward.x, newUp.x,
        right.y, forward.y, newUp.y,
        right.z, forward.z, newUp.z
      ).toVar('rotationMatrix');

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
      
      const finalColor = property('vec3', 'finalColor').toVar();
      
      const switchCase = Switch(species);
      for (let i = 0; i < this.config.colors.length; i++) {
        const color = this.config.colors[i];
        // @ts-ignore - TSL function call signature issue
        switchCase.Case(uint(i), () => {
          finalColor.assign(vec3(color.r, color.g, color.b));
        });
      }
      // @ts-ignore - TSL function call signature issue
      switchCase.Default(() => {
        // Default color if species index is out of bounds
        finalColor.assign(vec3(1.0, 1.0, 1.0));
      });
      
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
    if (config.colors) {
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