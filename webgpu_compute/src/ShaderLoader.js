/**
 * Utility class for loading WGSL shader files
 * Provides async loading and caching of shader source code
 */
class ShaderLoader {
    constructor() {
        /** @type {Map<string, string>} */
        this.shaderCache = new Map();
    }

    /**
     * Load a shader file from a URL
     * @param {string} url - Path to the .wgsl file
     * @returns {Promise<string>} Shader source code
     */
    async loadShader(url) {
        // Check cache first
        if (this.shaderCache.has(url)) {
            return this.shaderCache.get(url);
        }

        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`Failed to load shader: ${url} (${response.status})`);
            }
            
            const shaderSource = await response.text();
            
            // Cache for future use
            this.shaderCache.set(url, shaderSource);
            
            return shaderSource;
        } catch (error) {
            console.error(`Error loading shader from ${url}:`, error);
            throw error;
        }
    }

    /**
     * Load multiple shaders in parallel
     * @param {string[]} urls - Array of shader file paths
     * @returns {Promise<string[]>} Array of shader source codes
     */
    async loadShaders(urls) {
        const promises = urls.map(url => this.loadShader(url));
        return Promise.all(promises);
    }

    /**
     * Load all compute shaders for the particle simulation
     * @returns {Promise<Object>} Object containing all shader sources
     */
    async loadParticleSimulationShaders() {
        const shaderFiles = {
            binning: 'src/shaders/binning.wgsl',
            prefixSum: 'src/shaders/prefix-sum.wgsl',
            particleSort: 'src/shaders/particle-sort.wgsl',
            computeForces: 'src/shaders/compute-forces.wgsl',
            particleAdvance: 'src/shaders/particle-advance.wgsl'
        };

        const results = {};
        
        // Load all shaders in parallel
        const promises = Object.entries(shaderFiles).map(async ([name, path]) => {
            const source = await this.loadShader(path);
            results[name] = source;
        });

        await Promise.all(promises);
        
        return results;
    }

    /**
     * Preload common shader includes
     * @returns {Promise<string>} Common shader code
     */
    async loadCommonShaders() {
        return this.loadShader('src/shaders/common.wgsl');
    }

    /**
     * Clear the shader cache
     */
    clearCache() {
        this.shaderCache.clear();
    }

    /**
     * Get cache statistics
     * @returns {Object} Cache information
     */
    getCacheInfo() {
        return {
            size: this.shaderCache.size,
            keys: Array.from(this.shaderCache.keys())
        };
    }
} 