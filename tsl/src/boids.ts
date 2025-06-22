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

export type InterSpeciesRule = 'rock-paper-scissors' | 'density-based';

export interface SpeciesConfig {
  separation: number;
  alignment: number;
  cohesion: number;
  freedom: number;
  speedLimit: number;
}

export interface BoidsConfig {
  count: number;
  bounds: number;
  species1: SpeciesConfig;
  species2: SpeciesConfig;
  species3: SpeciesConfig;
  interSpeciesRule: InterSpeciesRule;
}

export interface BoidsUniforms {
  separation1: ReturnType<typeof uniform>;
  alignment1: ReturnType<typeof uniform>;
  cohesion1: ReturnType<typeof uniform>;
  separation2: ReturnType<typeof uniform>;
  alignment2: ReturnType<typeof uniform>;
  cohesion2: ReturnType<typeof uniform>;
  separation3: ReturnType<typeof uniform>;
  alignment3: ReturnType<typeof uniform>;
  cohesion3: ReturnType<typeof uniform>;
  now: ReturnType<typeof uniform>;
  deltaTime: ReturnType<typeof uniform>;
  rayOrigin: ReturnType<typeof uniform>;
  rayDirection: ReturnType<typeof uniform>;
  interSpeciesRule: ReturnType<typeof uniform>;
}

export interface BoidsStorage {
  positionStorage: ReturnType<typeof attributeArray>;
  velocityStorage: ReturnType<typeof attributeArray>;
  phaseStorage: ReturnType<typeof attributeArray>;
  speciesStorage: ReturnType<typeof attributeArray>;
}

export interface BoidsCompute {
  computeVelocity: any;
  computePosition: any;
}

const rockPaperScissorsRule = (params: {
  species: any,
  otherSpecies: any,
  distToBirdSq: any,
  dirToBird: any,
  velocity: any,
  deltaTime: any
}) => {
  const { species, otherSpecies, distToBirdSq, dirToBird, velocity, deltaTime } = params;

  const preySpecies = species.add(uint(1)).mod(uint(3));
  const predatorSpecies = species.add(uint(2)).mod(uint(3));

  If(otherSpecies.equal(preySpecies), () => { // This boid is the hunter
    const huntingRadius = float(300.0);
    const huntingRadiusSq = huntingRadius.mul(huntingRadius);
    
    If(distToBirdSq.lessThan(huntingRadiusSq), () => {
      const velocityAdjust = deltaTime.mul(0.8);
      velocity.addAssign(normalize(dirToBird).mul(velocityAdjust));
    });

  }).ElseIf(otherSpecies.equal(predatorSpecies), () => { // This boid is the prey
    const fleeRadius = float(200.0);
    const fleeRadiusSq = fleeRadius.mul(fleeRadius);

    If(distToBirdSq.lessThan(fleeRadiusSq), () => {
      const velocityAdjust = (fleeRadiusSq.div(distToBirdSq).sub(1.0)).mul(deltaTime).mul(2.5);
      velocity.subAssign(normalize(dirToBird).mul(velocityAdjust));
    });
  });
}

const densityBasedRule = (params: {
  distToBirdSq: any,
  dirToBird: any,
  velocity: any,
  deltaTime: any
}) => {
  const { distToBirdSq, dirToBird, velocity, deltaTime } = params;

  const fleeRadius = float(100.0);
  const fleeRadiusSq = fleeRadius.mul(fleeRadius);

  If(distToBirdSq.lessThan(fleeRadiusSq), () => {
    // Flee
    const velocityAdjust = (fleeRadiusSq.div(distToBirdSq).sub(1.0)).mul(deltaTime).mul(2.5);
    velocity.subAssign(normalize(dirToBird).mul(velocityAdjust));
  }).Else(() => {
    // Hunt
    const huntingRadius = float(300.0);
    const huntingRadiusSq = huntingRadius.mul(huntingRadius);
    If(distToBirdSq.lessThan(huntingRadiusSq), () => {
      const velocityAdjust = deltaTime.mul(0.8);
      velocity.addAssign(normalize(dirToBird).mul(velocityAdjust));
    });
  });
}

export class BoidsSimulation {
  private config: BoidsConfig;
  private uniforms!: BoidsUniforms;
  private storage!: BoidsStorage;
  private computeShaders!: BoidsCompute;

  constructor(config: Partial<BoidsConfig> = {}) {
    const isMobile = /Mobi/i.test(navigator.userAgent);

    const defaultConfig: BoidsConfig = {
      count: isMobile ? 1024 : 4096,
      bounds: 800,
      species1: {
        separation: 15.0,
        alignment: 20.0,
        cohesion: 20.0,
        freedom: 0.75,
        speedLimit: 9.0,
      },
      species2: {
        separation: 25.0,
        alignment: 15.0,
        cohesion: 15.0,
        freedom: 0.8,
        speedLimit: 7.0,
      },
      species3: {
        separation: 20.0,
        alignment: 25.0,
        cohesion: 10.0,
        freedom: 0.85,
        speedLimit: 8.0,
      },
      interSpeciesRule: 'density-based',
    };

    this.config = {
      ...defaultConfig,
      ...config,
      species1: { ...defaultConfig.species1, ...(config.species1 || {}) },
      species2: { ...defaultConfig.species2, ...(config.species2 || {}) },
      species3: { ...defaultConfig.species3, ...(config.species3 || {}) },
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
    const speciesArray = new Uint32Array(count);

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
      speciesArray[i] = i < count / 3 ? 0 : (i < count * 2 / 3 ? 1 : 2);
    }

    const positionStorage = attributeArray(positionArray, 'vec3').label('positionStorage');
    const velocityStorage = attributeArray(velocityArray, 'vec3').label('velocityStorage');
    const phaseStorage = attributeArray(phaseArray, 'float').label('phaseStorage');
    const speciesStorage = attributeArray(speciesArray, 'uint').label('speciesStorage');

    // Enable Pixel Buffer Objects (PBO) for efficient GPU-CPU data transfer
    // PBOs allow asynchronous transfers between GPU and CPU memory
    // This is important for performance when reading back boid positions for visualization
    positionStorage.setPBO(true);
    velocityStorage.setPBO(true); 
    phaseStorage.setPBO(true);
    speciesStorage.setPBO(true);

    this.storage = {
      positionStorage,
      velocityStorage,
      phaseStorage,
      speciesStorage
    };
  }

  private initializeUniforms(): void {
    this.uniforms = {
      separation1: uniform(this.config.species1.separation).label('separation1'),
      alignment1: uniform(this.config.species1.alignment).label('alignment1'),
      cohesion1: uniform(this.config.species1.cohesion).label('cohesion1'),
      separation2: uniform(this.config.species2.separation).label('separation2'),
      alignment2: uniform(this.config.species2.alignment).label('alignment2'),
      cohesion2: uniform(this.config.species2.cohesion).label('cohesion2'),
      separation3: uniform(this.config.species3.separation).label('separation3'),
      alignment3: uniform(this.config.species3.alignment).label('alignment3'),
      cohesion3: uniform(this.config.species3.cohesion).label('cohesion3'),
      now: uniform(0.0),
      deltaTime: uniform(0.0).label('deltaTime'),
      rayOrigin: uniform(new THREE.Vector3()).label('rayOrigin'),
      rayDirection: uniform(new THREE.Vector3()).label('rayDirection'),
      interSpeciesRule: uniform(this.config.interSpeciesRule === 'rock-paper-scissors' ? 0 : 1),
    };
  }

  private initializeCompute(): void {
    const { count } = this.config;
    const { positionStorage, velocityStorage, phaseStorage, speciesStorage } = this.storage;

    const computeVelocity = Fn(() => {
      // Define mathematical constants for the simulation.
      const PI = float(3.141592653589793);
      const PI_2 = PI.mul(2.0);

      const birdIndex = instanceIndex.toConst('birdIndex');
      const species = speciesStorage.element(birdIndex).toConst('species');
      
      const speedLimit = species.equal(uint(0)).select(
        this.config.species1.speedLimit, 
        species.equal(uint(1)).select(
          this.config.species2.speedLimit,
          this.config.species3.speedLimit
        )
      );
      // A per-boid variable for the speed limit. This can be modified, for instance, when a boid is near a ray.
      const limit = property('float', 'limit').assign(speedLimit);

      // Import uniforms that provide external parameters to the compute shader.
      const { 
        deltaTime, rayOrigin, rayDirection,
        separation1, alignment1, cohesion1,
        separation2, alignment2, cohesion2,
        separation3, alignment3, cohesion3,
        interSpeciesRule
      } = this.uniforms;

      const separation = species.equal(uint(0)).select(
        separation1,
        species.equal(uint(1)).select(separation2, separation3)
      );
      const alignment = species.equal(uint(0)).select(
        alignment1,
        species.equal(uint(1)).select(alignment2, alignment3)
      );
      const cohesion = species.equal(uint(0)).select(
        cohesion1,
        species.equal(uint(1)).select(cohesion2, cohesion3)
      );

      // Define the different zones of interaction for a boid.
      // zoneRadius is the total radius of influence for a boid.
      const zoneRadius = separation.add(alignment).add(cohesion).toConst();
      // separationThresh is the normalized radius where boids will actively avoid each other.
      const separationThresh = separation.div(zoneRadius).toConst();
      // alignmentThresh is the normalized radius where boids will align their velocities with neighbors.
      const alignmentThresh = (separation.add(alignment)).div(zoneRadius).toConst();
      // The squared zone radius, for efficient distance checking.
      const zoneRadiusSq = zoneRadius.mul(zoneRadius).toConst();

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

        const otherSpecies = speciesStorage.element(i);
        
        If(species.equal(otherSpecies), () => {
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
        }).Else(() => { // Different species interaction
          If(interSpeciesRule.equal(uint(0)), () => {
            rockPaperScissorsRule({
              species,
              otherSpecies,
              distToBirdSq,
              dirToBird,
              velocity,
              deltaTime
            });
          }).Else(() => {
            densityBasedRule({
              distToBirdSq,
              dirToBird,
              velocity,
              deltaTime
            });
          });
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
    if (config.count) this.config.count = config.count;
    if (config.bounds) this.config.bounds = config.bounds;
    if (config.species1) this.config.species1 = { ...this.config.species1, ...config.species1 };
    if (config.species2) this.config.species2 = { ...this.config.species2, ...config.species2 };
    if (config.species3) this.config.species3 = { ...this.config.species3, ...config.species3 };
    if (config.interSpeciesRule) {
      this.config.interSpeciesRule = config.interSpeciesRule;
      this.uniforms.interSpeciesRule.value = this.config.interSpeciesRule === 'rock-paper-scissors' ? 0 : 1;
    }
    
    this.uniforms.separation1.value = this.config.species1.separation;
    this.uniforms.alignment1.value = this.config.species1.alignment;
    this.uniforms.cohesion1.value = this.config.species1.cohesion;
    this.uniforms.separation2.value = this.config.species2.separation;
    this.uniforms.alignment2.value = this.config.species2.alignment;
    this.uniforms.cohesion2.value = this.config.species2.cohesion;
    this.uniforms.separation3.value = this.config.species3.separation;
    this.uniforms.alignment3.value = this.config.species3.alignment;
    this.uniforms.cohesion3.value = this.config.species3.cohesion;
  }
}