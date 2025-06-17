// UI.js - User Interface handling for Particle Life 2D
// Contains all UI-related functionality including event handlers, panels, and controls

// UI State Variables
let toolsPanelShown = true;
let debugPanelShown = false;
let mouseDrag = null;
let actionPoint = null;
let actionDrag = null;
const activeTouches = new Map();
let lastTouchTime = null;
let isDoubleTap = false;
let zoomAnchor = null;

// UI Control Functions
function pauseClicked() {
    paused = !paused;
    document.getElementById("pauseButton").innerText = paused ? "Continue" : "Pause";
}

function updateParticleCount() {
    const newParticleCount = Math.round(Math.pow(2, document.getElementById("particleCountSlider").value));

    const systemDescription = currentSystemDescription;
    systemDescription.particleCount = newParticleCount;
    loadSystem(systemDescription);
}

function updateSpeciesCount() {
    const newSpeciesCount = Math.round(document.getElementById("speciesCountSlider").value);

    const systemDescription = currentSystemDescription;
    systemDescription.species = new Array(newSpeciesCount);
    systemDescription.seed = randomSeed();
    loadSystem(generateSystem(systemDescription));
}

function updateSimulationSize() {
    const newWidth = document.getElementById("simulationWidthSlider").value * 64;
    const newHeight = document.getElementById("simulationHeightSlider").value * 64;

    const systemDescription = currentSystemDescription;
    systemDescription.simulationSize = [newWidth, newHeight];
    loadSystem(systemDescription);
}

function updateFriction() {
    const newFriction = document.getElementById("frictionSlider").value;

    currentSystemDescription.friction = newFriction;
    friction = newFriction;

    document.getElementById("frictionText").innerText = `Friction: ${newFriction}`;
}

function updateCentralForce() {
    const newCentralForce = document.getElementById("centralForceSlider").value / 10.0;

    currentSystemDescription.centralForce = newCentralForce;
    centralForce = newCentralForce;

    document.getElementById("centralForceText").innerText = `Central force: ${newCentralForce}`;
}

function updateSymmetricForces() {
    const newSymmetricForces = document.getElementById("symmetricForces").checked;

    currentSystemDescription.symmetricForces = newSymmetricForces;
    symmetricForces = newSymmetricForces;

    if (newSymmetricForces) {
        symmetrizeForces(currentSystemDescription);
        reloadForces(currentSystemDescription);
    }
}

function updateLoopingBorders() {
    const newLoopingBorders = document.getElementById("loopingBorders").checked;

    currentSystemDescription.loopingBorders = newLoopingBorders;
    loopingBorders = newLoopingBorders;
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
    await writable.write(JSON.stringify(currentSystemDescription, null, 2));
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
    customRules = true;
}

async function copyUrl() {
    if (customRules) {
        alert("Copying URL might not work correctly with custom rules");
    }

    const location = window.location;
    var url = location.protocol + "//" + location.host + location.pathname + `?particleCount=${particleCount}&speciesCount=${speciesCount}&friction=${friction}&centralForce=${centralForce}&symmetricForces=${symmetricForces}&loopingBorders=${loopingBorders}&seed=${currentSystemDescription.seed}`;

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

function centerView() {
    if (typeof renderer !== 'undefined' && renderer) {
        renderer.centerView(simulationBox);
    }
    zoomAnchor = null;
}

// UI Event Handlers Setup
function setupCanvasEventListeners() {
    canvas.addEventListener('wheel', function(event) {
        if (typeof renderer !== 'undefined' && renderer) {
            const factor = Math.pow(1.25, event.deltaY / 120);
            renderer.setCameraTarget(renderer.cameraExtentXTarget * factor);

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

        if (mouseDrag && typeof renderer !== 'undefined' && renderer) {
            const delta = [event.clientX - mouseDrag[0], event.clientY - mouseDrag[1]];

            renderer.cameraCenter[0] -= delta[0] / canvas.width * renderer.cameraExtentX * 2.0;
            renderer.cameraCenter[1] += delta[1] / canvas.height * renderer.cameraExtentY * 2.0;

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

        const now = window.performance.now() / 1000.0;;

        if (activeTouches.size == 1 && (now - lastTouchTime) < 0.5) {
            isDoubleTap = true;
        } else {
            isDoubleTap = false;
        }

        lastTouchTime = now;

        event.preventDefault();
    });

    canvas.addEventListener("touchmove", function(event) {
        const oldTouches = new Map(activeTouches);

        for (const touch of event.changedTouches) {
            activeTouches.set(touch.identifier, [touch.pageX, touch.pageY]);
        }

        if (oldTouches.size == 1 && activeTouches.size == 1) {
            const oldPosition = oldTouches.entries().next().value[1];
            const newPosition = activeTouches.entries().next().value[1];
            const delta = [newPosition[0] - oldPosition[0], newPosition[1] - oldPosition[1]];

            if (isDoubleTap) {
                actionPoint = newPosition;
                actionDrag = delta;
            } else if (typeof renderer !== 'undefined' && renderer) {
                renderer.cameraCenter[0] -= delta[0] / canvas.width * renderer.cameraExtentX * 2.0;
                renderer.cameraCenter[1] += delta[1] / canvas.height * renderer.cameraExtentY * 2.0;
            }
        }

        if (oldTouches.size == 2 && activeTouches.size == 2) {
            const oldIterator = oldTouches.entries();
            const newIterator = activeTouches.entries();

            const oldPosition1 = oldIterator.next().value[1];
            const oldPosition2 = oldIterator.next().value[1];

            const newPosition1 = newIterator.next().value[1];
            const newPosition2 = newIterator.next().value[1];

            const oldCenter = [(oldPosition2[0] + oldPosition1[0]) / 2, (oldPosition2[1] + oldPosition1[1]) / 2];
            const newCenter = [(newPosition2[0] + newPosition1[0]) / 2, (newPosition2[1] + newPosition1[1]) / 2];

            zoomAnchor = [
                2.0 * newCenter[0] / canvas.width - 1.0,
                1.0 - 2.0 * newCenter[1] / canvas.height,
            ];

            const delta = [newCenter[0] - oldCenter[0], newCenter[1] - oldCenter[1]];

            const oldDelta = [oldPosition2[0] - oldPosition1[0], oldPosition2[1] - oldPosition1[1]];
            const newDelta = [newPosition2[0] - newPosition1[0], newPosition2[1] - newPosition1[1]];

            const oldDistance = Math.sqrt(oldDelta[0] * oldDelta[0] + oldDelta[1] * oldDelta[1]);
            const newDistance = Math.sqrt(newDelta[0] * newDelta[0] + newDelta[1] * newDelta[1]);

            if (typeof renderer !== 'undefined' && renderer) {
                renderer.cameraCenter[0] -= delta[0] / canvas.width * renderer.cameraExtentX * 2.0;
                renderer.cameraCenter[1] += delta[1] / canvas.height * renderer.cameraExtentY * 2.0;
                renderer.setCameraTarget(renderer.cameraExtentXTarget * oldDistance / newDistance);
            }
        }

        event.preventDefault();
    });

    canvas.addEventListener("touchend", function(event) {
        for (const touch of event.changedTouches) {
            activeTouches.delete(touch.identifier);
        }
        isDoubleTap = false;
        actionPoint = null;
        actionDrag = null;
        event.preventDefault();
    });

    canvas.addEventListener("touchcancel", function(event) {
        for (const touch of event.changedTouches) {
            activeTouches.delete(touch.identifier);
        }
        isDoubleTap = false;
        actionPoint = null;
        actionDrag = null;
    });
}

function setupKeyboardEventListeners() {
    window.addEventListener('keydown', function(event) {
        if (event.key == ' ') {
            pauseClicked();
            event.preventDefault();
        }

        if (event.key == 'c') {
            centerView();
            event.preventDefault();
        }

        if (event.key == 's') {
            toolsPanelShown = !toolsPanelShown;
            event.preventDefault();
        }

        if (event.key == 'd') {
            debugPanelShown = !debugPanelShown;
            event.preventDefault();
        }
    }, false);
}

function setupSliderEventListeners() {
    for (var element of document.getElementsByClassName('slider')) {
        const self = element;
        self.addEventListener('wheel', function(event) {
            self.value = Number(self.value) - event.deltaY / 120;
            self.dispatchEvent(new Event('input'));
        });
    }
}

// UI Update Functions
function updateUIElements() {
    document.getElementById("particleCountSlider").value = Math.round(Math.log2(particleCount));
    document.getElementById("particleCountText").innerText = `${particleCount} particles`;
    document.getElementById("speciesCountSlider").value = speciesCount;
    document.getElementById("speciesCountText").innerText = `${speciesCount} particle types`;
    document.getElementById("simulationWidthSlider").value = Math.round(currentSystemDescription.simulationSize[0] / 64);
    document.getElementById("simulationWidthText").innerText = `Width: ${simulationBox[0][1] - simulationBox[0][0]}`;
    document.getElementById("simulationHeightSlider").value = Math.round(currentSystemDescription.simulationSize[1] / 64);
    document.getElementById("simulationHeightText").innerText = `Height: ${simulationBox[1][1] - simulationBox[1][0]}`;
    document.getElementById("frictionSlider").value = Math.round(friction);
    document.getElementById("frictionText").innerText = `Friction: ${friction}`;
    document.getElementById("loopingBorders").checked = loopingBorders;
}

function updatePanelVisibility(dt) {
    const toolsPanel = document.getElementById("toolsPanel");
    var toolsPanelAlpha = Number(toolsPanel.style.opacity);
    toolsPanelAlpha += ((toolsPanelShown ? 1.0 : 0.0) - toolsPanelAlpha) * (- Math.expm1(- 20 * dt));
    toolsPanel.style.opacity = toolsPanelAlpha;
    toolsPanel.style.visibility = (toolsPanelAlpha < 0.01) ? "hidden" : "visible";

    const debugPanel = document.getElementById("debugPanel");
    var debugPanelAlpha = Number(debugPanel.style.opacity);
    debugPanelAlpha += ((debugPanelShown ? 1.0 : 0.0) - debugPanelAlpha) * (- Math.expm1(- 20 * dt));
    debugPanel.style.opacity = debugPanelAlpha;
    debugPanel.style.visibility = (debugPanelAlpha < 0.01) ? "hidden" : "visible";
}

function getActionState() {
    return {
        actionPoint: actionPoint,
        actionDrag: actionDrag,
        zoomAnchor: zoomAnchor
    };
}

function clearActionDrag() {
    actionDrag = [0.0, 0.0];
}

// UI Initialization
function initializeUI() {
    const buttonsTable = document.getElementById("buttonsTable");
    const toolsPanelStyle = window.getComputedStyle(document.getElementById("toolsPanel"), null);
    buttonsTable.style.width = buttonsTable.parentElement.clientWidth - parseFloat(toolsPanelStyle.getPropertyValue('padding-left')) - parseFloat(toolsPanelStyle.getPropertyValue('padding-right'));

    setupSliderEventListeners();
    setupCanvasEventListeners();
    setupKeyboardEventListeners();

    if (!document.body.requestFullscreen) {
        document.getElementById("fullscreenButton").style.display = 'none';
    }
}

// Export UI state getters for main application
window.UI = {
    initializeUI,
    updateUIElements,
    updatePanelVisibility,
    getActionState,
    clearActionDrag,
    centerView,
    pauseClicked,
    updateParticleCount,
    updateSpeciesCount,
    updateSimulationSize,
    updateFriction,
    updateCentralForce,
    updateSymmetricForces,
    updateLoopingBorders,
    saveSettings,
    loadSettings,
    copyUrl,
    fullscreen
};
