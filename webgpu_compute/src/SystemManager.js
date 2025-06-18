/**
 * @fileoverview System generation and management utilities
 */

import { splitmix32, randomSeed } from './Utils.js';
import { MAX_FORCE_RADIUS, MAX_FORCE_STRENGTH } from './Types.js';

/**
 * System manager for handling particle system generation and configuration
 */
export class SystemManager {
    constructor() {
        // Default system parameters
        this.defaultParams = {
            particleCount: 65536,
            speciesCount: 8,
            friction: 10.0,
            centralForce: 0.0,
            symmetricForces: false,
            loopingBorders: false
        };
    }

    /**
     * Generate a new system with random parameters
     * @param {SystemDescription} systemDescription - System description to populate
     * @returns {SystemDescription} Generated system description
     */
    generateSystem(systemDescription) {
        const speciesCount = systemDescription.species.length;
        systemDescription.species = [];

        const rng = splitmix32(systemDescription.seed);

        for (let i = 0; i < speciesCount; ++i) {
            const color = [
                Math.pow(0.25 + rng() * 0.75, 2.2),
                Math.pow(0.25 + rng() * 0.75, 2.2),
                Math.pow(0.25 + rng() * 0.75, 2.2),
                1.0,
            ];

            const forces = [];
            for (let j = 0; j < speciesCount; ++j) {
                const strength = MAX_FORCE_STRENGTH * (0.25 + 0.75 * rng()) * (rng() < 0.5 ? 1.0 : -1.0);
                const collisionStrength = (5.0 + 15.0 * rng()) * Math.abs(strength);
                const radius = 2.0 + rng() * (MAX_FORCE_RADIUS - 2.0);
                const collisionRadius = rng() * 0.5 * radius;
                forces.push({
                    strength: strength,
                    collisionStrength: collisionStrength,
                    radius: radius,
                    collisionRadius: collisionRadius,
                });
            }

            systemDescription.species.push({
                color: color,
                forces: forces,
                spawnWeight: rng(),
            });
        }

        if (systemDescription.symmetricForces) {
            this.symmetrizeForces(systemDescription);
        }

        return systemDescription;
    }

    /**
     * Make forces symmetric between species
     * @param {SystemDescription} systemDescription - System description to symmetrize
     */
    symmetrizeForces(systemDescription) {
        const speciesCount = systemDescription.species.length;

        for (let i = 0; i < speciesCount; ++i) {
            for (let j = i + 1; j < speciesCount; ++j) {
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

    /**
     * Create initial system based on URL parameters and defaults
     * @returns {SystemDescription} Initial system description
     */
    createInitialSystem() {
        let particleCount = this.defaultParams.particleCount;
        let speciesCount = this.defaultParams.speciesCount;
        let friction = this.defaultParams.friction;
        let centralForce = this.defaultParams.centralForce;
        let symmetricForces = this.defaultParams.symmetricForces;
        let loopingBorders = this.defaultParams.loopingBorders;
        let seed = randomSeed();

        const aspectRatio = window.screen.width / window.screen.height;
        let width = Math.round(12 * Math.sqrt(aspectRatio)) * 64;
        let height = Math.round(width / 64 / aspectRatio) * 64;

        const urlParams = new URLSearchParams(window.location.search);

        if (urlParams.has("particleCount"))
            particleCount = Number(urlParams.get("particleCount"));

        if (urlParams.has("speciesCount"))
            speciesCount = Number(urlParams.get("speciesCount"));

        if (urlParams.has("friction"))
            friction = Number(urlParams.get("friction"));

        if (urlParams.has("centralForce"))
            centralForce = Number(urlParams.get("centralForce"));

        if (urlParams.has("symmetricForces"))
            symmetricForces = urlParams.get("symmetricForces") == "true";

        if (urlParams.has("loopingBorders"))
            loopingBorders = urlParams.get("loopingBorders") == "true";

        if (urlParams.has("seed"))
            seed = Number(urlParams.get("seed")) >>> 0;

        if (urlParams.has("width"))
            width = Number(urlParams.get("width"));

        if (urlParams.has("height"))
            height = Number(urlParams.get("height"));

        const systemDescription = {
            particleCount: particleCount,
            species: new Array(speciesCount),
            simulationSize: [width, height],
            friction: friction,
            centralForce: centralForce,
            symmetricForces: symmetricForces,
            loopingBorders: loopingBorders,
            seed: seed,
        };
        
        return this.generateSystem(systemDescription);
    }

    /**
     * Validate and set default values for a system description
     * @param {SystemDescription} systemDescription - System description to validate
     */
    validateSystemDescription(systemDescription) {
        // Set default values if not provided
        if (systemDescription.friction === undefined)
            systemDescription.friction = this.defaultParams.friction;
        if (systemDescription.centralForce === undefined)
            systemDescription.centralForce = this.defaultParams.centralForce;
        if (systemDescription.symmetricForces === undefined)
            systemDescription.symmetricForces = this.defaultParams.symmetricForces;
        if (systemDescription.loopingBorders === undefined)
            systemDescription.loopingBorders = this.defaultParams.loopingBorders;
    }

    /**
     * Calculate simulation box from system size
     * @param {number[]} simulationSize - [width, height] of simulation
     * @returns {number[][]} Simulation box bounds [[left, right], [bottom, top]]
     */
    calculateSimulationBox(simulationSize) {
        const W = Math.round(simulationSize[0] / 64) * 32;
        const H = Math.round(simulationSize[1] / 64) * 32;
        return [[-W, W], [-H, H]];
    }
} 