#!/usr/bin/env python3
"""
Plot visualization for LAMB 2D Spatial Grid simulation logs.

Generates plots for population dynamics, species diversity, and reaction statistics.
Supports the Metabolic Model with age deaths and cosmic ray spawns.
"""

import sys
import argparse
from pathlib import Path

try:
    import matplotlib.pyplot as plt
    import matplotlib.ticker as ticker
    import pandas as pd
    import numpy as np
except ImportError as e:
    print(f"Error: Missing required package: {e}")
    print("Install with: pip install matplotlib pandas numpy")
    sys.exit(1)


def load_log(filepath: Path) -> pd.DataFrame:
    """Load and validate a grid simulation log CSV."""
    try:
        df = pd.read_csv(filepath)
    except Exception as e:
        print(f"Error loading {filepath}: {e}")
        sys.exit(1)
    
    required_cols = ['step', 'population', 'unique_species']
    missing = [c for c in required_cols if c not in df.columns]
    if missing:
        print(f"Error: Missing columns in log file: {missing}")
        print(f"Found columns: {list(df.columns)}")
        sys.exit(1)
    
    return df


def plot_detailed(df: pd.DataFrame, output_path: Path, title: str = "Grid Simulation") -> None:
    """Create a detailed 6-panel plot for Metabolic Model with phenotypic behaviors."""
    # Check if we have metabolic stats and phenotypic behavior stats
    has_metabolic = 'deaths_age' in df.columns or 'cosmic_spawns' in df.columns
    has_phenotypic = 'attacks' in df.columns or 'evasions' in df.columns
    
    if has_metabolic:
        fig, axes = plt.subplots(2, 3, figsize=(18, 10))
    else:
        fig, axes = plt.subplots(2, 2, figsize=(14, 10))
    fig.suptitle(title, fontsize=14, fontweight='bold')
    
    # Color scheme
    colors = {
        'population': '#2ecc71',
        'unique': '#3498db', 
        'diversity': '#9b59b6',
        'reactions': '#e74c3c',
        'diverged': '#e67e22',
        'movements': '#1abc9c',
        'deaths': '#c0392b',
        'spawns': '#f39c12',
        'attacks': '#e74c3c',
        'evasions': '#3498db',
    }
    
    # 1. Population over time
    ax1 = axes[0, 0]
    ax1.plot(df['step'], df['population'], color=colors['population'], linewidth=1.5, label='Population')
    ax1.set_xlabel('Step')
    ax1.set_ylabel('Population')
    ax1.set_title('Population Dynamics')
    ax1.grid(True, alpha=0.3)
    ax1.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, p: f'{x/1000:.0f}k' if x >= 1000 else f'{x:.0f}'))
    
    # 2. Species diversity
    ax2 = axes[0, 1]
    ax2.plot(df['step'], df['unique_species'], color=colors['unique'], linewidth=1.5, label='Unique Species')
    ax2.set_xlabel('Step')
    ax2.set_ylabel('Unique Species')
    ax2.set_title('Species Diversity')
    ax2.grid(True, alpha=0.3)
    ax2.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, p: f'{x/1000:.0f}k' if x >= 1000 else f'{x:.0f}'))
    
    # 3. Diversity ratio (unique/population)
    if has_metabolic:
        ax3 = axes[0, 2]
    else:
        ax3 = axes[1, 0]
    diversity_ratio = df['unique_species'] / df['population'].replace(0, 1) * 100
    ax3.plot(df['step'], diversity_ratio, color=colors['diversity'], linewidth=1.5)
    ax3.set_xlabel('Step')
    ax3.set_ylabel('Diversity (%)')
    ax3.set_title('Species Diversity Ratio')
    ax3.grid(True, alpha=0.3)
    ax3.set_ylim(0, 105)
    ax3.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, p: f'{x/1000:.0f}k' if x >= 1000 else f'{x:.0f}'))
    
    # 4. Reactions and Phenotypic Behaviors (if available)
    if has_metabolic:
        ax4 = axes[1, 0]
    else:
        ax4 = axes[1, 1]
    if 'reactions_success' in df.columns:
        ax4.plot(df['step'], df['reactions_success'], color=colors['reactions'], linewidth=1.5, label='Replications')
        if 'reactions_diverged' in df.columns:
            ax4.plot(df['step'], df['reactions_diverged'], color=colors['diverged'], linewidth=1.5, label='Diverged')
        # Add phenotypic behavior lines if available
        if has_phenotypic:
            if 'attacks' in df.columns:
                ax4.plot(df['step'], df['attacks'], color=colors['attacks'], linewidth=1.5, linestyle='--', label='Attacks')
            if 'evasions' in df.columns:
                ax4.plot(df['step'], df['evasions'], color=colors['evasions'], linewidth=1.5, linestyle=':', label='Evasions')
        ax4.set_xlabel('Step')
        ax4.set_ylabel('Cumulative Count')
        ax4.set_title('Reactions & Behaviors')
        ax4.legend(loc='upper left', fontsize='small')
        ax4.grid(True, alpha=0.3)
        ax4.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, p: f'{x/1000:.0f}k' if x >= 1000 else f'{x:.0f}'))
    elif 'movements' in df.columns:
        ax4.plot(df['step'], df['movements'], color=colors['movements'], linewidth=1.5)
        ax4.set_xlabel('Step')
        ax4.set_ylabel('Cumulative Movements')
        ax4.set_title('Movement Statistics')
        ax4.grid(True, alpha=0.3)
        ax4.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, p: f'{x/1000:.0f}k' if x >= 1000 else f'{x:.0f}'))
    else:
        ax4.text(0.5, 0.5, 'No reaction data available', ha='center', va='center', transform=ax4.transAxes)
        ax4.set_title('Reaction Statistics')
    
    # 5 & 6. Metabolic Model stats (deaths & spawns)
    if has_metabolic:
        # Deaths from age
        ax5 = axes[1, 1]
        if 'deaths_age' in df.columns:
            ax5.plot(df['step'], df['deaths_age'], color=colors['deaths'], linewidth=1.5, label='Age Deaths')
            ax5.set_xlabel('Step')
            ax5.set_ylabel('Cumulative Deaths')
            ax5.set_title('Deaths from Old Age')
            ax5.grid(True, alpha=0.3)
            ax5.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, p: f'{x/1000:.0f}k' if x >= 1000 else f'{x:.0f}'))
        else:
            ax5.text(0.5, 0.5, 'No age death data', ha='center', va='center', transform=ax5.transAxes)
            ax5.set_title('Deaths from Old Age')
        
        # Cosmic spawns
        ax6 = axes[1, 2]
        if 'cosmic_spawns' in df.columns:
            ax6.plot(df['step'], df['cosmic_spawns'], color=colors['spawns'], linewidth=1.5, label='Cosmic Spawns')
            ax6.set_xlabel('Step')
            ax6.set_ylabel('Cumulative Spawns')
            ax6.set_title('Cosmic Ray Spawns')
            ax6.grid(True, alpha=0.3)
            ax6.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, p: f'{x/1000:.0f}k' if x >= 1000 else f'{x:.0f}'))
        else:
            ax6.text(0.5, 0.5, 'No cosmic spawn data', ha='center', va='center', transform=ax6.transAxes)
            ax6.set_title('Cosmic Ray Spawns')
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    print(f"Detailed plot saved to: {output_path}")


def plot_combined(df: pd.DataFrame, output_path: Path, title: str = "Grid Simulation") -> None:
    """Create a combined single-panel plot showing key metrics."""
    has_metabolic = 'deaths_age' in df.columns or 'cosmic_spawns' in df.columns
    
    fig, ax1 = plt.subplots(figsize=(14, 6))
    fig.suptitle(title, fontsize=14, fontweight='bold')
    
    # Primary axis: Population
    color1 = '#2ecc71'
    ax1.set_xlabel('Step')
    ax1.set_ylabel('Population', color=color1)
    line1 = ax1.plot(df['step'], df['population'], color=color1, linewidth=2, label='Population')
    ax1.tick_params(axis='y', labelcolor=color1)
    ax1.xaxis.set_major_formatter(ticker.FuncFormatter(lambda x, p: f'{x/1000:.0f}k' if x >= 1000 else f'{x:.0f}'))
    
    # Secondary axis: Unique species
    ax2 = ax1.twinx()
    color2 = '#3498db'
    ax2.set_ylabel('Unique Species', color=color2)
    line2 = ax2.plot(df['step'], df['unique_species'], color=color2, linewidth=2, linestyle='--', label='Unique Species')
    ax2.tick_params(axis='y', labelcolor=color2)
    
    # Additional lines for metabolic model (on primary axis, normalized)
    lines = line1 + line2
    
    if has_metabolic:
        # Add rate of deaths and spawns (derivative) as a subtle background indicator
        # We show these as filled areas to indicate turnover
        if 'deaths_age' in df.columns and len(df) > 1:
            deaths_rate = df['deaths_age'].diff().fillna(0)
            deaths_rate_smooth = deaths_rate.rolling(window=10, min_periods=1).mean()
            # Normalize to fit on secondary axis scale
            max_unique = df['unique_species'].max() if df['unique_species'].max() > 0 else 1
            deaths_scaled = deaths_rate_smooth / deaths_rate_smooth.max() * max_unique * 0.3 if deaths_rate_smooth.max() > 0 else deaths_rate_smooth
            ax2.fill_between(df['step'], 0, deaths_scaled, alpha=0.15, color='#c0392b', label='Death Rate')
        
        if 'cosmic_spawns' in df.columns and len(df) > 1:
            spawns_rate = df['cosmic_spawns'].diff().fillna(0)
            spawns_rate_smooth = spawns_rate.rolling(window=10, min_periods=1).mean()
            max_unique = df['unique_species'].max() if df['unique_species'].max() > 0 else 1
            spawns_scaled = spawns_rate_smooth / spawns_rate_smooth.max() * max_unique * 0.3 if spawns_rate_smooth.max() > 0 else spawns_rate_smooth
            ax2.fill_between(df['step'], 0, spawns_scaled, alpha=0.15, color='#f39c12', label='Spawn Rate')
    
    # Combine legends
    labels = [l.get_label() for l in lines]
    ax1.legend(lines, labels, loc='upper right')
    
    ax1.grid(True, alpha=0.3)
    
    plt.tight_layout()
    plt.savefig(output_path, dpi=150, bbox_inches='tight')
    print(f"Combined plot saved to: {output_path}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Plot LAMB 2D Grid simulation results',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python plot_grid_simulation.py grid_log.csv
  python plot_grid_simulation.py grid_log.csv -o custom_plot.png
  python plot_grid_simulation.py grid_log.csv --combined -c combined.png
        """
    )
    
    parser.add_argument('logfile', type=str, help='Path to the CSV log file')
    parser.add_argument('-o', '--output', type=str, default=None,
                       help='Output path for detailed plot (default: <logfile>.png)')
    parser.add_argument('--combined', action='store_true',
                       help='Also generate a combined single-panel plot')
    parser.add_argument('-c', '--combined-output', type=str, default=None,
                       help='Output path for combined plot (default: <logfile>_combined.png)')
    parser.add_argument('--title', type=str, default=None,
                       help='Custom title for the plot')
    parser.add_argument('--no-show', action='store_true',
                       help='Do not display the plot (just save)')
    
    args = parser.parse_args()
    
    logfile = Path(args.logfile)
    if not logfile.exists():
        print(f"Error: Log file not found: {logfile}")
        return 1
    
    # Load data
    df = load_log(logfile)
    
    # Determine output paths
    output_path = Path(args.output) if args.output else logfile.with_suffix('.png')
    combined_path = Path(args.combined_output) if args.combined_output else logfile.with_name(logfile.stem + '_combined.png')
    
    # Generate title
    title = args.title if args.title else f"Grid Simulation: {logfile.stem}"
    
    # Generate plots
    plot_detailed(df, output_path, title)
    
    if args.combined:
        plot_combined(df, combined_path, title)
    
    if not args.no_show:
        plt.show()
    
    return 0


if __name__ == '__main__':
    sys.exit(main())
