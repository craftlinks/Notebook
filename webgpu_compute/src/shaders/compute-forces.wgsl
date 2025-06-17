// Force computation shader
// Calculates inter-particle forces using spatially binned particles

struct Particle {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    species: f32,
}

struct Force {
    strength: f32,        // positive if attraction, negative if repulsion
    radius: f32,          // maximum interaction distance
    collisionStrength: f32, // strength of collision avoidance
    collisionRadius: f32,   // collision avoidance radius
}

struct SimulationOptions {
    left: f32,
    right: f32,
    bottom: f32,
    top: f32,
    friction: f32,
    dt: f32,
    binSize: f32,
    speciesCount: f32,
    centralForce: f32,
    loopingBorders: f32,
    actionX: f32,
    actionY: f32,
    actionVX: f32,
    actionVY: f32,
    actionForce: f32,
    actionRadius: f32,
}

struct BinInfo {
    gridSize: vec2i,
    binId: vec2i,
    binIndex: i32,
}

fn getBinInfo(position: vec2f, simulationOptions: SimulationOptions) -> BinInfo {
    let gridSize = vec2i(
        i32(ceil((simulationOptions.right - simulationOptions.left) / simulationOptions.binSize)),
        i32(ceil((simulationOptions.top - simulationOptions.bottom) / simulationOptions.binSize)),
    );

    let binId = vec2i(
        clamp(i32(floor((position.x - simulationOptions.left) / simulationOptions.binSize)), 0, gridSize.x - 1),
        clamp(i32(floor((position.y - simulationOptions.bottom) / simulationOptions.binSize)), 0, gridSize.y - 1)
    );

    let binIndex = binId.y * gridSize.x + binId.x;

    return BinInfo(gridSize, binId, binIndex);
}

@group(0) @binding(0) var<storage, read> particlesSource: array<Particle>;
@group(0) @binding(1) var<storage, read_write> particlesDestination: array<Particle>;
@group(0) @binding(2) var<storage, read> binOffset: array<u32>;
@group(0) @binding(3) var<storage, read> forces: array<Force>;

@group(1) @binding(0) var<uniform> simulationOptions: SimulationOptions;

@compute @workgroup_size(64)
fn computeForces(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&particlesSource)) {
        return;
    }

    var particle = particlesSource[id.x];
    let species = u32(particle.species);

    let binInfo = getBinInfo(vec2f(particle.x, particle.y), simulationOptions);
    let loopingBorders = simulationOptions.loopingBorders == 1.0;

    var binXMin = binInfo.binId.x - 1;
    var binYMin = binInfo.binId.y - 1;
    var binXMax = binInfo.binId.x + 1;
    var binYMax = binInfo.binId.y + 1;

    if (!loopingBorders) {
        binXMin = max(0, binXMin);
        binYMin = max(0, binYMin);
        binXMax = min(binInfo.gridSize.x - 1, binXMax);
        binYMax = min(binInfo.gridSize.y - 1, binYMax);
    }

    let width = simulationOptions.right - simulationOptions.left;
    let height = simulationOptions.top - simulationOptions.bottom;

    var totalForce = vec2f(0.0, 0.0);
    let particlePosition = vec2f(particle.x, particle.y);

    // Apply central force (attraction to origin)
    totalForce -= particlePosition * simulationOptions.centralForce;

    // Check neighboring bins for particle interactions
    for (var binX = binXMin; binX <= binXMax; binX += 1) {
        for (var binY = binYMin; binY <= binYMax; binY += 1) {
            var realBinX = (binX + binInfo.gridSize.x) % binInfo.gridSize.x;
            var realBinY = (binY + binInfo.gridSize.y) % binInfo.gridSize.y;

            let binIndex = realBinY * binInfo.gridSize.x + realBinX;
            let binStart = binOffset[binIndex];
            let binEnd = binOffset[binIndex + 1];

            // Check all particles in this bin
            for (var j = binStart; j < binEnd; j += 1) {
                if (j == id.x) {
                    continue; // Skip self-interaction
                }

                let other = particlesSource[j];
                let otherSpecies = u32(other.species);
                let force = forces[species * u32(simulationOptions.speciesCount) + otherSpecies];

                var r = vec2f(other.x, other.y) - particlePosition;

                // Handle periodic boundary conditions
                if (loopingBorders) {
                    if (abs(r.x) >= width * 0.5) {
                        r.x -= sign(r.x) * width;
                    }
                    if (abs(r.y) >= height * 0.5) {
                        r.y -= sign(r.y) * height;
                    }
                }

                let d = length(r);
                if (d > 0.0 && d < force.radius) {
                    let n = r / d;
                    
                    // Apply attraction/repulsion force
                    totalForce += force.strength * max(0.0, 1.0 - d / force.radius) * n;
                    
                    // Apply collision avoidance force
                    totalForce -= force.collisionStrength * max(0.0, 1.0 - d / force.collisionRadius) * n;
                }
            }
        }
    }

    // Update velocity (assuming mass = 1)
    particle.vx += totalForce.x * simulationOptions.dt;
    particle.vy += totalForce.y * simulationOptions.dt;

    particlesDestination[id.x] = particle;
} 