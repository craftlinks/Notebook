/*
Copyright (c) 2025 Nikita Lisitsa

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

const particleDescription = 
`
struct Particle
{
    x : f32,
    y : f32,
    vx : f32,
    vy : f32,
    species : f32,
}
`;

const speciesDescription =
`
struct Species
{
    color : vec4f,
}
`;

const forceDescription =
`
struct Force
{
    strength: f32, // positive if attraction
    radius: f32,
    collisionStrength : f32,
    collisionRadius: f32,
}
`;

const simulationOptionsDescription =
`
struct SimulationOptions
{
    left : f32,
    right : f32,
    bottom : f32,
    top : f32,
    friction : f32,
    dt : f32,
    binSize : f32,
    speciesCount : f32,
    centralForce : f32,
}

struct BinInfo
{
    gridSize : vec2i,
    binId : vec2i,
    binIndex : i32,
}

fn getBinInfo(position : vec2f, simulationOptions : SimulationOptions) -> BinInfo
{
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
`;

const binFillSizeShader = 
`
${particleDescription}
${simulationOptionsDescription}

@group(0) @binding(0) var<storage, read> particles : array<Particle>;

@group(1) @binding(0) var<uniform> simulationOptions : SimulationOptions;

@group(2) @binding(0) var<storage, read_write> binSize : array<atomic<u32>>;

@compute @workgroup_size(64)
fn clearBinSize(@builtin(global_invocation_id) id : vec3u)
{
    if (id.x >= arrayLength(&binSize)) {
        return;
    }

    atomicStore(&binSize[id.x], 0u);
}

@compute @workgroup_size(64)
fn fillBinSize(@builtin(global_invocation_id) id : vec3u)
{
    if (id.x >= arrayLength(&particles)) {
        return;
    }

    let particle = particles[id.x];

    let binIndex = getBinInfo(vec2f(particle.x, particle.y), simulationOptions).binIndex;

    atomicAdd(&binSize[binIndex + 1], 1u);
}
`;

const binPrefixSumShader = 
`
@group(0) @binding(0) var<storage, read> source : array<u32>;
@group(0) @binding(1) var<storage, read_write> destination : array<u32>;
@group(0) @binding(2) var<uniform> stepSize : u32;

@compute @workgroup_size(64)
fn prefixSumStep(@builtin(global_invocation_id) id : vec3u)
{
    if (id.x >= arrayLength(&source)) {
        return;
    }

    if (id.x < stepSize) {
        destination[id.x] = source[id.x];
    } else {
        destination[id.x] = source[id.x - stepSize] + source[id.x];
    }
}
`;

const particleSortShader = 
`
${particleDescription}
${simulationOptionsDescription}

@group(0) @binding(0) var<storage, read> source : array<Particle>;
@group(0) @binding(1) var<storage, read_write> destination : array<Particle>;
@group(0) @binding(2) var<storage, read> binOffset : array<u32>;
@group(0) @binding(3) var<storage, read_write> binSize : array<atomic<u32>>;

@group(1) @binding(0) var<uniform> simulationOptions : SimulationOptions;

@compute @workgroup_size(64)
fn clearBinSize(@builtin(global_invocation_id) id : vec3u)
{
    if (id.x >= arrayLength(&binSize)) {
        return;
    }

    atomicStore(&binSize[id.x], 0u);
}

@compute @workgroup_size(64)
fn sortParticles(@builtin(global_invocation_id) id : vec3u)
{
    if (id.x >= arrayLength(&source)) {
        return;
    }

    let particle = source[id.x];

    let binIndex = getBinInfo(vec2f(particle.x, particle.y), simulationOptions).binIndex;

    let newParticleIndex = binOffset[binIndex] + atomicAdd(&binSize[binIndex], 1);
    destination[newParticleIndex] = particle;
}
`;

const particleComputeForcesShader = 
`
${particleDescription}
${forceDescription}
${simulationOptionsDescription}

@group(0) @binding(0) var<storage, read_write> particles : array<Particle>;
@group(0) @binding(1) var<storage, read> binOffset : array<u32>;
@group(0) @binding(2) var<storage, read> forces : array<Force>;

@group(1) @binding(0) var<uniform> simulationOptions : SimulationOptions;

@compute @workgroup_size(64)
fn computeForces(@builtin(global_invocation_id) id : vec3u)
{
    if (id.x >= arrayLength(&particles)) {
        return;
    }

    var particle = particles[id.x];
    let species = u32(particle.species);

    let binInfo = getBinInfo(vec2f(particle.x, particle.y), simulationOptions);

    let binXMin = max(0, binInfo.binId.x - 1);
    let binYMin = max(0, binInfo.binId.y - 1);

    let binXMax = min(binInfo.gridSize.x - 1, binInfo.binId.x + 1);
    let binYMax = min(binInfo.gridSize.y - 1, binInfo.binId.y + 1);

    var totalForce = vec2f(0.0, 0.0);

    totalForce -= vec2f(particle.x, particle.y) * simulationOptions.centralForce;

    for (var binX = binXMin; binX <= binXMax; binX += 1) {
        for (var binY = binYMin; binY <= binYMax; binY += 1) {
            let binIndex = binY * binInfo.gridSize.x + binX;
            let binStart = binOffset[binIndex];
            let binEnd = binOffset[binIndex + 1];

            for (var j = binStart; j < binEnd; j += 1) {
                if (j == id.x) {
                    continue;
                }

                let other = particles[j];
                let otherSpecies = u32(other.species);

                let force = forces[species * u32(simulationOptions.speciesCount) + otherSpecies];

                let r = vec2f(other.x, other.y) - vec2f(particle.x, particle.y);
                let d = length(r);
                if (d > 0.0) {
                    let n = r / d;

                    totalForce += force.strength * max(0.0, 1.0 - d / force.radius) * n;
                    totalForce -= force.collisionStrength * max(0.0, 1.0 - d / force.collisionRadius) * n;
                }
            }
        }
    }

    // Assume mass = 1
    particle.vx += totalForce.x * simulationOptions.dt;
    particle.vy += totalForce.y * simulationOptions.dt;

    particles[id.x] = particle;
}
`;

const particleAdvanceShader =
`
${particleDescription}
${simulationOptionsDescription}

@group(0) @binding(0) var<storage, read_write> particles : array<Particle>;

@group(1) @binding(0) var<uniform> simulationOptions : SimulationOptions;

@compute @workgroup_size(64)
fn particleAdvance(@builtin(global_invocation_id) id : vec3u)
{
    if (id.x >= arrayLength(&particles)) {
        return;
    }

    var particle = particles[id.x];

    particle.vx *= simulationOptions.friction;
    particle.vy *= simulationOptions.friction;

    particle.x += particle.vx * simulationOptions.dt;
    particle.y += particle.vy * simulationOptions.dt;

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

    particles[id.x] = particle;
}
`;

const particleRenderShader =
`
${particleDescription}
${speciesDescription}

struct Camera
{
    center : vec2f,
    extent : vec2f,
    pixelsPerUnit : f32,
}

@group(0) @binding(0) var<storage, read> particles : array<Particle>;
@group(0) @binding(1) var<storage, read> species : array<Species>;

@group(1) @binding(0) var<uniform> camera : Camera;

struct CircleVertexOut
{
    @builtin(position) position : vec4f,
    @location(0) offset : vec2f,
    @location(1) color : vec4f,
}

const offsets = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0),
);

@vertex
fn vertexGlow(@builtin(vertex_index) id : u32) -> CircleVertexOut
{
    let particle = particles[id / 6u];
    let offset = offsets[id % 6u];
    let position = vec2f(particle.x, particle.y) + 12.0 * offset;
    return CircleVertexOut(
        vec4f((position - camera.center) / camera.extent, 0.0, 1.0),
        offset,
        species[u32(particle.species)].color
    );
}

@fragment
fn fragmentGlow(in : CircleVertexOut) -> @location(0) vec4f
{
    let l = length(in.offset);
    let alpha = exp(- 6.0 * l * l) / 64.0;
    return in.color * vec4f(1.0, 1.0, 1.0, alpha);
}

@vertex
fn vertexCircle(@builtin(vertex_index) id : u32) -> CircleVertexOut
{
    let particle = particles[id / 6u];
    let offset = offsets[id % 6u] * 1.5;
    let position = vec2f(particle.x, particle.y) + offset;
    return CircleVertexOut(
        vec4f((position - camera.center) / camera.extent, 0.0, 1.0),
        offset,
        species[u32(particle.species)].color
    );
}

@fragment
fn fragmentCircle(in : CircleVertexOut) -> @location(0) vec4f
{
    let alpha = clamp(camera.pixelsPerUnit - length(in.offset) * camera.pixelsPerUnit + 0.5, 0.0, 1.0);
    return in.color * vec4f(1.0, 1.0, 1.0, alpha);
}

@vertex
fn vertexPoint(@builtin(vertex_index) id : u32) -> CircleVertexOut
{
    let particle = particles[id / 6u];
    let offset = 2.0 * offsets[id % 6u] / camera.pixelsPerUnit;
    let position = vec2f(particle.x, particle.y) + offset;
    return CircleVertexOut(
        vec4f((position - camera.center) / camera.extent, 0.0, 1.0),
        offset,
        species[u32(particle.species)].color
    );
}

const PI = 3.1415926535;

@fragment
fn fragmentPoint(in : CircleVertexOut) -> @location(0) vec4f
{
    let d = max(vec2(0.0), min(in.offset * camera.pixelsPerUnit + 0.5, vec2(camera.pixelsPerUnit)) - max(in.offset * camera.pixelsPerUnit - 0.5, - vec2(camera.pixelsPerUnit)));
    let alpha = (PI / 4.0) * d.x * d.y;
    return vec4f(in.color.rgb, in.color.a * alpha);
}
`;

const composeShader =
`
@group(0) @binding(0) var hdrTexture : texture_2d<f32>;
@group(0) @binding(1) var blueNoiseTexture : texture_2d<f32>;

const vertices = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
);

struct VertexOut
{
    @builtin(position) position : vec4f,
    @location(0) texcoord : vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) id : u32) -> VertexOut
{
    let vertex = vertices[id];
    return VertexOut(
        vec4f(vertex, 0.0, 1.0),
        vertex * 0.5 + vec2f(0.5)
    );
}

fn acesTonemap(x : vec3f) -> vec3f
{
    let a = 2.51;
    let b = 0.03;
    let c = 2.43;
    let d = 0.59;
    let e = 0.14;
    return clamp((x*(a*x+b))/(x*(c*x+d)+e), vec3f(0.0), vec3f(1.0));
}

fn maxTonemap(x : vec3f) -> vec3f
{
    let m = max(1.0, max(x.r, max(x.g, x.b)));
    return x / m;
}

fn uncharted2TonemapImpl(x : vec3f) -> vec3f
{
    let A = 0.15;
    let B = 0.50;
    let C = 0.10;
    let D = 0.20;
    let E = 0.02;
    let F = 0.30;

    return ((x*(A*x+C*B)+D*E)/(x*(A*x+B)+D*F))-E/F;
}

fn uncharted2Tonemap(x : vec3f) -> vec3f
{
    let exposure = 5.0;
    let white = 10.0;
    return uncharted2TonemapImpl(x * exposure) / uncharted2TonemapImpl(vec3f(white));
}

fn agxTonemap(x : vec3f) -> vec3f
{
    const M1 = mat3x3f(0.842, 0.0423, 0.0424, 0.0784, 0.878, 0.0784, 0.0792, 0.0792, 0.879);
    const M2 = mat3x3f(1.2, -0.053, -0.053, -0.1, 1.15, -0.1, -0.1, -0.1, 1.15);
    const c1 = 12.47393;
    const c2 = 16.5;

    var result = x * 0.5;
    result = M1 * result;
    result = clamp((log2(result) + c1) / c2, vec3f(0.0), vec3f(1.0));
    result = 0.5 + 0.5 * sin(((-3.11 * result + 6.42) * result - 0.378) * result - 1.44);
    result = M2 * result;

    return result;
}

fn dither(x : vec3f, n : f32) -> vec3f
{
    let c = x * 255.0;
    let c0 = floor(c);
    let c1 = c0 + vec3f(1.0);
    let dc = c - c0;

    var r = c0;
    if (dc.r > n) { r.r = c1.r; }
    if (dc.g > n) { r.g = c1.g; }
    if (dc.b > n) { r.b = c1.b; }

    return r / 255.0;
}

@fragment
fn fragmentMain(in : VertexOut) -> @location(0) vec4f
{
    var sample = textureLoad(hdrTexture, vec2i(in.position.xy), 0); 
    let noise = textureLoad(blueNoiseTexture, vec2u(in.position.xy) % textureDimensions(blueNoiseTexture), 0).r;

    var color = sample.rgb;
    color = acesTonemap(color);
    color = pow(color, vec3f(1.0 / 2.2));
    color = dither(color, noise);

    return vec4f(color, 1.0);
}
`;

/** @type {HTMLCanvasElement} */
var canvas;
/** @type {GPUCanvasContext} */
var context;
/** @type {GPUSurfaceFormat} */
var surfaceFormat;

/** @type {GPUDevice} */
var device;

const hdrFormat = 'rgba16float';

const maxForceRadius = 32.0;
const maxForceStrength = 100.0;
const initialVelocity = 10.0;

var speciesCount = 8;
var particleCount = 65536;
var simulationBox = [[-800, 800], [-450, 450]];
var friction = 10.0;
var centralForce = 0.0;
var symmetricForces = false;
var gridSize = [Math.ceil((simulationBox[0][1] - simulationBox[0][0]) / maxForceRadius), Math.ceil((simulationBox[1][1] - simulationBox[1][0]) / maxForceRadius)];
var binCount = gridSize[0] * gridSize[1];
var prefixSumIterations = Math.ceil(Math.ceil(Math.log2(binCount + 1)) / 2) * 2;

var currentSystemDescription;

var speciesBuffer;
var forcesBuffer;
var particleBuffer;
var particleTempBuffer;
var binOffsetBuffer;
var binOffsetTempBuffer;
var binPrefixSumStepSizeBuffer;
var cameraBuffer;
var simulationOptionsBuffer;

var blueNoiseTexture;
var blueNoiseTextureView;
var hdrTexture;
var hdrTextureView;

var particleBufferBindGroupLayout;
var particleBufferReadOnlyBindGroupLayout;
var cameraBindGroupLayout;
var simulationOptionsBindGroupLayout;
var binFillSizeBindGroupLayout;
var binPrefixSumBindGroupLayout;
var particleSortBindGroupLayout;
var particleComputeForcesBindGroupLayout;
var composeBindGroupLayout;

var particleBufferBindGroup;
var particleBufferReadOnlyBindGroup;
var binFillSizeBindGroup;
var binPrefixSumBindGroup = [null, null];
var particleSortBindGroup;
var particleComputeForcesBindGroup;
var cameraBindGroup;
var simulationOptionsBindGroup;
var composeBindGroup;

var binClearSizePipeline;
var binFillSizePipeline;
var binPrefixSumPipeline;
var particleSortClearSizePipeline;
var particleSortPipeline;
var particleComputeForcesPipeline;
var particleAdvancePipeline;
var particleRenderGlowPipeline;
var particleRenderPipeline;
var particleRenderPointPipeline;
var composePipeline;

var cameraCenter = [0.0, 0.0];
var cameraExtentX = simulationBox[0][1];
var cameraExtentY = simulationBox[1][1];
var cameraExtentXTarget = simulationBox[0][1];

var zoomAnchor = null;

var lastFrameTimestamp = window.performance.now() / 1000.0;

var mouseDrag = null;

const activeTouches = new Map();

var frameID = 0;
var framesInFlight = 0;

var paused = false;
var toolsPanelShown = true;

function redraw()
{
    if (framesInFlight > 3) {
        requestAnimationFrame(redraw);
        return;
    }

    const now = window.performance.now() / 1000.0;

    const dt = now - lastFrameTimestamp;
    lastFrameTimestamp = now;

    const aspectRatio = canvas.width / canvas.height;
    const cameraExtentXDelta = (cameraExtentXTarget - cameraExtentX) * (- Math.expm1(- 20 * dt));

    cameraExtentX += cameraExtentXDelta;
    cameraExtentY = cameraExtentX / aspectRatio;

    if (zoomAnchor) {
        cameraCenter[0] -= cameraExtentXDelta * zoomAnchor[0];
        cameraCenter[1] -= cameraExtentXDelta * zoomAnchor[1] / aspectRatio;
    }

    const pixelsPerUnit = canvas.width / (2.0 * cameraExtentX);

    const toolsPanel = document.getElementById("toolsPanel");
    var toolsPanelAlpha = Number(toolsPanel.style.opacity);
    toolsPanelAlpha += ((toolsPanelShown ? 1.0 : 0.0) - toolsPanelAlpha) * (- Math.expm1(- 20 * dt));
    toolsPanel.style.opacity = toolsPanelAlpha;
    toolsPanel.style.visibility = (toolsPanelAlpha < 0.01) ? "hidden" : "visible";

    const simDt = Math.min(0.025, dt);

    const frictionFactor = Math.exp(- simDt * friction);

    device.queue.writeBuffer(simulationOptionsBuffer, 0, new Float32Array([simulationBox[0][0], simulationBox[0][1], simulationBox[1][0], simulationBox[1][1], frictionFactor, simDt, maxForceRadius, speciesCount, centralForce]));
    device.queue.writeBuffer(cameraBuffer, 0, new Float32Array([cameraCenter[0], cameraCenter[1], cameraExtentX, cameraExtentY, pixelsPerUnit]));
 
    const encoder = device.createCommandEncoder({});

    if (!paused) {
        encoder.copyBufferToBuffer(particleBuffer, 0, particleTempBuffer, 0, particleBuffer.size);

        const computePass = encoder.beginComputePass({});

        computePass.setBindGroup(1, simulationOptionsBindGroup);

        computePass.setBindGroup(0, particleBufferReadOnlyBindGroup);
        computePass.setBindGroup(2, binFillSizeBindGroup);
        computePass.setPipeline(binClearSizePipeline);
        computePass.dispatchWorkgroups(Math.ceil((binCount + 1) / 64));
        computePass.setPipeline(binFillSizePipeline);
        computePass.dispatchWorkgroups(Math.ceil(particleCount / 64));

        computePass.setPipeline(binPrefixSumPipeline);
        for (var i = 0; i < prefixSumIterations; ++i) {
            computePass.setBindGroup(0, binPrefixSumBindGroup[i % 2], [i * 256]);
            computePass.dispatchWorkgroups(Math.ceil((binCount + 1) / 64));
        }

        computePass.setBindGroup(0, particleSortBindGroup);
        computePass.setPipeline(particleSortClearSizePipeline);
        computePass.dispatchWorkgroups(Math.ceil((binCount + 1) / 64));
        computePass.setPipeline(particleSortPipeline);
        computePass.dispatchWorkgroups(Math.ceil(particleCount / 64));

        computePass.setBindGroup(0, particleComputeForcesBindGroup);
        computePass.setPipeline(particleComputeForcesPipeline);
        computePass.dispatchWorkgroups(Math.ceil(particleCount / 64));

        computePass.setBindGroup(0, particleBufferBindGroup);
        computePass.setPipeline(particleAdvancePipeline);
        computePass.dispatchWorkgroups(Math.ceil(particleCount / 64));

        computePass.end();
    }
 
    const hdrRenderPass = encoder.beginRenderPass({
        colorAttachments: [
            {
                view: hdrTextureView,
                clearValue: [0.001, 0.001, 0.001, 0.0],
                loadOp: 'clear',
                storeOp: 'store',
            },
        ],
    });
    hdrRenderPass.setBindGroup(0, particleBufferReadOnlyBindGroup);
    hdrRenderPass.setBindGroup(1, cameraBindGroup);
    hdrRenderPass.setPipeline(particleRenderGlowPipeline);
    hdrRenderPass.draw(particleCount * 6);
    if (pixelsPerUnit < 1.0) {
        hdrRenderPass.setPipeline(particleRenderPointPipeline);
        hdrRenderPass.draw(particleCount * 6);
    } else {
        hdrRenderPass.setPipeline(particleRenderPipeline);
        hdrRenderPass.draw(particleCount * 6);
    }
    hdrRenderPass.end();
 
    const composeRenderPass = encoder.beginRenderPass({
        colorAttachments: [
            {
                view: context.getCurrentTexture().createView(),
                clearValue: [0, 0, 0, 0],
                loadOp: 'clear',
                storeOp: 'store',
            },
        ],
    });
    composeRenderPass.setBindGroup(0, composeBindGroup);
    composeRenderPass.setPipeline(composePipeline);
    composeRenderPass.draw(3);
    composeRenderPass.end();
 
    const commandBuffer = encoder.finish();
    device.queue.submit([commandBuffer]);

    ++framesInFlight;

    device.queue.onSubmittedWorkDone().then(() => { --framesInFlight; });

    ++frameID;

    requestAnimationFrame(redraw);
}

function centerView()
{
    cameraCenter = [0.0, 0.0];
    zoomAnchor = null;
    cameraExtentXTarget = simulationBox[0][1];
}

function reloadForces(systemDescription)
{
    const forces = new Float32Array(speciesCount * speciesCount * 4);
    for (var i = 0; i < speciesCount; ++i)
    {
        for (var j = 0; j < speciesCount; ++j)
        {
            forces[4 * (i * speciesCount + j) + 0] = systemDescription.species[i].forces[j].strength;
            forces[4 * (i * speciesCount + j) + 1] = systemDescription.species[i].forces[j].radius;
            forces[4 * (i * speciesCount + j) + 2] = systemDescription.species[i].forces[j].collisionStrength;
            forces[4 * (i * speciesCount + j) + 3] = systemDescription.species[i].forces[j].collisionRadius;
        }
    }
    
    device.queue.writeBuffer(forcesBuffer, 0, forces);
}

function loadSystem(systemDescription)
{
    currentSystemDescription = systemDescription;

    particleCount = systemDescription.particleCount;
    speciesCount = systemDescription.species.length;

    if (systemDescription.friction == undefined)
        systemDescription.friction = 10.0;

    if (systemDescription.centralForce == undefined)
        systemDescription.centralForce = 0.0;

    if (systemDescription.symmetricForces == undefined)
        systemDescription.symmetricForces = false;

    friction = systemDescription.friction;
    centralForce = systemDescription.centralForce;
    symmetricForces = systemDescription.symmetricForces;

    document.getElementById("particleCountSlider").value = Math.round(Math.log2(particleCount));
    document.getElementById("particleCountText").innerText = `${particleCount} particles`;
    document.getElementById("speciesCountSlider").value = speciesCount;
    document.getElementById("speciesCountText").innerText = `${speciesCount} particle types`;
    document.getElementById("simulationWidthSlider").value = Math.round(systemDescription.simulationSize[0] / 100);
    document.getElementById("simulationWidthText").innerText = `Width: ${systemDescription.simulationSize[0]}`;
    document.getElementById("simulationHeightSlider").value = Math.round(systemDescription.simulationSize[1] / 100);
    document.getElementById("simulationHeightText").innerText = `Height: ${systemDescription.simulationSize[1]}`;
    document.getElementById("frictionSlider").value = Math.round(friction);
    document.getElementById("frictionText").innerText = `Friction: ${friction}`;

    const W = systemDescription.simulationSize[0] / 2.0;
    const H = systemDescription.simulationSize[1] / 2.0;

    simulationBox = [[-W, W], [-H, H]];

    gridSize = [Math.ceil(systemDescription.simulationSize[0] / maxForceRadius), Math.ceil(systemDescription.simulationSize[1] / maxForceRadius)];
    binCount = gridSize[0] * gridSize[1];
    prefixSumIterations = Math.ceil(Math.ceil(Math.log2(binCount + 1)) / 2) * 2;

    const species = new Float32Array(speciesCount * 4);
    for (var i = 0; i < speciesCount; ++i)
    {
        species[4 * i + 0] = systemDescription.species[i].color[0];
        species[4 * i + 1] = systemDescription.species[i].color[1];
        species[4 * i + 2] = systemDescription.species[i].color[2];
        species[4 * i + 3] = 1.0;
    }

    speciesBuffer = device.createBuffer({
        size: speciesCount * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });
    
    device.queue.writeBuffer(speciesBuffer, 0, species);

    forcesBuffer = device.createBuffer({
        size: speciesCount * speciesCount * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE,
    });

    reloadForces(systemDescription);

    const initialParticles = new Float32Array(particleCount * 5);

    for (var i = 0; i < particleCount; ++i)
    {
        initialParticles[5 * i + 0] = simulationBox[0][0] + Math.random() * (simulationBox[0][1] - simulationBox[0][0]);
        initialParticles[5 * i + 1] = simulationBox[1][0] + Math.random() * (simulationBox[1][1] - simulationBox[1][0]);
        initialParticles[5 * i + 2] = initialVelocity * (-1.0 + Math.random() * 2.0);
        initialParticles[5 * i + 3] = initialVelocity * (-1.0 + Math.random() * 2.0);
        initialParticles[5 * i + 4] = Math.floor(Math.random() * speciesCount);
    }

    particleBuffer = device.createBuffer({
        size: particleCount * 20,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.STORAGE,
    });

    device.queue.writeBuffer(particleBuffer, 0, initialParticles);

    particleTempBuffer = device.createBuffer({
        size: particleBuffer.size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    binOffsetBuffer = device.createBuffer({
        size: (binCount + 1) * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    binOffsetTempBuffer = device.createBuffer({
        size: (binCount + 1) * 4,
        usage: GPUBufferUsage.STORAGE,
    });

    const binPrefixSumStepSize = new Uint32Array(prefixSumIterations * 64);
    for (var i = 0; i < prefixSumIterations; ++i)
        binPrefixSumStepSize[i * 64] = Math.pow(2, i);

    binPrefixSumStepSizeBuffer = device.createBuffer({
        size: prefixSumIterations * 256,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });

    device.queue.writeBuffer(binPrefixSumStepSizeBuffer, 0, binPrefixSumStepSize);

    particleBufferBindGroup = device.createBindGroup({
        layout: particleBufferBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: particleBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: forcesBuffer,
                },
            },
        ],
    });

    particleBufferReadOnlyBindGroup = device.createBindGroup({
        layout: particleBufferReadOnlyBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: particleBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: speciesBuffer,
                },
            },
        ],
    });

    binFillSizeBindGroup = device.createBindGroup({
        layout: binFillSizeBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: binOffsetBuffer,
                },
            },
        ],
    });

    binPrefixSumBindGroup[0] = device.createBindGroup({
        layout: binPrefixSumBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: binOffsetBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: binOffsetTempBuffer,
                },
            },
            {
                binding: 2,
                resource: {
                    buffer: binPrefixSumStepSizeBuffer,
                    size: 4,
                },
            },
        ],
    });

    binPrefixSumBindGroup[1] = device.createBindGroup({
        layout: binPrefixSumBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: binOffsetTempBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: binOffsetBuffer,
                },
            },
            {
                binding: 2,
                resource: {
                    buffer: binPrefixSumStepSizeBuffer,
                    size: 4,
                },
            },
        ],
    });

    particleSortBindGroup = device.createBindGroup({
        layout: particleSortBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: particleTempBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: particleBuffer,
                },
            },
            {
                binding: 2,
                resource: {
                    buffer: binOffsetBuffer,
                },
            },
            {
                binding: 3,
                resource: {
                    buffer: binOffsetTempBuffer,
                },
            },
        ],
    });

    particleComputeForcesBindGroup = device.createBindGroup({
        layout: particleComputeForcesBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: particleBuffer,
                },
            },
            {
                binding: 1,
                resource: {
                    buffer: binOffsetBuffer,
                },
            },
            {
                binding: 2,
                resource: {
                    buffer: forcesBuffer,
                },
            },
        ],
    });
}

function symmetrizeForces(systemDescription)
{
    const speciesCount = systemDescription.species.length;

    for (var i = 0; i < speciesCount; ++i) {
        for (var j = i + 1; j < speciesCount; ++j) {
            const forceij = systemDescription.species[i].forces[j];
            const forceji = systemDescription.species[j].forces[i];

            const strength = (forceij.strength + forceji.strength) / 2.0;
            const radius = (forceij.radius + forceji.radius) / 2.0;
            const collisionStrength = (forceij.collisionStrength + forceji.collisionStrength) / 2.0;
            const collisionRadius = (forceij.collisionRadius + forceji.collisionRadius) / 2.0;

            forceij.strength = strength;
            forceji.strength = strength;
            forceij.radius = radius;
            forceji.radius = radius;
            forceij.collisionStrength = collisionStrength;
            forceji.collisionStrength = collisionStrength;
            forceij.collisionRadius = collisionRadius;
            forceji.collisionRadius = collisionRadius;
        }
    }
}

function randomizeSystem(systemDescription)
{
    const speciesCount = systemDescription.species.length;
    systemDescription.species = [];

    for (var i = 0; i < speciesCount; ++i)
    {
        const color = [
            Math.pow(0.25 + Math.random() * 0.75, 2.2),
            Math.pow(0.25 + Math.random() * 0.75, 2.2),
            Math.pow(0.25 + Math.random() * 0.75, 2.2),
            1.0,
        ];

        var forces = [];
        for (var j = 0; j < speciesCount; ++j) {
            const strength = maxForceStrength * (0.25 + 0.75 * Math.random()) * (Math.random() < 0.5 ? 1.0 : -1.0);
            const collisionStrength = (5.0 + 15.0 * Math.random()) * strength;
            const radius = 2.0 + Math.random() * (maxForceRadius - 2.0);
            const collisionRadius = Math.random() * 0.5 * radius;
            forces.push({
                strength: strength,
                collisionStrength: collisionStrength,
                radius: radius,
                collisionRadius : collisionRadius,
            });
        }

        systemDescription.species.push({
            color: color,
            forces: forces,
        });
    }

    if (systemDescription.symmetricForces) {
        symmetrizeForces(systemDescription);
    }

    return systemDescription;
}

function initialSystem()
{
    const systemDescription = {
        particleCount: particleCount,
        species: new Array(speciesCount),
        simulationSize: [1600.0, 900.0],
        friction: friction,
        centralForce: centralForce,
        symmetricForces: symmetricForces,
    };
    return randomizeSystem(systemDescription);
}

function resize()
{
    if (!canvas)
        return;
    
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    hdrTexture = device.createTexture({
        format: hdrFormat,
        size: [canvas.width, canvas.height, 1],
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    hdrTextureView = hdrTexture.createView({});

    composeBindGroup = device.createBindGroup({
        layout: composeBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: hdrTextureView,
            },
            {
                binding: 1,
                resource: blueNoiseTextureView,
            },
        ],
    });
}

async function loadImage(url) {
    const res = await fetch(url);
    const blob = await res.blob();
    return await createImageBitmap(blob, { colorSpaceConversion: 'none' });
}

async function init()
{
    const buttonsTable = document.getElementById("buttonsTable");
    const toolsPanelStyle = window.getComputedStyle(document.getElementById("toolsPanel"), null);
    buttonsTable.style.width = buttonsTable.parentElement.clientWidth - parseFloat(toolsPanelStyle.getPropertyValue('padding-left')) - parseFloat(toolsPanelStyle.getPropertyValue('padding-right'));


    canvas = document.getElementById("mainCanvas");

    // Mouse event listeners
    canvas.addEventListener('wheel', function(event) {
        const factor = Math.pow(1.25, event.deltaY / 120);
        cameraExtentXTarget *= factor;

        zoomAnchor = [
            2.0 * event.x / canvas.width - 1.0,
            1.0 - 2.0 * event.y / canvas.height,
        ];

        event.preventDefault();
    }, false);

    canvas.addEventListener('mousedown', function(event) {
        mouseDrag = [event.clientX, event.clientY];
        event.preventDefault();
    }, false);

    canvas.addEventListener('mouseup', function(event) {
        mouseDrag = null;
        event.preventDefault();
    }, false);

    canvas.addEventListener('mousemove', function(event) {
        if (mouseDrag) {
            const delta = [event.clientX - mouseDrag[0], event.clientY - mouseDrag[1]];

            cameraCenter[0] -= delta[0] / canvas.width * cameraExtentX * 2.0;
            cameraCenter[1] += delta[1] / canvas.height * cameraExtentY * 2.0;

            mouseDrag = [event.clientX, event.clientY];
        }
        event.preventDefault();
    }, false);

    // Touch event listeners
    canvas.addEventListener("touchstart", function(event) {
        for (const touch of event.changedTouches) {
            activeTouches.set(touch.identifier, [touch.pageX, touch.pageY]);
        }

        if (activeTouches.size == 3) {
            toolsPanelShown = !toolsPanelShown;
        }

        event.preventDefault();
    });

    canvas.addEventListener("touchmove", function(event) {
        const oldTouches = new Map(activeTouches);

        for (const touch of event.changedTouches) {
            activeTouches.set(touch.identifier, [touch.pageX, touch.pageY]);
        }

        if (oldTouches.size == 1 && activeTouches.size == 1) {
            const oldPosition = oldTouches.entries().next().value[1];
            const newPosition = activeTouches.entries().next().value[1];
            const delta = [newPosition[0] - oldPosition[0], newPosition[1] - oldPosition[1]];

            cameraCenter[0] -= delta[0] / canvas.width * cameraExtentX * 2.0;
            cameraCenter[1] += delta[1] / canvas.height * cameraExtentY * 2.0;
        }

        if (oldTouches.size == 2 && activeTouches.size == 2) {
            const oldIterator = oldTouches.entries();
            const newIterator = activeTouches.entries();

            const oldPosition1 = oldIterator.next().value[1];
            const oldPosition2 = oldIterator.next().value[1];

            const newPosition1 = newIterator.next().value[1];
            const newPosition2 = newIterator.next().value[1];

            const oldCenter = [(oldPosition2[0] + oldPosition1[0]) / 2, (oldPosition2[1] + oldPosition1[1]) / 2];
            const newCenter = [(newPosition2[0] + newPosition1[0]) / 2, (newPosition2[1] + newPosition1[1]) / 2];

            zoomAnchor = [
                2.0 * newCenter[0] / canvas.width - 1.0,
                1.0 - 2.0 * newCenter[1] / canvas.height,
            ];

            const delta = [newCenter[0] - oldCenter[0], newCenter[1] - oldCenter[1]];

            const oldDelta = [oldPosition2[0] - oldPosition1[0], oldPosition2[1] - oldPosition1[1]];
            const newDelta = [newPosition2[0] - newPosition1[0], newPosition2[1] - newPosition1[1]];

            const oldDistance = Math.sqrt(oldDelta[0] * oldDelta[0] + oldDelta[1] * oldDelta[1]);
            const newDistance = Math.sqrt(newDelta[0] * newDelta[0] + newDelta[1] * newDelta[1]);

            cameraCenter[0] -= delta[0] / canvas.width * cameraExtentX * 2.0;
            cameraCenter[1] += delta[1] / canvas.height * cameraExtentY * 2.0;
            cameraExtentXTarget *= oldDistance / newDistance;
        }

        event.preventDefault();
    });

    canvas.addEventListener("touchend", function(event) {
        for (const touch of event.changedTouches) {
            activeTouches.delete(touch.identifier);
        }
        event.preventDefault();
    });

    canvas.addEventListener("touchcancel", function(event) {
        for (const touch of event.changedTouches) {
            activeTouches.delete(touch.identifier);
        }
    });

    window.addEventListener('keydown',function(event) {
        if (event.key == ' ') {
            pauseClicked();
            event.preventDefault();
        }

        if (event.key == 'c') {
            centerView();
            event.preventDefault();
        }

        if (event.key == 's') {
            toolsPanelShown = !toolsPanelShown;
            event.preventDefault();
        }
    }, false);

    if (!navigator) {
        alert("Your browser doesn't support WebGPU (navigator` is null)");
        return;
    }

    if (!navigator.gpu) {
        alert("Your browser doesn't support WebGPU (navigator.gpu is null)");
        return;
    }

    const adapter = await navigator.gpu?.requestAdapter();

    if (!adapter) {
        alert("Your browser doesn't support WebGPU (failed to create adapter)");
        return;
    }

    device = await adapter?.requestDevice();

    if (!device) {
        alert("Your browser doesn't support WebGPU (failed to create device)");
        return;
    }

    context = canvas.getContext('webgpu');
    surfaceFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
        device,
        format: surfaceFormat,
    });

    cameraBuffer = device.createBuffer({
        size: 24,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });

    simulationOptionsBuffer = device.createBuffer({
        size: 36,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
    });

    const binFillSizeShaderModule = device.createShaderModule({
        code: binFillSizeShader,
    });

    const binPrefixSumShaderModule = device.createShaderModule({
        code: binPrefixSumShader,
    });

    const particleSortShaderModule = device.createShaderModule({
        code: particleSortShader,
    });

    const particleComputeForcesShaderModule = device.createShaderModule({
        code: particleComputeForcesShader,
    });

    const particleAdvanceShaderModule = device.createShaderModule({
        code: particleAdvanceShader,
    });

    const particleRenderShaderModule = device.createShaderModule({
        code: particleRenderShader,
    });

    const composeShaderModule = device.createShaderModule({
        code: composeShader,
    });

    particleBufferBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'storage',
                },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'read-only-storage',
                },
            },
        ],
    });

    particleBufferReadOnlyBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'read-only-storage',
                },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'read-only-storage',
                },
            },
        ],
    });

    cameraBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                buffer: {
                    type: 'uniform',
                },
            },
        ],
    });

    cameraBindGroup = device.createBindGroup({
        layout: cameraBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: cameraBuffer,
                },
            },
        ],
    });

    simulationOptionsBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'uniform',
                },
            },
        ],
    });

    simulationOptionsBindGroup = device.createBindGroup({
        layout: simulationOptionsBindGroupLayout,
        entries: [
            {
                binding: 0,
                resource: {
                    buffer: simulationOptionsBuffer,
                },
            },
        ],
    });

    binFillSizeBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'storage',
                },
            },
        ],
    });

    binPrefixSumBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'read-only-storage',
                },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'storage',
                },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'uniform',
                    hasDynamicOffset: true,
                },
            },
        ],
    });

    particleSortBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'read-only-storage',
                },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'storage',
                },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'read-only-storage',
                },
            },
            {
                binding: 3,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'storage',
                },
            },
        ],
    });

    particleComputeForcesBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'storage',
                },
            },
            {
                binding: 1,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'read-only-storage',
                },
            },
            {
                binding: 2,
                visibility: GPUShaderStage.COMPUTE,
                buffer: {
                    type: 'read-only-storage',
                },
            },
        ],
    });

    composeBindGroupLayout = device.createBindGroupLayout({
        entries: [
            {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {},
            },
            {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                texture: {},
            },
        ],
    });

    binClearSizePipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                particleBufferReadOnlyBindGroupLayout,
                simulationOptionsBindGroupLayout,
                binFillSizeBindGroupLayout,
            ],
        }),
        compute: {
            module: binFillSizeShaderModule,
            entryPoint: 'clearBinSize',
        },
    });

    binFillSizePipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                particleBufferReadOnlyBindGroupLayout,
                simulationOptionsBindGroupLayout,
                binFillSizeBindGroupLayout,
            ],
        }),
        compute: {
            module: binFillSizeShaderModule,
            entryPoint: 'fillBinSize',
        },
    });

    binPrefixSumPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                binPrefixSumBindGroupLayout,
            ],
        }),
        compute: {
            module: binPrefixSumShaderModule,
            entryPoint: 'prefixSumStep',
        },
    });

    particleSortClearSizePipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                particleSortBindGroupLayout,
                simulationOptionsBindGroupLayout,
            ],
        }),
        compute: {
            module: particleSortShaderModule,
            entryPoint: 'clearBinSize',
        },
    });

    particleSortPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                particleSortBindGroupLayout,
                simulationOptionsBindGroupLayout,
            ],
        }),
        compute: {
            module: particleSortShaderModule,
            entryPoint: 'sortParticles',
        },
    });

    particleComputeForcesPipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                particleComputeForcesBindGroupLayout,
                simulationOptionsBindGroupLayout,
            ],
        }),
        compute: {
            module: particleComputeForcesShaderModule,
            entryPoint: 'computeForces',
        },
    });

    particleAdvancePipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                particleBufferBindGroupLayout,
                simulationOptionsBindGroupLayout,
            ],
        }),
        compute: {
            module: particleAdvanceShaderModule,
            entryPoint: 'particleAdvance',
        },
    });

    particleRenderGlowPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                particleBufferReadOnlyBindGroupLayout,
                cameraBindGroupLayout,
            ],
        }),
        vertex: {
            module: particleRenderShaderModule,
            entryPoint: 'vertexGlow',
        },
        primitive: {
            topology: 'triangle-list',
        },
        fragment: {
            module: particleRenderShaderModule,
            entryPoint: 'fragmentGlow',
            targets: [
                {
                    format: hdrFormat,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one',
                        },
                    },
                },
            ],
        }
    });

    particleRenderPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                particleBufferReadOnlyBindGroupLayout,
                cameraBindGroupLayout,
            ],
        }),
        vertex: {
            module: particleRenderShaderModule,
            entryPoint: 'vertexCircle',
        },
        primitive: {
            topology: 'triangle-list',
        },
        fragment: {
            module: particleRenderShaderModule,
            entryPoint: 'fragmentCircle',
            targets: [
                {
                    format: hdrFormat,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one',
                        },
                    },
                },
            ],
        }
    });

    particleRenderPointPipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                particleBufferReadOnlyBindGroupLayout,
                cameraBindGroupLayout,
            ],
        }),
        vertex: {
            module: particleRenderShaderModule,
            entryPoint: 'vertexPoint',
        },
        primitive: {
            topology: 'triangle-list',
        },
        fragment: {
            module: particleRenderShaderModule,
            entryPoint: 'fragmentPoint',
            targets: [
                {
                    format: hdrFormat,
                    blend: {
                        color: {
                            srcFactor: 'src-alpha',
                            dstFactor: 'one',
                        },
                        alpha: {
                            srcFactor: 'one',
                            dstFactor: 'one',
                        },
                    },
                },
            ],
        }
    });

    composePipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({
            bindGroupLayouts: [
                composeBindGroupLayout,
            ],
        }),
        vertex: {
            module: composeShaderModule,
            entryPoint: 'vertexMain',
        },
        primitive: {
            topology: 'triangle-list',
        },
        fragment: {
            module: composeShaderModule,
            entryPoint: 'fragmentMain',
            targets: [
                {
                    format: surfaceFormat,
                },
            ],
        }
    });

    const blueNoiseImage = await loadImage("/blue-noise.png");
    blueNoiseTexture = device.createTexture({
        format: 'rgba8unorm-srgb',
        size: [blueNoiseImage.width, blueNoiseImage.height],
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture(
        {source: blueNoiseImage},
        {texture: blueNoiseTexture},
        {width: blueNoiseImage.width, height: blueNoiseImage.height},
    );

    blueNoiseTextureView = blueNoiseTexture.createView({});

    resize();

    loadSystem(initialSystem());

    redraw();
}

function pauseClicked()
{
    paused = !paused;
    document.getElementById("pauseButton").innerText = paused ? "Continue" : "Pause";
}

function updateParticleCount()
{
    const newParticleCount = Math.round(Math.pow(2, document.getElementById("particleCountSlider").value));

    const systemDescription = currentSystemDescription;
    systemDescription.particleCount = newParticleCount;
    loadSystem(systemDescription);
}

function updateSpeciesCount()
{
    const newSpeciesCount = Math.round(document.getElementById("speciesCountSlider").value);

    const systemDescription = currentSystemDescription;
    systemDescription.species = new Array(newSpeciesCount);
    loadSystem(randomizeSystem(systemDescription));
}

function updateSimulationSize()
{
    const newWidth = document.getElementById("simulationWidthSlider").value * 100.0;
    const newHeight = document.getElementById("simulationHeightSlider").value * 100.0;

    const systemDescription = currentSystemDescription;
    systemDescription.simulationSize = [newWidth, newHeight];
    loadSystem(systemDescription);
}

function updateFriction()
{
    const newFriction = document.getElementById("frictionSlider").value;

    currentSystemDescription.friction = newFriction;
    friction = newFriction;

    document.getElementById("frictionText").innerText = `Friction: ${newFriction}`;
}

function updateCentralForce()
{
    const newCentralForce = document.getElementById("centralForceSlider").value / 10.0;

    currentSystemDescription.centralForce = newCentralForce;
    centralForce = newCentralForce;

    document.getElementById("centralForceText").innerText = `Central force: ${newCentralForce}`;
}

function updateSymmetricForces()
{
    const newSymmetricForces = document.getElementById("symmetricForces").checked;

    currentSystemDescription.symmetricForces = newSymmetricForces;
    symmetricForces = newSymmetricForces;

    if (newSymmetricForces)
    {
        symmetrizeForces(currentSystemDescription);
        reloadForces(currentSystemDescription);
    }
}

async function saveSettings()
{
    const handle = await window.showSaveFilePicker({
        id: "particle-life",
        startIn: "downloads",
        suggestedName: "particle-life-system.json",
        types: [{
            description: "JSON file",
            accept: {"application/json": [".json"]},
        }],
    });

    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(currentSystemDescription, null, 2));
    await writable.close();
}

async function loadSettings()
{
    const [handle] = await window.showOpenFilePicker({
        id: "particle-life",
        startIn: "downloads",
        suggestedName: "particle-life-system.json",
        types: [{
            description: "JSON file",
            accept: {"application/json": [".json"]},
        }],
    });

    const file = await handle.getFile();
    const data = await file.text();
    loadSystem(JSON.parse(data));
}

window.onload = init;
window.onresize = resize;