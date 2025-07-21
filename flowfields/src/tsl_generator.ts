// flowfields/src/tsl_generator.ts
import { 
    uniform, float, vec2, sin, cos, mul, add, sub, div, Fn,
    type ShaderNodeObject
} from 'three/tsl';
import type { EquationSystem } from './parser';

/**
 * This will hold the generated uniforms in a format that's easy for a UI to consume.
 */
export interface UINumberUniform {
    value: number;
    min: number;
    max: number;
    live: ShaderNodeObject<any>; // The actual TSL uniform variable
}

export type UIUniforms = Record<string, UINumberUniform>;


/**
 * This will be the output of our generator, containing everything needed
 * to run and control the new equation system.
 */
export interface GeneratedTSL {
    computeFn: ShaderNodeObject<any>;
    uniforms: UIUniforms;
    config: EquationSystem['config'];
}

// A map of string function names to their corresponding TSL functions.
// This can be extended to support more functions.
const TSL_FN_MAP: Record<string, (...args: any[]) => ShaderNodeObject<any>> = {
    sin,
    cos,
};

/**
 * Parses a mathematical expression string into a TSL Node.
 *
 * This is a recursive descent parser that handles basic arithmetic operations,
 * parentheses, and function calls from TSL_FN_MAP. It respects operator
 * precedence for +, -, *, and /.
 *
 * @param expression - The string expression (e.g., "alpha * x - 1.0").
 * @param scope - A map of available variable/parameter names to their TSL Nodes.
 * @returns A TSL Node representing the expression.
 */
function parseExpression(expression: string, scope: Record<string, ShaderNodeObject<any>>): ShaderNodeObject<any> {
    expression = expression.trim();

    // Base case: Handle parentheses by recursively parsing the inner content.
    if (expression.startsWith('(') && expression.endsWith(')')) {
        let level = 0;
        let isOuter = true;
        for (let i = 0; i < expression.length - 1; i++) {
            if (expression[i] === '(') level++;
            if (expression[i] === ')') level--;
            if (level === 0 && i < expression.length - 2) {
                isOuter = false;
                break;
            }
        }
        if (isOuter) {
            return parseExpression(expression.substring(1, expression.length - 1), scope);
        }
    }

    // Recursive step: Split by lowest precedence operators first (addition/subtraction).
    let level = 0;
    for (let i = expression.length - 1; i >= 0; i--) {
        const char = expression[i];
        if (char === ')') level++;
        else if (char === '(') level--;

        if (level === 0 && (char === '+' || char === '-')) {
            const left = parseExpression(expression.substring(0, i), scope);
            const right = parseExpression(expression.substring(i + 1), scope);
            return char === '+' ? add(left, right) : sub(left, right);
        }
    }

    // Recursive step: Split by higher precedence operators (multiplication/division).
    level = 0;
    for (let i = expression.length - 1; i >= 0; i--) {
        const char = expression[i];
        if (char === ')') level++;
        else if (char === '(') level--;

        if (level === 0 && (char === '*' || char === '/')) {
            const left = parseExpression(expression.substring(0, i), scope);
            const right = parseExpression(expression.substring(i + 1), scope);
            return char === '*' ? mul(left, right) : div(left, right);
        }
    }

    // Base case: Handle function calls, e.g., "sin(a * y)".
    const fnMatch = expression.match(/^(\w+)\((.*)\)$/);
    if (fnMatch) {
        const fnName = fnMatch[1];
        const argExpr = fnMatch[2];
        const tslFn = TSL_FN_MAP[fnName];
        if (tslFn) {
            const argNode = parseExpression(argExpr, scope);
            return tslFn(argNode);
        } else {
            throw new Error(`Unknown function in expression: ${fnName}`);
        }
    }
    
    // Base case: Handle terminals (variables, parameters, or numbers).
    const term = expression.trim();
    if (scope[term]) {
        return scope[term];
    }
    if (!isNaN(parseFloat(term))) {
        return float(parseFloat(term));
    }
    throw new Error(`Unknown term in expression: "${term}"`);
}


/**
 * Generates an executable TSL function from a parsed equation system.
 *
 * @param system - The EquationSystem object from the JSON file.
 * @param normalizedPosition - A TSL `vec2` node representing the particle's (x, y) position in the range [-1, 1].
 * @returns A GeneratedTSL object containing the compute function and UI-ready uniforms.
 */
export function generateTSL(
    system: EquationSystem, 
    normalizedPosition: ShaderNodeObject<any>
): GeneratedTSL {
    
    const uiUniforms: UIUniforms = {};
    const scope: Record<string, ShaderNodeObject<any>> = {};

    // 1. Create TSL uniforms for all parameters and add them to the scope.
    for (const key in system.parameters) {
        const param = system.parameters[key];

        // Create the UniformNode. This is the JS object whose .value we can update.
        const uniformNode = uniform(param.initial);
        
        // Store this object so the UI can manipulate its .value property.
        uiUniforms[key] = {
            value: param.initial,
            min: param.min,
            max: param.max,
            live: uniformNode
        };
        
        // Add the uniform to the shader's scope so it can be used in equations.
        scope[key] = uniformNode;
    }

    // 2. Add base variables (x, y) to the scope.
    scope['x'] = normalizedPosition.x;
    scope['y'] = normalizedPosition.y;

    // 3. Define intermediate variables if they exist and add them to the scope.
    if (system.variables) {
        for (const key in system.variables) {
            const expression = system.variables[key];
            const variableNode = parseExpression(expression, scope);
            // .toVar() creates a named variable in the shader for reuse.
            scope[key] = variableNode.toVar();
        }
    }

    // 4. Parse the main equations to get the final velocity components.
    const dx_dt = parseExpression(system.equations.dx_dt, scope);
    const dy_dt = parseExpression(system.equations.dy_dt, scope);

    // 5. Build the final flow vector from the equation results.
    const flowVector = vec2(dx_dt, dy_dt);

    // 6. Create the final TSL function. This function, when called in the
    //    compute shader, will execute all the parsed logic and return the result.
    const computeFn = Fn(() => {
        return flowVector;
    });

    return {
        computeFn,
        uniforms: uiUniforms,
        config: system.config
    };
} 