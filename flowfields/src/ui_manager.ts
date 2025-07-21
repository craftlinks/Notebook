// flowfields/src/ui_manager.ts
import type { EquationSystem } from './parser';
import type { UIUniforms } from './tsl_generator';

/**
 * Manages the HTML UI panel, displaying equation info and parameter controls.
 */
export class UIManager {
    private equationSelectEl: HTMLSelectElement;
    private equationNameEl: HTMLElement;
    private equationDescriptionEl: HTMLElement;
    private dxDtDisplayEl: HTMLElement;
    private dyDtDisplayEl: HTMLElement;
    private slidersContainerEl: HTMLElement;

    constructor() {
        // Find all the necessary DOM elements
        this.equationSelectEl = document.getElementById('equation-select') as HTMLSelectElement;
        this.equationNameEl = document.getElementById('equation-name')!;
        this.equationDescriptionEl = document.getElementById('equation-description')!;
        this.dxDtDisplayEl = document.getElementById('dx_dt_display')!;
        this.dyDtDisplayEl = document.getElementById('dy_dt_display')!;
        this.slidersContainerEl = document.getElementById('sliders-container')!;

        if (!this.equationNameEl || !this.slidersContainerEl || !this.equationSelectEl) {
            throw new Error('Required UI elements not found in the DOM.');
        }
    }

    /**
     * Initializes the UI, populates the selector, and sets up event listeners.
     * @param onSystemChange - Callback function to trigger when a new system is selected.
     */
    public async initialize(onSystemChange: (url: string) => void): Promise<void> {
        await this.populateSelector();
        
        this.equationSelectEl.addEventListener('change', (event) => {
            const url = (event.target as HTMLSelectElement).value;
            onSystemChange(url);
        });

        // Trigger the initial load with the first item in the list
        if (this.equationSelectEl.options.length > 0) {
            onSystemChange(this.equationSelectEl.options[0].value);
        }
    }

    /**
     * Populates the equation selector dropdown by dynamically finding files.
     */
    private async populateSelector(): Promise<void> {
        // Vite-specific feature to find all .json files in the examples directory
        const modules = import.meta.glob('/src/examples/*.json');

        for (const path in modules) {
            // e.g., "/src/examples/lotka_volterra.json" -> "Lotka Volterra"
            const fileName = path.split('/').pop()?.replace('.json', '');
            const displayName = fileName?.split('_').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') || path;

            const option = document.createElement('option');
            option.value = path; // The path is the URL
            option.textContent = displayName;
            this.equationSelectEl.appendChild(option);
        }
    }

    /**
     * Populates the UI panel with the information from the loaded equation system.
     *
     * @param system - The loaded EquationSystem.
     * @param uniforms - The generated UIUniforms object from the TSL generator.
     */
    public createUIForSystem(system: EquationSystem, uniforms: UIUniforms): void {
        // 1. Display equation name and description
        this.equationNameEl.textContent = system.name;
        this.equationDescriptionEl.textContent = system.description;

        // 2. Display the raw equations
        this.dxDtDisplayEl.innerHTML = `<code>dx/dt = ${system.equations.dx_dt}</code>`;
        this.dyDtDisplayEl.innerHTML = `<code>dy/dt = ${system.equations.dy_dt}</code>`;

        // 3. Clear any old sliders
        this.slidersContainerEl.innerHTML = '';

        // 4. Create a slider for each parameter
        for (const key in uniforms) {
            const uniform = uniforms[key];
            const sliderId = `slider-${key}`;
            
            const container = document.createElement('div');
            container.className = 'slider-container';

            const label = document.createElement('label');
            label.setAttribute('for', sliderId);
            label.textContent = key;
            
            const valueSpan = document.createElement('span');
            valueSpan.id = `value-${key}`;
            valueSpan.textContent = uniform.value.toFixed(3);
            label.appendChild(valueSpan);

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.id = sliderId;
            slider.min = String(uniform.min);
            slider.max = String(uniform.max);
            slider.value = String(uniform.value);
            slider.step = '0.001';

            // Add an event listener to update the TSL uniform when the slider moves
            slider.addEventListener('input', (event) => {
                const newValue = parseFloat((event.target as HTMLInputElement).value);
                uniform.live.value = newValue; // Update the live TSL uniform
                valueSpan.textContent = newValue.toFixed(3);
            });

            container.appendChild(label);
            container.appendChild(slider);
            this.slidersContainerEl.appendChild(container);
        }
    }
} 