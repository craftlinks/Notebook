/**
 * @fileoverview Type definitions and constants for the particle simulation
 */

/**
 * @typedef {Object} SystemDescription
 * @property {number} particleCount
 * @property {Array} species
 * @property {number[]} simulationSize
 * @property {number} friction
 * @property {number} centralForce
 * @property {boolean} symmetricForces
 * @property {boolean} loopingBorders
 * @property {number} seed
 */

/**
 * @typedef {Object} Species
 * @property {number[]} color
 * @property {Force[]} forces
 * @property {number} spawnWeight
 */

/**
 * @typedef {Object} Force
 * @property {number} strength
 * @property {number} radius
 * @property {number} collisionStrength
 * @property {number} collisionRadius
 */

// Constants
export const HDR_FORMAT = 'rgba16float';
export const MAX_FORCE_RADIUS = 32.0;
export const MAX_FORCE_STRENGTH = 100.0;
export const INITIAL_VELOCITY = 10.0; 