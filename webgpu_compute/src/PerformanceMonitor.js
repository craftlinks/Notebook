/**
 * @fileoverview Performance monitoring utilities for WebGPU timestamp queries
 */

/**
 * @constructor
 * @description Helper class for timestamp queries
 * @param {GPUDevice} device - WebGPU device
 */
function QueryHelper(device) {
    /** @type {GPUQuerySet} */
    this.querySet = device.createQuerySet({
        count: 16,
        type: 'timestamp',
    });

    /** @type {GPUBuffer} */
    this.resolveBuffer = device.createBuffer({
        size: 8 * 16,
        usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.QUERY_RESOLVE,
    });

    /** @type {GPUBuffer} */
    this.readBuffer = device.createBuffer({
        size: 8 * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    /** @type {number} */
    this.currentIndex = 0;
    
    /** @type {() => void} */
    this.start = () => this.currentIndex = 0;
    
    /** @type {() => {querySet: GPUQuerySet, beginningOfPassWriteIndex: number, endOfPassWriteIndex: number}} */
    this.next = () => {
        const result = {
            querySet: this.querySet,
            beginningOfPassWriteIndex: this.currentIndex,
            endOfPassWriteIndex: this.currentIndex + 1,
        };
        this.currentIndex += 2;
        return result;
    };
}

/**
 * Performance monitor for managing query helpers and debug display
 */
class PerformanceMonitor {
    constructor() {
        /** @type {QueryHelper[]} */
        this.freeQueryHelpers = [];
        this.timestampQuerySupported = true;
    }

    /**
     * Initialize performance monitoring
     * @param {GPUAdapter} adapter - WebGPU adapter
     */
    initialize(adapter) {
        this.timestampQuerySupported = adapter.features.has('timestamp-query');
    }

    /**
     * Get a query helper for performance monitoring
     * @param {GPUDevice} device - WebGPU device
     * @returns {QueryHelper | undefined} Query helper or undefined if not supported
     */
    getQueryHelper(device) {
        if (!this.timestampQuerySupported) {
            return undefined;
        }

        let queryHelper;
        if (this.freeQueryHelpers.length > 0) {
            queryHelper = this.freeQueryHelpers.pop();
        } else {
            queryHelper = new QueryHelper(device);
        }
        queryHelper.start();
        return queryHelper;
    }

    /**
     * Process query results and update debug display
     * @param {QueryHelper} queryHelper - Query helper with results
     * @param {boolean} paused - Whether simulation is paused
     */
    processQueryResults(queryHelper, paused) {
        if (!this.timestampQuerySupported) {
            return;
        }

        queryHelper.readBuffer.mapAsync(GPUMapMode.READ).then(() => {
            const values = new BigUint64Array(queryHelper.readBuffer.getMappedRange());
            let debugText = "";
            debugText += "Binning: " + (paused ? " -------" : formatExecutionTime(values[1] - values[0])) + "\n";
            debugText += "Forces:  " + (paused ? " -------" : formatExecutionTime(values[3] - values[2])) + "\n";
            debugText += "Advance: " + (paused ? " -------" : formatExecutionTime(values[5] - values[4])) + "\n";
            debugText += "Render:  " + formatExecutionTime(values[7] - values[6]) + "\n";
            debugText += "Compose: " + formatExecutionTime(values[9] - values[8]) + "\n";
            
            const debugElement = document.getElementById("debugInfo");
            if (debugElement) {
                debugElement.innerText = debugText;
            }
            
            queryHelper.readBuffer.unmap();
            this.freeQueryHelpers.push(queryHelper);
        });
    }
} 