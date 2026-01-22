# LAMB Simulation Log Plotter

A Python visualization tool for analyzing LAMB simulation diversity metrics over time.

## Features

- **Three detailed plots**: Unique expression count, Shannon entropy, and top frequency
- **Combined normalized view**: Compare all metrics on a single chart
- **Statistical annotations**: Mean values, start/end points displayed on plots
- **Flexible output**: Save to files or display interactively
- **Beautiful styling**: Modern, publication-ready visualizations

## Installation

### Option 1: Using virtual environment (recommended)

```bash
# Create virtual environment
python -m venv .venv

# Activate it
source .venv/bin/activate  # On Linux/Mac
# or
.venv\Scripts\activate  # On Windows

# Install dependencies
pip install -r plot_requirements.txt
```

### Option 2: System-wide installation

```bash
pip install pandas matplotlib
```

## Usage

### Basic Usage

Display plots interactively:

```bash
python plot_simulation.py simulation_log.csv
```

Or with virtual environment:

```bash
.venv/bin/python plot_simulation.py simulation_log.csv
```

### Save to File

```bash
python plot_simulation.py simulation_log.csv -o results.png --no-show
```

### Combined Normalized View

```bash
python plot_simulation.py simulation_log.csv --combined
```

### Save Both Views

```bash
python plot_simulation.py simulation_log.csv -o detailed.png --combined -c combined.png --no-show
```

## Command Line Options

```
positional arguments:
  csv_file              Path to the simulation_log.csv file

optional arguments:
  -h, --help            show this help message and exit
  -o OUTPUT, --output OUTPUT
                        Save detailed plot to file (e.g., plot.png)
  -c COMBINED_OUTPUT, --combined-output COMBINED_OUTPUT
                        Save combined normalized plot to file
  --no-show             Do not display plots interactively
  --combined            Also create combined normalized view
  --style STYLE         Matplotlib style (default: seaborn-v0_8-darkgrid)
```

## Understanding the Plots

### Plot 1: Unique Expression Count
- **What it shows**: Number of distinct lambda expressions in the soup at each step
- **Interpretation**: Higher values indicate greater diversity
- **Trend**: Usually decreases over time as selection pressure increases

### Plot 2: Shannon Entropy
- **What it shows**: Information entropy of the expression distribution
- **Interpretation**: Higher entropy means more evenly distributed expressions
- **Formula**: H = -Σ(p_i * log₂(p_i))
- **Range**: 0 (one dominant expression) to log₂(N) (all expressions equally frequent)

### Plot 3: Top Frequency
- **What it shows**: Count of the most common expression
- **Interpretation**: Higher values indicate dominance by a single expression
- **Trend**: Often increases as one or few expressions become dominant

### Combined Normalized View
- All three metrics scaled to 0-1 range for easy comparison
- Reveals correlations and phase transitions in the simulation

## Output Statistics

The script prints summary statistics including:
- Count, mean, std, min, quartiles, max for each metric
- Visual annotations on plots showing start, final, and mean values

## Examples

### Quick visualization
```bash
.venv/bin/python plot_simulation.py simulation_log.csv
```

### Publication-ready output
```bash
.venv/bin/python plot_simulation.py simulation_log.csv \
    -o figure_detailed.png \
    --combined -c figure_combined.png \
    --no-show \
    --style seaborn-v0_8-whitegrid
```

### Batch processing multiple files
```bash
for log in *.csv; do
    .venv/bin/python plot_simulation.py "$log" \
        -o "plot_${log%.csv}.png" \
        --no-show
done
```

## Dependencies

- Python 3.8+
- pandas >= 2.0.0
- matplotlib >= 3.7.0

## Color Scheme

The plots use a carefully chosen color palette:
- **Blue (#2E86AB)**: Unique count (diversity)
- **Purple (#A23B72)**: Entropy (information)
- **Orange (#F18F01)**: Top frequency (dominance)

## Tips

1. **High diversity**: Start with many unique expressions, high entropy
2. **Phase transition**: Watch for rapid changes in all three metrics
3. **Convergence**: Decreasing unique count + entropy, increasing top frequency
4. **Innovation**: Sudden spikes in unique count indicate new expression generation
5. **Extinction events**: Sharp drops in diversity metrics

## Troubleshooting

**Import errors**: Make sure pandas and matplotlib are installed
```bash
.venv/bin/pip install pandas matplotlib
```

**Style warnings**: If you see style warnings, use `--style default`

**Memory issues**: For very large CSV files, consider downsampling the data first

## License

Part of the LAMB (Lambda Calculus) project.
