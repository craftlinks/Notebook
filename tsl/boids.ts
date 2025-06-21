import * as THREE from 'three/webgpu';
import { 
  uniform, 
  attributeArray, 
  float, 
  uint, 
  Fn, 
  If, 
  Loop, 
  Continue, 
  normalize, 
  instanceIndex, 
  length, 
  dot, 
  cos, 
  max, 
  property,
  negate,
} from 'three/tsl';

export interface BoidsConfig {
  count: number;
  speedLimit: number;
  bounds: number;
  separation: number;
  alignment: number;
  cohesion: number;
  freedom: number;
}

export interface BoidsUniforms {
  separation: ReturnType<typeof uniform>;
  alignment: ReturnType<typeof uniform>;
  cohesion: ReturnType<typeof uniform>;
  freedom: ReturnType<typeof uniform>;
  now: ReturnType<typeof uniform>;
  deltaTime: ReturnType<typeof uniform>;
  rayOrigin: ReturnType<typeof uniform>;
  rayDirection: ReturnType<typeof uniform>;
}

export interface BoidsStorage {
  positionStorage: ReturnType<typeof attributeArray>;
  velocityStorage: ReturnType<typeof attributeArray>;
  phaseStorage: ReturnType<typeof attributeArray>;
}

export interface BoidsCompute {
  computeVelocity: any;
  computePosition: any;
}

export class BoidsSimulation {
  private config: BoidsConfig;
  private uniforms!: BoidsUniforms;
  private storage!: BoidsStorage;
  private computeShaders!: BoidsCompute;
  private last: number = performance.now();

  constructor(config: Partial<BoidsConfig> = {}) {
    this.config = {
      count: 16384,
      speedLimit: 9.0,
      bounds: 800,
      separation: 15.0,
      alignment: 20.0,
      cohesion: 20.0,
      freedom: 0.75,
      ...config
    };

    this.initializeStorage();
    this.initializeUniforms();
    this.initializeCompute();
  }

  private initializeStorage(): void {
    const { count, bounds } = this.config;
    const boundsHalf = bounds / 2;

    const positionArray = new Float32Array(count * 3);
    const velocityArray = new Float32Array(count * 3);
    const phaseArray = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const posX = Math.random() * bounds - boundsHalf;
      const posY = Math.random() * bounds - boundsHalf;
      const posZ = Math.random() * bounds - boundsHalf;

      positionArray[i * 3 + 0] = posX;
      positionArray[i * 3 + 1] = posY;
      positionArray[i * 3 + 2] = posZ;

      const velX = Math.random() - 0.5;
      const velY = Math.random() - 0.5;
      const velZ = Math.random() - 0.5;

      velocityArray[i * 3 + 0] = velX * 10;
      velocityArray[i * 3 + 1] = velY * 10;
      velocityArray[i * 3 + 2] = velZ * 10;

      phaseArray[i] = 1;
    }

    const positionStorage = attributeArray(positionArray, 'vec3').label('positionStorage');
    const velocityStorage = attributeArray(velocityArray, 'vec3').label('velocityStorage');
    const phaseStorage = attributeArray(phaseArray, 'float').label('phaseStorage');

    // Enable Pixel Buffer Objects (PBO) for efficient GPU-CPU data transfer
    // PBOs allow asynchronous transfers between GPU and CPU memory
    // This is important for performance when reading back boid positions for visualization
    positionStorage.setPBO(true);
    velocityStorage.setPBO(true); 
    phaseStorage.setPBO(true);

    this.storage = {
      positionStorage,
      velocityStorage,
      phaseStorage
    };
  }

  private initializeUniforms(): void {
    this.uniforms = {
      separation: uniform(this.config.separation).label('separation'),
      alignment: uniform(this.config.alignment).label('alignment'),
      cohesion: uniform(this.config.cohesion).label('cohesion'),
      freedom: uniform(this.config.freedom).label('freedom'),
      now: uniform(0.0),
      deltaTime: uniform(0.0).label('deltaTime'),
      rayOrigin: uniform(new THREE.Vector3()).label('rayOrigin'),
      rayDirection: uniform(new THREE.Vector3()).label('rayDirection')
    };
  }

  private initializeCompute(): void {
    const { count, speedLimit } = this.config;
    const { positionStorage, velocityStorage, phaseStorage } = this.storage;

    const computeVelocity = Fn(() => {
      // Define mathematical constants for the simulation.
      const PI = float(3.141592653589793);
      const PI_2 = PI.mul(2.0);
      
      // A per-boid variable for the speed limit. This can be modified, for instance, when a boid is near a ray.
      const limit = property('float', 'limit').assign(speedLimit);

      // Import uniforms that provide external parameters to the compute shader.
      const { alignment, separation, cohesion, deltaTime, rayOrigin, rayDirection } = this.uniforms;

      // Define the different zones of interaction for a boid.
      // zoneRadius is the total radius of influence for a boid.
      const zoneRadius = separation.add(alignment).add(cohesion).toConst();
      // separationThresh is the normalized radius where boids will actively avoid each other.
      const separationThresh = separation.div(zoneRadius).toConst();
      // alignmentThresh is the normalized radius where boids will align their velocities with neighbors.
      const alignmentThresh = (separation.add(alignment)).div(zoneRadius).toConst();
      // The squared zone radius, for efficient distance checking.
      const zoneRadiusSq = zoneRadius.mul(zoneRadius).toConst();

      // Get the unique index of the current boid being processed.
      const birdIndex = instanceIndex.toConst('birdIndex');
      // Retrieve and store the current boid's position and velocity from storage buffers.
      const position = positionStorage.element(birdIndex).toVar();
      const velocity = velocityStorage.element(birdIndex).toVar();

      // --- Predator/Ray Avoidance ---
      // This section implements behavior for the boids to avoid a ray, which can represent a predator or an interactive element.
      // The logic calculates the closest point on the ray to the boid and applies a repulsive force if the boid is within the ray's radius of influence.
      const directionToRay = rayOrigin.sub(position).toConst();
      const projectionLength = dot(directionToRay, rayDirection).toConst();
      // closestPoint is the point on the ray nearest to the boid.
      const closestPoint = rayOrigin.sub(rayDirection.mul(projectionLength)).toConst();
      const directionToClosestPoint = closestPoint.sub(position).toConst();
      const distanceToClosestPoint = length(directionToClosestPoint).toConst();
      const distanceToClosestPointSq = distanceToClosestPoint.mul(distanceToClosestPoint).toConst();

      // Define the radius of influence for the ray.
      const rayRadius = float(150.0).toConst();
      const rayRadiusSq = rayRadius.mul(rayRadius).toConst();

      // If the boid is within the ray's influence, apply a force to steer it away.
      If(distanceToClosestPointSq.lessThan(rayRadiusSq), () => {
        // The force is stronger the closer the boid is to the ray.
        const velocityAdjust = (distanceToClosestPointSq.div(rayRadiusSq).sub(1.0)).mul(deltaTime).mul(100.0);
        velocity.addAssign(normalize(directionToClosestPoint).mul(velocityAdjust));
        // Increase the boid's speed limit to help it escape faster.
        limit.addAssign(5.0);
      });

      // --- Centering Force ---
      // This force gently steers the boids towards the center of the simulation space to prevent them from flying away indefinitely.
      const dirToCenter = position.toVar();
      // The y-component is weighted more heavily to encourage boids to stay within a flatter vertical space.
      dirToCenter.y.mulAssign(2.5);
      velocity.subAssign(normalize(dirToCenter).mul(deltaTime).mul(5.0));

      // --- Boid Interaction Loop ---
      // This is the core of the boids simulation. Each boid iterates through all other boids to calculate separation, alignment, and cohesion forces.
      Loop({ start: uint(0), end: uint(count), type: 'uint', condition: '<' }, ({ i }) => {
        
        // A boid does not interact with itself.
        // @ts-ignore - TSL function call signature issue
        If(i.equal(birdIndex), () => {
          Continue();
        });

        // Get the position of the other boid.
        const birdPosition = positionStorage.element(i);
        // Calculate the direction and distance to the other boid.
        const dirToBird = birdPosition.sub(position);
        const distToBird = length(dirToBird);

        // If boids are too close, they can cause instability. Skip this interaction.
        If(distToBird.lessThan(0.0001), () => {
          Continue();
        });

        const distToBirdSq = distToBird.mul(distToBird);

        // If the other boid is outside the zone of influence, skip it.
        If(distToBirdSq.greaterThan(zoneRadiusSq), () => {
          Continue();
        });

        // 'percent' represents how deep the other boid is within the current boid's zone of influence.
        const percent = distToBirdSq.div(zoneRadiusSq);

        // --- Separation, Alignment, and Cohesion Rules ---
        // These rules are applied based on the other boid's proximity.
        // The influence of each rule is smoothly blended using cosine-based weights for more natural flocking behavior.

        // 1. Separation: Steer to avoid crowding local flockmates.
        If(percent.lessThan(separationThresh), () => {
          // The repulsive force is stronger for closer boids.
          const velocityAdjust = (separationThresh.div(percent).sub(1.0)).mul(deltaTime);
          velocity.subAssign(normalize(dirToBird).mul(velocityAdjust));
        
        // 2. Alignment: Steer towards the average heading of local flockmates.
        }).ElseIf(percent.lessThan(alignmentThresh), () => {
          // Calculate a smooth weight for the alignment force using a cosine function.
          const threshDelta = alignmentThresh.sub(separationThresh);
          const adjustedPercent = (percent.sub(separationThresh)).div(threshDelta);
          const birdVelocity = velocityStorage.element(i);

          const cosRange = cos(adjustedPercent.mul(PI_2));
          const cosRangeAdjust = float(1.0).sub(cosRange.mul(0.5));
          const velocityAdjust = cosRangeAdjust.mul(deltaTime);
          // Apply the alignment force, steering towards the other boid's velocity.
          velocity.addAssign(normalize(birdVelocity).mul(velocityAdjust));
        
        // 3. Cohesion: Steer to move toward the average position of local flockmates.
        }).Else(() => {
          // Calculate a smooth weight for the cohesion force.
          const threshDelta = alignmentThresh.oneMinus();
          const adjustedPercent = threshDelta.equal(0.0).select(1.0, (percent.sub(alignmentThresh)).div(threshDelta));

          // The weighting function for cohesion is the same as for alignment.
          // It creates a force that is strongest in the middle of the zone.
          const cosRange = cos(adjustedPercent.mul(PI_2));
          const cosRangeAdjust = float(1.0).sub(cosRange.mul(0.5));

          const velocityAdjust = cosRangeAdjust.mul(deltaTime);
          // Apply the cohesion force, steering towards the other boid's position.
          velocity.addAssign(normalize(dirToBird).mul(velocityAdjust));
        });
      });

      // --- Velocity Limiting ---
      // Clamp the boid's velocity to its speed limit to ensure it doesn't move too fast.
      If(length(velocity).greaterThan(limit), () => {
        velocity.assign(normalize(velocity).mul(limit));
      });

      // Update the boid's velocity in the storage buffer with the newly computed velocity.
      velocityStorage.element(birdIndex).assign(velocity);
    })().compute(count);

    const computePosition = Fn(() => {
      const { deltaTime } = this.uniforms;
      const position = positionStorage.element(instanceIndex).toVar();
      
      position.addAssign(velocityStorage.element(instanceIndex).mul(deltaTime).mul(15.0));

      // Add boundary checks to wrap boids around the simulation area
      const halfBounds = float(this.config.bounds / 2.0);

      If(position.x.greaterThan(halfBounds), () => {
        position.x.assign(negate(halfBounds));
      });
      If(position.x.lessThan(negate(halfBounds)), () => {
        position.x.assign(halfBounds);
      });
      If(position.y.greaterThan(halfBounds), () => {
        position.y.assign(negate(halfBounds));
      });
      If(position.y.lessThan(negate(halfBounds)), () => {
        position.y.assign(halfBounds);
      });
      If(position.z.greaterThan(halfBounds), () => {
        position.z.assign(negate(halfBounds));
      });
      If(position.z.lessThan(negate(halfBounds)), () => {
        position.z.assign(halfBounds);
      });

      positionStorage.element(instanceIndex).assign(position);

      const velocity = velocityStorage.element(instanceIndex);
      const phase = phaseStorage.element(instanceIndex);

      const modValue = phase.add(deltaTime).add(length(velocity.xz).mul(deltaTime).mul(3.0)).add(max(velocity.y, 0.0).mul(deltaTime).mul(6.0));
      phaseStorage.element(instanceIndex).assign(modValue.mod(62.83));
    })().compute(count);

    this.computeShaders = {
      computeVelocity,
      computePosition
    };
  }

  public update(deltaTime: number, rayOrigin?: THREE.Vector3, rayDirection?: THREE.Vector3): void {
    const now = performance.now();
    
    if (deltaTime > 1) deltaTime = 1;

    this.uniforms.now.value = now;
    this.uniforms.deltaTime.value = deltaTime;
    
    if (rayOrigin) {
      (this.uniforms.rayOrigin.value as THREE.Vector3).copy(rayOrigin);
    }
    
    if (rayDirection) {
      (this.uniforms.rayDirection.value as THREE.Vector3).copy(rayDirection);
    }

    this.last = now;
  }

  public compute(renderer: THREE.WebGPURenderer): void {
    renderer.compute(this.computeShaders.computeVelocity);
    renderer.compute(this.computeShaders.computePosition);
  }

  public getStorage(): BoidsStorage {
    return this.storage;
  }

  public getUniforms(): BoidsUniforms {
    return this.uniforms;
  }

  public getConfig(): BoidsConfig {
    return this.config;
  }

  public getComputeShaders(): BoidsCompute {
    return this.computeShaders;
  }

  public updateConfig(config: Partial<BoidsConfig>): void {
    Object.assign(this.config, config);
    
    this.uniforms.separation.value = this.config.separation;
    this.uniforms.alignment.value = this.config.alignment;
    this.uniforms.cohesion.value = this.config.cohesion;
    this.uniforms.freedom.value = this.config.freedom;
  }
}