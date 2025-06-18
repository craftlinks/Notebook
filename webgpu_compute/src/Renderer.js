// Renderer.js - Visualization rendering for Particle Life 2D
// Handles all rendering-specific functionality including shaders, pipelines, and drawing

/**
 * Renderer class handles all visualization aspects of the particle simulation
 */
export class Renderer {
    /**
     * @param {GPUDevice} device - WebGPU device
     * @param {GPUCanvasContext} context - Canvas context
     * @param {HTMLCanvasElement} canvas - Canvas element
     */
    constructor(device, context, canvas) {
        this.device = device;
        this.context = context;
        this.canvas = canvas;
        
        // Camera state
        this.cameraCenter = [0.0, 0.0];
        this.cameraExtentX = 512.0; // Will be updated based on simulation
        this.cameraExtentY = 512.0;
        this.cameraExtentXTarget = 512.0;
        
        // Rendering pipelines
        this.particleRenderGlowPipeline = null;
        this.particleRenderPipeline = null;
        this.particleRenderPointPipeline = null;
        this.composePipeline = null;
        
        // Buffers and resources
        this.cameraBuffer = null;
        this.hdrTexture = null;
        this.hdrTextureView = null;
        this.blueNoiseTexture = null;
        this.blueNoiseTextureView = null;
        
        // Bind groups
        this.cameraBindGroup = null;
        this.composeBindGroup = null;
        
        this.initializeShaders();
    }
    
    /**
     * Initialize all rendering shaders
     */
    initializeShaders() {
        // Particle description shared between compute and render
        this.particleDescription = `
struct Particle
{
    x : f32,
    y : f32,
    vx : f32,
    vy : f32,
    species : f32,
}
`;

        // Species description for rendering
        this.speciesDescription = `
struct Species
{
    color : vec4f,
}
`;

        // Main particle rendering shader
        this.particleRenderShader = `
${this.particleDescription}
${this.speciesDescription}

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

        // Compose shader for tone mapping and final output
        this.composeShader = `
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
    }
    
    /**
     * Initialize rendering resources and pipelines
     * @param {GPUBindGroupLayout} particleBufferBindGroupLayout - Particle buffer bind group layout
     */
    async initialize(particleBufferBindGroupLayout) {
        await this.createTextures();
        this.createBuffers();
        this.createBindGroupLayouts();
        this.createRenderPipelines(particleBufferBindGroupLayout);
        this.createBindGroups();
    }
    
    /**
     * Create HDR and blue noise textures
     */
    async createTextures() {
        // Create HDR render target
        this.hdrTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height, 1],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.hdrTextureView = this.hdrTexture.createView();
        
        // Load blue noise texture
        const blueNoiseImage = new Image();
        blueNoiseImage.src = 'blue-noise.png';
        await new Promise((resolve) => {
            blueNoiseImage.onload = resolve;
        });
        
        this.blueNoiseTexture = this.device.createTexture({
            size: [blueNoiseImage.width, blueNoiseImage.height, 1],
            format: 'rgba8unorm',
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
        });
        
        const canvas2d = document.createElement('canvas');
        canvas2d.width = blueNoiseImage.width;
        canvas2d.height = blueNoiseImage.height;
        const ctx = canvas2d.getContext('2d');
        ctx.drawImage(blueNoiseImage, 0, 0);
        const imageData = ctx.getImageData(0, 0, blueNoiseImage.width, blueNoiseImage.height);
        
        this.device.queue.writeTexture(
            { texture: this.blueNoiseTexture },
            imageData.data,
            { bytesPerRow: blueNoiseImage.width * 4 },
            { width: blueNoiseImage.width, height: blueNoiseImage.height }
        );
        
        this.blueNoiseTextureView = this.blueNoiseTexture.createView();
    }
    
    /**
     * Create rendering buffers
     */
    createBuffers() {
        // Camera uniform buffer
        // Note: Uniform buffers must be aligned to 16-byte boundaries
        // vec2f center (8 bytes) + vec2f extent (8 bytes) + f32 pixelsPerUnit (4 bytes) = 20 bytes
        // Padded to next 16-byte boundary = 32 bytes, but original used 24, so we'll match that
        this.cameraBuffer = this.device.createBuffer({
            size: 24, // Aligned for uniform buffer requirements
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM,
        });
    }
    
    /**
     * Create bind group layouts
     */
    createBindGroupLayouts() {
        this.cameraBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
                    buffer: { type: 'uniform' },
                },
            ],
        });
        
        this.composeBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
                {
                    binding: 0,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' },
                },
                {
                    binding: 1,
                    visibility: GPUShaderStage.FRAGMENT,
                    texture: { sampleType: 'float' },
                },
            ],
        });
    }
    
    /**
     * Create render pipelines
     * @param {GPUBindGroupLayout} particleBufferBindGroupLayout - Particle buffer bind group layout
     */
    createRenderPipelines(particleBufferBindGroupLayout) {
        const particleRenderShaderModule = this.device.createShaderModule({
            code: this.particleRenderShader,
        });
        
        const composeShaderModule = this.device.createShaderModule({
            code: this.composeShader,
        });
        
        // Particle glow render pipeline
        this.particleRenderGlowPipeline = this.device.createRenderPipeline({
            vertex: {
                module: particleRenderShaderModule,
                entryPoint: 'vertexGlow',
            },
            fragment: {
                module: particleRenderShaderModule,
                entryPoint: 'fragmentGlow',
                targets: [
                    {
                        format: 'rgba16float',
                        blend: {
                            color: { srcFactor: 'src-alpha', dstFactor: 'one' },
                            alpha: { srcFactor: 'one', dstFactor: 'one' },
                        },
                    },
                ],
            },
            primitive: { topology: 'triangle-list' },
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [particleBufferBindGroupLayout, this.cameraBindGroupLayout],
            }),
        });
        
        // Main particle render pipeline
        this.particleRenderPipeline = this.device.createRenderPipeline({
            vertex: {
                module: particleRenderShaderModule,
                entryPoint: 'vertexCircle',
            },
            fragment: {
                module: particleRenderShaderModule,
                entryPoint: 'fragmentCircle',
                targets: [
                    {
                        format: 'rgba16float',
                        blend: {
                            color: { srcFactor: 'src-alpha', dstFactor: 'one' },
                            alpha: { srcFactor: 'one', dstFactor: 'one' },
                        },
                    },
                ],
            },
            primitive: { topology: 'triangle-list' },
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [particleBufferBindGroupLayout, this.cameraBindGroupLayout],
            }),
        });
        
        // Point particle render pipeline (for far zoom)
        this.particleRenderPointPipeline = this.device.createRenderPipeline({
            vertex: {
                module: particleRenderShaderModule,
                entryPoint: 'vertexPoint',
            },
            fragment: {
                module: particleRenderShaderModule,
                entryPoint: 'fragmentPoint',
                targets: [
                    {
                        format: 'rgba16float',
                        blend: {
                            color: { srcFactor: 'src-alpha', dstFactor: 'one' },
                            alpha: { srcFactor: 'one', dstFactor: 'one' },
                        },
                    },
                ],
            },
            primitive: { topology: 'triangle-list' },
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [particleBufferBindGroupLayout, this.cameraBindGroupLayout],
            }),
        });
        
        // Compose pipeline for final output
        this.composePipeline = this.device.createRenderPipeline({
            vertex: {
                module: composeShaderModule,
                entryPoint: 'vertexMain',
            },
            fragment: {
                module: composeShaderModule,
                entryPoint: 'fragmentMain',
                targets: [{ format: navigator.gpu.getPreferredCanvasFormat() }],
            },
            primitive: { topology: 'triangle-list' },
            layout: this.device.createPipelineLayout({
                bindGroupLayouts: [this.composeBindGroupLayout],
            }),
        });
    }
    
    /**
     * Create bind groups
     */
    createBindGroups() {
        this.cameraBindGroup = this.device.createBindGroup({
            layout: this.cameraBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: { buffer: this.cameraBuffer },
                },
            ],
        });
        
        this.composeBindGroup = this.device.createBindGroup({
            layout: this.composeBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: this.hdrTextureView,
                },
                {
                    binding: 1,
                    resource: this.blueNoiseTextureView,
                },
            ],
        });
    }
    
    /**
     * Update camera parameters
     * @param {Array<number>} center - Camera center [x, y]
     * @param {number} extentX - Camera extent X
     * @param {number} extentY - Camera extent Y
     * @param {number} pixelsPerUnit - Pixels per unit
     */
    updateCamera(center, extentX, extentY, pixelsPerUnit) {
        this.cameraCenter = center;
        this.cameraExtentX = extentX;
        this.cameraExtentY = extentY;
        
        this.device.queue.writeBuffer(
            this.cameraBuffer,
            0,
            new Float32Array([center[0], center[1], extentX, extentY, pixelsPerUnit])
        );
    }
    
    /**
     * Set camera target extent for smooth interpolation
     * @param {number} targetExtentX - Target camera extent X
     */
    setCameraTarget(targetExtentX) {
        this.cameraExtentXTarget = targetExtentX;
    }
    
    /**
     * Update camera with smooth interpolation
     * @param {number} dt - Delta time
     * @param {Object} uiState - UI state with zoom anchor
     */
    updateCameraSmooth(dt, uiState) {
        const aspectRatio = this.canvas.width / this.canvas.height;
        const cameraExtentXDelta = (this.cameraExtentXTarget - this.cameraExtentX) * (-Math.expm1(-20 * dt));
        
        this.cameraExtentX += cameraExtentXDelta;
        this.cameraExtentY = this.cameraExtentX / aspectRatio;
        
        if (uiState.zoomAnchor) {
            this.cameraCenter[0] -= cameraExtentXDelta * uiState.zoomAnchor[0];
            this.cameraCenter[1] -= cameraExtentXDelta * uiState.zoomAnchor[1] / aspectRatio;
        }
        
        const pixelsPerUnit = this.canvas.width / (2.0 * this.cameraExtentX);
        this.updateCamera(this.cameraCenter, this.cameraExtentX, this.cameraExtentY, pixelsPerUnit);
        
        return pixelsPerUnit;
    }
    
    /**
     * Center the view on the simulation
     * @param {Array<Array<number>>} simulationBox - Simulation boundaries [[minX, maxX], [minY, maxY]]
     */
    centerView(simulationBox) {
        this.cameraCenter = [0.0, 0.0];
        
        const aspectRatio = this.canvas.width / this.canvas.height;
        
        if ((simulationBox[0][1] - simulationBox[0][0]) / (simulationBox[1][1] - simulationBox[1][0]) > aspectRatio) {
            this.cameraExtentXTarget = simulationBox[0][1];
        } else {
            this.cameraExtentXTarget = simulationBox[1][1] * aspectRatio;
        }
    }
    
    /**
     * Resize renderer resources when canvas size changes
     */
    resize() {
        // Recreate HDR texture with new size
        this.hdrTexture.destroy();
        this.hdrTexture = this.device.createTexture({
            size: [this.canvas.width, this.canvas.height, 1],
            format: 'rgba16float',
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
        this.hdrTextureView = this.hdrTexture.createView();
        
        // Update compose bind group with new texture
        this.composeBindGroup = this.device.createBindGroup({
            layout: this.composeBindGroupLayout,
            entries: [
                {
                    binding: 0,
                    resource: this.hdrTextureView,
                },
                {
                    binding: 1,
                    resource: this.blueNoiseTextureView,
                },
            ],
        });
    }
    
    /**
     * Render particles to the screen
     * @param {GPUCommandEncoder} encoder - Command encoder
     * @param {GPUBindGroup} particleBufferBindGroup - Particle buffer bind group
     * @param {number} particleCount - Number of particles to render
     * @param {number} pixelsPerUnit - Pixels per unit for LOD
     * @param {Object} timestampQuery - Timestamp query helper (optional)
     */
    render(encoder, particleBufferBindGroup, particleCount, pixelsPerUnit, timestampQuery = null) {
        // HDR render pass
        const hdrRenderPass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.hdrTextureView,
                    clearValue: [0.001, 0.001, 0.001, 0.0],
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            ...(timestampQuery && { timestampWrites: timestampQuery.next() }),
        });
        
        hdrRenderPass.setBindGroup(0, particleBufferBindGroup);
        hdrRenderPass.setBindGroup(1, this.cameraBindGroup);
        
        // Render glow
        hdrRenderPass.setPipeline(this.particleRenderGlowPipeline);
        hdrRenderPass.draw(particleCount * 6);
        
        // Render particles based on zoom level
        if (pixelsPerUnit < 1.0) {
            hdrRenderPass.setPipeline(this.particleRenderPointPipeline);
            hdrRenderPass.draw(particleCount * 6);
        } else {
            hdrRenderPass.setPipeline(this.particleRenderPipeline);
            hdrRenderPass.draw(particleCount * 6);
        }
        
        hdrRenderPass.end();
        
        // Compose render pass (tone mapping and final output)
        const composeRenderPass = encoder.beginRenderPass({
            colorAttachments: [
                {
                    view: this.context.getCurrentTexture().createView(),
                    clearValue: [0, 0, 0, 0],
                    loadOp: 'clear',
                    storeOp: 'store',
                },
            ],
            ...(timestampQuery && { timestampWrites: timestampQuery.next() }),
        });
        
        composeRenderPass.setBindGroup(0, this.composeBindGroup);
        composeRenderPass.setPipeline(this.composePipeline);
        composeRenderPass.draw(3);
        composeRenderPass.end();
    }
}
