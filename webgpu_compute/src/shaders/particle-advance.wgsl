// Particle advancement shader
// Updates particle positions and velocities, handles boundary conditions

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

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(1) @binding(0) var<uniform> simulationOptions: SimulationOptions;

@compute @workgroup_size(64)
fn particleAdvance(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= arrayLength(&particles)) {
        return;
    }

    let width = simulationOptions.right - simulationOptions.left;
    let height = simulationOptions.top - simulationOptions.bottom;

    var particle = particles[id.x];

    // Apply user interaction force (mouse/touch)
    var actionR = vec2f(particle.x, particle.y) - vec2f(simulationOptions.actionX, simulationOptions.actionY);
    
    if (simulationOptions.loopingBorders == 1.0) {
        // Handle periodic boundaries for action force
        if (abs(actionR.x) >= width * 0.5) {
            actionR.x -= sign(actionR.x) * width;
        }
        if (abs(actionR.y) >= height * 0.5) {
            actionR.y -= sign(actionR.y) * height;
        }
    }
    
    // Apply Gaussian-decaying action force
    let actionFactor = simulationOptions.actionForce * exp(-dot(actionR, actionR) / (simulationOptions.actionRadius * simulationOptions.actionRadius));
    particle.vx += simulationOptions.actionVX * actionFactor;
    particle.vy += simulationOptions.actionVY * actionFactor;

    // Apply friction
    particle.vx *= simulationOptions.friction;
    particle.vy *= simulationOptions.friction;

    // Update position using velocity
    particle.x += particle.vx * simulationOptions.dt;
    particle.y += particle.vy * simulationOptions.dt;

    let loopingBorders = simulationOptions.loopingBorders == 1.0;

    if (loopingBorders) {
        // Periodic boundary conditions (wrap around)
        if (particle.x < simulationOptions.left) {
            particle.x += width;
        }
        if (particle.x > simulationOptions.right) {
            particle.x -= width;
        }
        if (particle.y < simulationOptions.bottom) {
            particle.y += height;
        }
        if (particle.y > simulationOptions.top) {
            particle.y -= height;
        }
    } else {
        // Reflective boundary conditions (bounce off walls)
        if (particle.x < simulationOptions.left) {
            particle.x = simulationOptions.left;
            particle.vx *= -1.0;
        }
        if (particle.x > simulationOptions.right) {
            particle.x = simulationOptions.right;
            particle.vx *= -1.0;
        }
        if (particle.y < simulationOptions.bottom) {
            particle.y = simulationOptions.bottom;
            particle.vy *= -1.0;
        }
        if (particle.y > simulationOptions.top) {
            particle.y = simulationOptions.top;
            particle.vy *= -1.0;
        }
    }

    particles[id.x] = particle;
} 