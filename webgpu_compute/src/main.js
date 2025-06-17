/**
 * @fileoverview Main entry point for the particle simulation application
 */

// Global application instance
/** @type {Application} */
let app;

/**
 * Initialize the application when the page loads
 */
async function init() {
    app = new Application();
    await app.initialize();

}

// Set up event handlers
window.onload = init; 