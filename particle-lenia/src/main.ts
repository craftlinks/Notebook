import './style.css'

// Type definitions
interface Params {
  mu_k: number;
  sigma_k: number;
  w_k: number;
  mu_g: number;
  sigma_g: number;
  c_rep: number;
  dt: number;
}

interface Fields {
  R_val: Float32Array;
  U_val: Float32Array;
  R_grad: Float32Array;
  U_grad: Float32Array;
}

// Constants and global variables
const POINT_N = 200;
const WORLD_WIDTH = 25.0;
const STEPS_PER_FRAME = 1;

const params: Params = {
  mu_k: 4.0,
  sigma_k: 1.0,
  w_k: 0.022,
  mu_g: 0.6,
  sigma_g: 0.15,
  c_rep: 1.0,
  dt: 0.1
};

let points: Float32Array;
let fields: Fields;
let animationId: number;
let frameCount = 0;

// Initialize points with random positions
function init(points: Float32Array): Float32Array {
  for (let i = 0; i < POINT_N; ++i) {
    points[i * 2] = (Math.random() - 0.5) * 12;
    points[i * 2 + 1] = (Math.random() - 0.5) * 12;
  }
  return points;
}

// Add scaled vector to array
function add_xy(a: Float32Array, i: number, x: number, y: number, c: number): void {
  a[i * 2] += x * c;
  a[i * 2 + 1] += y * c;
}

// Fast approximation of exp(-x*x)
function fast_exp(x: number): number {
  let t = 1.0 + x / 32.0;
  t *= t; t *= t; t *= t; t *= t; t *= t; // t **= 32
  return t;
}

// Repulsion function and its derivative
function repulsion_f(x: number, c_rep: number): [number, number] {
  const t = Math.max(1.0 - x, 0.0);
  return [0.5 * c_rep * t * t, -c_rep * t];
}

// Peak function (Gaussian-like) and its derivative
function peak_f(x: number, mu: number, sigma: number, w: number = 1.0): [number, number] {
  const t = (x - mu) / sigma;
  const y = w / fast_exp(t * t);
  return [y, -2.0 * t * y / sigma];
}

// Compute all fields (R, U and their gradients)
function compute_fields(): void {
  const { R_val, U_val, R_grad, U_grad } = fields;
  const { c_rep, mu_k, sigma_k, w_k } = params;

  // Account for the own field of each particle
  R_val.fill(repulsion_f(0.0, c_rep)[0]);
  U_val.fill(peak_f(0.0, mu_k, sigma_k, w_k)[0]);
  R_grad.fill(0);
  U_grad.fill(0);

  for (let i = 0; i < POINT_N - 1; ++i) {
    for (let j = i + 1; j < POINT_N; ++j) {
      let rx = points[i * 2] - points[j * 2];
      let ry = points[i * 2 + 1] - points[j * 2 + 1];
      const r = Math.sqrt(rx * rx + ry * ry) + 1e-20;
      rx /= r; ry /= r; // ∇r = [rx, ry]

      if (r < 1.0) {
        // ∇R = R'(r) ∇r
        const [R, dR] = repulsion_f(r, c_rep);
        add_xy(R_grad, i, rx, ry, dR);
        add_xy(R_grad, j, rx, ry, -dR);
        R_val[i] += R; R_val[j] += R;
      }

      // ∇K = K'(r) ∇r
      const [K, dK] = peak_f(r, mu_k, sigma_k, w_k);
      add_xy(U_grad, i, rx, ry, dK);
      add_xy(U_grad, j, rx, ry, -dK);
      U_val[i] += K; U_val[j] += K;
    }
  }
}

// Simulation step
function step(): number {
  const { R_val, U_val, R_grad, U_grad } = fields;
  const { mu_g, sigma_g, dt } = params;

  compute_fields();

  let total_E = 0.0;
  for (let i = 0; i < POINT_N; ++i) {
    const [G, dG] = peak_f(U_val[i], mu_g, sigma_g);
    // [vx, vy] = -∇E = G'(U)∇U - ∇R
    const vx = dG * U_grad[i * 2] - R_grad[i * 2];
    const vy = dG * U_grad[i * 2 + 1] - R_grad[i * 2 + 1];
    add_xy(points, i, vx, vy, dt);
    total_E += R_val[i] - G;
  }
  return total_E / POINT_N;
}

// Animation and rendering
function animate(ctx: CanvasRenderingContext2D): void {
  for (let i = 0; i < STEPS_PER_FRAME; ++i) {
    step();
  }

  const { width, height } = ctx.canvas;
  ctx.resetTransform();
  ctx.clearRect(0, 0, width, height);
  ctx.translate(width / 2, height / 2);

  const s = width / WORLD_WIDTH;
  ctx.scale(s, s);
  ctx.lineWidth = 0.1;
  ctx.strokeStyle = '#00ff88';

  for (let i = 0; i < POINT_N; ++i) {
    ctx.beginPath();
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    const r = params.c_rep / (fields.R_val[i] * 5.0);
    ctx.arc(x, y, r, 0.0, Math.PI * 2);
    ctx.stroke();
  }

  frameCount++;
  if (frameCount % 60 === 0) {
    const info = document.querySelector<HTMLDivElement>('#info');
    if (info) {
      info.textContent = `Frame: ${frameCount}, Particles: ${POINT_N}`;
    }
  }
}

// Animation loop
function animationLoop(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  animate(ctx);
  animationId = requestAnimationFrame(animationLoop);
}

// Reset simulation
function reset(): void {
  points = init(new Float32Array(POINT_N * 2));
  frameCount = 0;
  const info = document.querySelector<HTMLDivElement>('#info');
  if (info) {
    info.textContent = `Frame: 0, Particles: ${POINT_N}`;
  }
}

// Initialize everything
function initialize(): void {
  // Initialize data structures
  points = init(new Float32Array(POINT_N * 2));
  fields = {
    R_val: new Float32Array(POINT_N),
    U_val: new Float32Array(POINT_N),
    R_grad: new Float32Array(POINT_N * 2),
    U_grad: new Float32Array(POINT_N * 2),
  };

  // Set up event listeners
  const resetButton = document.querySelector<HTMLButtonElement>('#reset');
  if (resetButton) {
    resetButton.addEventListener('click', reset);
  }

  // Start animation
  animationLoop();

  // Initial info display
  const info = document.querySelector<HTMLDivElement>('#info');
  if (info) {
    info.textContent = `Frame: 0, Particles: ${POINT_N}`;
  }
}

// Start when DOM is loaded
document.addEventListener('DOMContentLoaded', initialize);
