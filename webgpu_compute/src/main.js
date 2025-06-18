/**
 * @fileoverview Main entry point for the particle simulation application
 */

import { Application } from './Application.js';
import { UI } from './UI.js';

// Global application instance
/** @type {Application} */
let app;

/**
 * Initialize the application when the page loads
 */
async function init() {
    app = new Application();
    
    // Set up UI reference to the application
    UI.setApp(app);
    
    await app.initialize();
}

// Set up event handlers
window.onload = init; 