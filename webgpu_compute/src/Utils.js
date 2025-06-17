/**
 * @fileoverview Utility functions for the particle simulation
 */

/**
 * From https://stackoverflow.com/a/47593316/2315602
 * @param {number} a - Seed value
 * @returns {function(): number} Random number generator function
 */
function splitmix32(a) {
    return function() {
        a |= 0;
        a = a + 0x9e3779b9 | 0;
        let t = a ^ a >>> 16;
        t = Math.imul(t, 0x21f0aaad);
        t = t ^ t >>> 15;
        t = Math.imul(t, 0x735a2d97);
        return ((t = t ^ t >>> 15) >>> 0) / 4294967296;
    }
}

/**
 * Generate a random seed value
 * @returns {number} Random seed
 */
function randomSeed() {
    return (Math.random() * (2 ** 32)) >>> 0;
}

/**
 * Format execution time in milliseconds
 * @param {bigint} x - Execution time in nanoseconds
 * @returns {string} Formatted execution time
 */
function formatExecutionTime(x) {
    var result = (Number(x) / 1000000).toFixed(2);
    while (result.length < 5) {
        result = " " + result;
    }
    return result + " ms";
}

/**
 * Load an image from URL
 * @param {string} url - URL of the image to load
 * @returns {Promise<ImageBitmap>} Loaded image bitmap
 */
async function loadImage(url) {
    const res = await fetch(url);
    const blob = await res.blob();
    return await createImageBitmap(blob, { colorSpaceConversion: 'none' });
} 