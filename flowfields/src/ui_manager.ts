// flowfields/src/ui_manager.ts
import type { EquationSystem } from './parser';
import type { UIUniforms } from './tsl_generator';

/**
 * Manages the HTML UI panel, displaying equation info and parameter controls.
 */
export class UIManager {
    private equationNameEl: HTMLElement;
    private equationDescriptionEl: HTMLElement;
    private dxDtDisplayEl: HTMLElement;
    private dyDtDisplayEl: HTMLElement;
    private slidersContainerEl: HTMLElement;

    constructor() {
        // Find all the necessary DOM elements
        this.equationNameEl = document.getElementById('equation-name')!;
        this.equationDescriptionEl = document.getElementById('equation-description')!;
        this.dxDtDisplayEl = document.getElementById('dx_dt_display')!;
        this.dyDtDisplayEl = document.getElementById('dy_dt_display')!;
        this.slidersContainerEl = document.getElementById('sliders-container')!;

        if (!this.equationNameEl || !this.slidersContainerEl) {
            throw new Error('Required UI elements not found in the DOM.');
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