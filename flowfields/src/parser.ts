// flowfields/src/parser.ts

// ===================================
// Type Definitions for Equation Files
// ===================================

/**
 * Defines the structure for a single tunable parameter.
 */
export interface EquationParameter {
    initial: number;
    min: number;
    max: number;
    description?: string;
}

/**
 * Defines the overall structure of a flow field equation file.
 */
export interface EquationSystem {
    name: string;
    description: string;
    parameters: Record<string, EquationParameter>;
    variables?: Record<string, string>;
    equations: {
        dx_dt: string;
        dy_dt: string;
    };
    config?: {
        velocity_scale?: number;
        smoothing_factor?: number;
    };
}

// ===================================
// Parser
// ===================================

/**
 * Fetches and parses an equation file from a given URL.
 *
 * @param url - The path to the JSON equation file.
 * @returns A promise that resolves to the parsed EquationSystem object.
 */
export async function loadEquationSystem(url: string): Promise<EquationSystem> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch equation file: ${response.statusText}`);
        }
        const data = await response.json();
        
        // Basic validation (can be expanded later)
        if (!data.name || !data.parameters || !data.equations) {
            throw new Error('Invalid equation file format: missing required fields.');
        }

        return data as EquationSystem;
    } catch (error) {
        console.error(`Error loading or parsing equation file from ${url}:`, error);
        throw error;
    }
}

/**
 * Example usage:
 * 
 * async function main() {
 *     try {
 *         const deJong = await loadEquationSystem('/src/examples/dejong.json');
 *         console.log('Loaded system:', deJong);
 * 
 *         // Later, you would pass this object to a TSL code generator
 *         // const tslCode = generateTSL(deJong);
 * 
 *     } catch (error) {
 *         console.error('Failed to load equation system.');
 *     }
 * }
 * 
 * // main();
 */

export async function testParser() {
    console.log('--- Running Parser Test ---');
    try {
        const deJong = await loadEquationSystem('/src/examples/dejong.json');
        console.log('Successfully loaded De Jong Attractor:', deJong);

        const lotkaVolterra = await loadEquationSystem('/src/examples/lotka_volterra.json');
        console.log('Successfully loaded Lotka-Volterra:', lotkaVolterra);

    } catch (error) {
        console.error('Parser test failed:', error);
    }
    console.log('--- Parser Test Complete ---');
} 