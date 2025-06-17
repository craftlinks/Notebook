/**
 * @fileoverview User Interface management for the particle simulation
 */

// UI State Variables
var actionPoint = null;
var actionDrag = null;
var mouseDrag = null;
var zoomAnchor = null;

var activeTouches = new Map();
var lastTouchTime = 0.0;
var isDoubleTap = false;

var toolsPanelShown = true;
var lastMenuToggleTime = 0.0;
var lastPinchDistance = null;

// UI Control Functions
function pauseClicked() {
    togglePause();
    document.getElementById("pauseButton").innerText = isPaused() ? "Continue" : "Pause";
}

function updateParticleCount() {
    const newParticleCount = Math.round(Math.pow(2, document.getElementById("particleCountSlider").value));

    const systemDescription = getCurrentSystemDescription();
    systemDescription.particleCount = newParticleCount;
    loadSystem(systemDescription);
}

function updateSpeciesCount() {
    const newSpeciesCount = Math.round(document.getElementById("speciesCountSlider").value);

    const systemDescription = getCurrentSystemDescription();
    systemDescription.species = new Array(newSpeciesCount);
    systemDescription.seed = randomSeed();
    loadSystem(generateSystem(systemDescription));
}

function updateSimulationSize() {
    const newWidth = document.getElementById("simulationWidthSlider").value * 64;
    const newHeight = document.getElementById("simulationHeightSlider").value * 64;

    const systemDescription = getCurrentSystemDescription();
    systemDescription.simulationSize = [newWidth, newHeight];
    loadSystem(systemDescription);
}

function updateFriction() {
    const newFriction = document.getElementById("frictionSlider").value;

    const systemDescription = getCurrentSystemDescription();
    systemDescription.friction = newFriction;

    document.getElementById("frictionText").innerText = `Friction: ${newFriction}`;
}

function updateCentralForce() {
    const newCentralForce = document.getElementById("centralForceSlider").value / 10.0;

    const systemDescription = getCurrentSystemDescription();
    systemDescription.centralForce = newCentralForce;

    document.getElementById("centralForceText").innerText = `Central force: ${newCentralForce}`;
}

function updateSymmetricForces() {
    const newSymmetricForces = document.getElementById("symmetricForces").checked;

    const systemDescription = getCurrentSystemDescription();
    systemDescription.symmetricForces = newSymmetricForces;

    if (newSymmetricForces) {
        symmetrizeForces(systemDescription);
        reloadForces(systemDescription);
    }
}

function updateLoopingBorders() {
    const newLoopingBorders = document.getElementById("loopingBorders").checked;

    const systemDescription = getCurrentSystemDescription();
    systemDescription.loopingBorders = newLoopingBorders;
}

async function saveSettings() {
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
    await writable.write(JSON.stringify(getCurrentSystemDescription(), null, 2));
    await writable.close();
}

async function loadSettings() {
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
    // Note: customRules is now managed by Application class
}

async function copyUrl() {
    const systemDescription = getCurrentSystemDescription();
    
    const location = window.location;
    var url = location.protocol + "//" + location.host + location.pathname + 
              `?particleCount=${systemDescription.particleCount}&speciesCount=${systemDescription.species.length}&friction=${systemDescription.friction}&centralForce=${systemDescription.centralForce}&symmetricForces=${systemDescription.symmetricForces}&loopingBorders=${systemDescription.loopingBorders}&seed=${systemDescription.seed}`;

    await navigator.clipboard.writeText(url);
}

async function fullscreen() {
    if (document.fullscreen) {
        await document.exitFullscreen();
        document.getElementById("fullscreenButton").innerText = "Fullscreen";
    } else {
        await document.body.requestFullscreen();
        document.getElementById("fullscreenButton").innerText = "Exit fullscreen";
    }
}

// UI Event Handlers Setup
function setupCanvasEventListeners() {
    const canvas = document.getElementById("mainCanvas");
    
    canvas.addEventListener('wheel', function(event) {
        if (app && app.renderer) {
            const factor = Math.pow(1.25, event.deltaY / 120);
            app.renderer.setCameraTarget(app.renderer.cameraExtentXTarget * factor);

            zoomAnchor = [
                2.0 * event.x / canvas.width - 1.0,
                1.0 - 2.0 * event.y / canvas.height,
            ];
        }

        event.preventDefault();
    }, false);

    canvas.addEventListener('mousedown', function(event) {
        if (event.button == 0) {
            actionPoint = [event.clientX, event.clientY];
            actionDrag = [0.0, 0.0];
        }
        if (event.button == 2) {
            mouseDrag = [event.clientX, event.clientY];
        }
        event.preventDefault();
    }, false);

    canvas.addEventListener('mouseup', function(event) {
        if (event.button == 0) {
            actionPoint = null;
            actionDrag = null;
        }
        if (event.button == 2) {
            mouseDrag = null;
        }
        event.preventDefault();
    }, false);

    canvas.addEventListener('contextmenu', function(event) {
        event.preventDefault();
    }, false);

    canvas.addEventListener('mousemove', function(event) {
        if (actionPoint) {
            actionDrag = [event.clientX - actionPoint[0], event.clientY - actionPoint[1]];
            actionPoint = [event.clientX, event.clientY];
        }

        if (mouseDrag && app && app.renderer) {
            const delta = [event.clientX - mouseDrag[0], event.clientY - mouseDrag[1]];

            app.renderer.cameraCenter[0] -= delta[0] / canvas.width * app.renderer.cameraExtentX * 2.0;
            app.renderer.cameraCenter[1] += delta[1] / canvas.height * app.renderer.cameraExtentY * 2.0;

            mouseDrag = [event.clientX, event.clientY];
        }

        event.preventDefault();
    }, false);

    // Touch event handlers
    canvas.addEventListener("touchstart", function(event) {
        for (const touch of event.changedTouches) {
            activeTouches.set(touch.identifier, [touch.pageX, touch.pageY]);
        }

        if (activeTouches.size == 3) {
            toolsPanelShown = !toolsPanelShown;
        }

        const now = window.performance.now() / 1000.0;

        if (activeTouches.size == 1 && (now - lastTouchTime) < 0.5) {
            isDoubleTap = true;
        } else {
            isDoubleTap = false;
        }

        lastTouchTime = now;
        event.preventDefault();
    }, false);

    canvas.addEventListener("touchend", function(event) {
        for (const touch of event.changedTouches) {
            activeTouches.delete(touch.identifier);
        }

        if (activeTouches.size == 0) {
            if (isDoubleTap) {
                actionPoint = [touch.pageX, touch.pageY]
                actionDrag = [0.0, 0.0];
            } else {
                actionPoint = null;
                actionDrag = null;
            }
            mouseDrag = null;
        }

        event.preventDefault();
    }, false);

    canvas.addEventListener("touchmove", function(event) {
        if (activeTouches.size == 1) {
            const touch = event.changedTouches[0];

            if (isDoubleTap) {
                actionDrag = [touch.pageX - actionPoint[0], touch.pageY - actionPoint[1]];
                actionPoint = [touch.pageX, touch.pageY];
            } else {
                if (!mouseDrag) {
                    mouseDrag = activeTouches.get(touch.identifier);
                }

                if (app && app.renderer) {
                    const delta = [touch.pageX - mouseDrag[0], touch.pageY - mouseDrag[1]];

                    app.renderer.cameraCenter[0] -= delta[0] / canvas.width * app.renderer.cameraExtentX * 2.0;
                    app.renderer.cameraCenter[1] += delta[1] / canvas.height * app.renderer.cameraExtentY * 2.0;
                }

                mouseDrag = [touch.pageX, touch.pageY];
            }
        }

        if (activeTouches.size == 2) {
            const touches = [...event.changedTouches];
            const touch1 = touches[0];
            const touch2 = touches[1];

            const currentDistance = Math.sqrt(
                (touch1.pageX - touch2.pageX) ** 2 + (touch1.pageY - touch2.pageY) ** 2
            );

            if (!lastPinchDistance) {
                lastPinchDistance = currentDistance;
            } else {
                const factor = lastPinchDistance / currentDistance;
                
                if (app && app.renderer) {
                    app.renderer.setCameraTarget(app.renderer.cameraExtentXTarget * factor);

                    zoomAnchor = [
                        2.0 * (touch1.pageX + touch2.pageX) / 2 / canvas.width - 1.0,
                        1.0 - 2.0 * (touch1.pageY + touch2.pageY) / 2 / canvas.height,
                    ];
                }

                lastPinchDistance = currentDistance;
            }
        }

        event.preventDefault();
    }, false);
}

function setupKeyboardEventListeners() {
    document.addEventListener('keydown', function(event) {
        if (event.key == 's' || event.key == 'S') {
            const now = window.performance.now() / 1000.0;

            if ((now - lastMenuToggleTime) > 0.5) {
                toolsPanelShown = !toolsPanelShown;
                lastMenuToggleTime = now;
            }

            event.preventDefault();
        }
    }, false);
}

function setupSliderEventListeners() {
    const sliders = document.querySelectorAll('input[type="range"]');
    sliders.forEach(slider => {
        slider.addEventListener('input', function() {
            updateSliderText(this);
        });
    });
}

function updateSliderText(slider) {
    // Update text display for sliders
    switch(slider.id) {
        case 'particleCountSlider':
            const particleCount = Math.round(Math.pow(2, slider.value));
            document.getElementById("particleCountText").innerText = particleCount.toLocaleString() + " particles";
            break;
        case 'speciesCountSlider':
            document.getElementById("speciesCountText").innerText = slider.value + " particle types";
            break;
        case 'simulationWidthSlider':
            document.getElementById("simulationWidthText").innerText = "Width: " + (slider.value * 64);
            break;
        case 'simulationHeightSlider':
            document.getElementById("simulationHeightText").innerText = "Height: " + (slider.value * 64);
            break;
        case 'frictionSlider':
            document.getElementById("frictionText").innerText = "Friction: " + slider.value;
            break;
        case 'centralForceSlider':
            document.getElementById("centralForceText").innerText = "Central force: " + (slider.value / 10.0);
            break;
    }
}

function updateUIElements() {
    const systemDescription = getCurrentSystemDescription();
    
    document.getElementById("particleCountSlider").value = Math.log2(systemDescription.particleCount);
    document.getElementById("particleCountText").innerText = systemDescription.particleCount.toLocaleString() + " particles";

    document.getElementById("speciesCountSlider").value = systemDescription.species.length;
    document.getElementById("speciesCountText").innerText = systemDescription.species.length + " particle types";

    document.getElementById("simulationWidthSlider").value = Math.round(systemDescription.simulationSize[0] / 64);
    document.getElementById("simulationWidthText").innerText = "Width: " + systemDescription.simulationSize[0];
    document.getElementById("simulationHeightSlider").value = Math.round(systemDescription.simulationSize[1] / 64);
    document.getElementById("simulationHeightText").innerText = "Height: " + systemDescription.simulationSize[1];

    document.getElementById("frictionSlider").value = systemDescription.friction;
    document.getElementById("frictionText").innerText = "Friction: " + systemDescription.friction;

    document.getElementById("centralForceSlider").value = systemDescription.centralForce * 10;
    document.getElementById("centralForceText").innerText = "Central force: " + systemDescription.centralForce;

    document.getElementById("symmetricForces").checked = systemDescription.symmetricForces;
    document.getElementById("loopingBorders").checked = systemDescription.loopingBorders;
}

function updatePanelVisibility(dt) {
    const toolsPanel = document.getElementById("toolsPanel");
    const debugPanel = document.getElementById("debugPanel");

    if (toolsPanelShown) {
        toolsPanel.style.display = "block";
        debugPanel.style.display = "block";
    } else {
        toolsPanel.style.display = "none";
        debugPanel.style.display = "none";
    }
}

function getActionState() {
    return {
        actionPoint: actionPoint,
        actionDrag: actionDrag,
        zoomAnchor: zoomAnchor
    };
}

function clearActionDrag() {
    actionDrag = null;
}

function initializeUI() {
    setupCanvasEventListeners();
    setupKeyboardEventListeners();
    setupSliderEventListeners();
}

// centerView function - calls the application's centerView method
function centerView() {
    if (window.app && window.app.renderer) {
        window.app.centerView();
    }
}

// Export UI object for global access
window.UI = {
    initializeUI,
    updateUIElements,
    updatePanelVisibility,
    getActionState,
    clearActionDrag,
    updateParticleCount,
    updateSpeciesCount,
    updateSimulationSize,
    updateFriction,
    updateCentralForce,
    updateSymmetricForces,
    updateLoopingBorders,
    pauseClicked,
    saveSettings,
    loadSettings,
    copyUrl,
    fullscreen,
    centerView
}; 