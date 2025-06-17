// Spatial binning shader for particle sorting
// Handles bin size calculation and filling for spatial optimization

struct Particle {
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    species: f32,
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

@group(0) @binding(0) var<storage, read> particles: array<Particle>;
@group(1) @binding(0) var<uniform> simulationOptions: SimulationOptions;
@group(2) @binding(0) var<storage, read_write> binSize: array<atomic<u32>>;

@compute @workgroup_size(64)
fn clearBinSize(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&binSize)) {
        return;
    }

    atomicStore(&binSize[id.x], 0u);
}

@compute @workgroup_size(64)
fn fillBinSize(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&particles)) {
        return;
    }

    let particle = particles[id.x];
    let binIndex = getBinInfo(vec2f(particle.x, particle.y), simulationOptions).binIndex;
    atomicAdd(&binSize[binIndex + 1], 1u);
} 