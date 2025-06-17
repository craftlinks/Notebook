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
    
    // Initialize UI after app is ready
    if (typeof UI !== 'undefined') {
        UI.initializeUI();
    }
}

// Global functions for UI interaction (maintaining backward compatibility)
function loadSystem(systemDescription) {
    return app.loadSystem(systemDescription);
}

function reloadForces(systemDescription) {
    return app.reloadForces(systemDescription);
}

function generateSystem(systemDescription) {
    return app.systemManager.generateSystem(systemDescription);
}

function symmetrizeForces(systemDescription) {
    return app.systemManager.symmetrizeForces(systemDescription);
}

function initialSystem() {
    return app.systemManager.createInitialSystem();
}

// Global state accessors
function getCurrentSystemDescription() {
    return app.currentSystemDescription;
}

function isPaused() {
    return app.isPaused();
}

function togglePause() {
    app.togglePause();
}

function centerView() {
    app.centerView();
}

function randomizeSystem() {
    app.randomizeSystem();
}

function restartSystem() {
    app.restartSystem();
}

// Set up event handlers
window.onload = init; 