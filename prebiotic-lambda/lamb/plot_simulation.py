#!/usr/bin/env python3
"""
Visualization tool for LAMB simulation logs.

Plots diversity metrics (unique count, entropy, top frequency) over simulation steps.
"""

import pandas as pd
import matplotlib.pyplot as plt
from pathlib import Path
from typing import Optional
import argparse


def plot_simulation_log(
    csv_path: str | Path,
    output_path: Optional[str | Path] = None,
    show: bool = True,
    style: str = "seaborn-v0_8-darkgrid"
) -> None:
    """
    Create visualizations from a LAMB simulation log CSV file.
    
    Args:
        csv_path: Path to the simulation_log.csv file
        output_path: Optional path to save the figure (e.g., 'plot.png')
        show: Whether to display the plot interactively
        style: Matplotlib style to use
    """
    # Read the CSV file
    df = pd.read_csv(csv_path)
    
    # Set the style
    try:
        plt.style.use(style)
    except:
        plt.style.use('default')
    
    # Create a figure with subplots
    fig, axes = plt.subplots(3, 1, figsize=(12, 10))
    fig.suptitle('LAMB Simulation Diversity Metrics', fontsize=16, fontweight='bold')
    
    # Plot 1: Unique Count
    ax1 = axes[0]
    ax1.plot(df['step'], df['unique_count'], 
             color='#2E86AB', linewidth=2, label='Unique Count')
    ax1.fill_between(df['step'], df['unique_count'], 
                     alpha=0.3, color='#2E86AB')
    ax1.set_xlabel('Simulation Step', fontsize=11)
    ax1.set_ylabel('Unique Expressions', fontsize=11)
    ax1.set_title('Diversity: Unique Expression Count', fontsize=12, fontweight='bold')
    ax1.grid(True, alpha=0.3)
    ax1.legend(loc='best')
    
    # Add statistics annotation
    mean_unique = df['unique_count'].mean()
    final_unique = df['unique_count'].iloc[-1]
    ax1.axhline(mean_unique, color='red', linestyle='--', 
                alpha=0.5, linewidth=1, label=f'Mean: {mean_unique:.0f}')
    ax1.text(0.02, 0.98, f'Start: {df["unique_count"].iloc[0]}\nFinal: {final_unique:.0f}\nMean: {mean_unique:.0f}',
             transform=ax1.transAxes, verticalalignment='top',
             bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5),
             fontsize=9)
    
    # Plot 2: Entropy
    ax2 = axes[1]
    ax2.plot(df['step'], df['entropy'], 
             color='#A23B72', linewidth=2, label='Shannon Entropy')
    ax2.fill_between(df['step'], df['entropy'], 
                     alpha=0.3, color='#A23B72')
    ax2.set_xlabel('Simulation Step', fontsize=11)
    ax2.set_ylabel('Entropy (bits)', fontsize=11)
    ax2.set_title('Information Entropy', fontsize=12, fontweight='bold')
    ax2.grid(True, alpha=0.3)
    ax2.legend(loc='best')
    
    # Add statistics annotation
    mean_entropy = df['entropy'].mean()
    final_entropy = df['entropy'].iloc[-1]
    ax2.axhline(mean_entropy, color='red', linestyle='--', 
                alpha=0.5, linewidth=1)
    ax2.text(0.02, 0.98, f'Start: {df["entropy"].iloc[0]:.2f}\nFinal: {final_entropy:.2f}\nMean: {mean_entropy:.2f}',
             transform=ax2.transAxes, verticalalignment='top',
             bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5),
             fontsize=9)
    
    # Plot 3: Top Frequency
    ax3 = axes[2]
    ax3.plot(df['step'], df['top_freq'], 
             color='#F18F01', linewidth=2, label='Top Frequency')
    ax3.fill_between(df['step'], df['top_freq'], 
                     alpha=0.3, color='#F18F01')
    ax3.set_xlabel('Simulation Step', fontsize=11)
    ax3.set_ylabel('Frequency Count', fontsize=11)
    ax3.set_title('Dominance: Most Common Expression Frequency', fontsize=12, fontweight='bold')
    ax3.grid(True, alpha=0.3)
    ax3.legend(loc='best')
    
    # Add statistics annotation
    mean_top = df['top_freq'].mean()
    final_top = df['top_freq'].iloc[-1]
    ax3.axhline(mean_top, color='red', linestyle='--', 
                alpha=0.5, linewidth=1)
    ax3.text(0.02, 0.98, f'Start: {df["top_freq"].iloc[0]}\nFinal: {final_top:.0f}\nMean: {mean_top:.0f}',
             transform=ax3.transAxes, verticalalignment='top',
             bbox=dict(boxstyle='round', facecolor='wheat', alpha=0.5),
             fontsize=9)
    
    # Adjust layout to prevent overlap
    plt.tight_layout()
    
    # Save if output path is provided
    if output_path:
        plt.savefig(output_path, dpi=300, bbox_inches='tight')
        print(f"Plot saved to: {output_path}")
    
    # Show if requested
    if show:
        plt.show()
    
    plt.close()


def plot_combined_view(
    csv_path: str | Path,
    output_path: Optional[str | Path] = None,
    show: bool = True
) -> None:
    """
    Create a combined normalized view of all metrics.
    
    Args:
        csv_path: Path to the simulation_log.csv file
        output_path: Optional path to save the figure
        show: Whether to display the plot interactively
    """
    df = pd.read_csv(csv_path)
    
    # Normalize metrics to 0-1 scale for comparison
    df_norm = df.copy()
    for col in ['unique_count', 'entropy', 'top_freq']:
        min_val = df[col].min()
        max_val = df[col].max()
        df_norm[col] = (df[col] - min_val) / (max_val - min_val)
    
    fig, ax = plt.subplots(figsize=(14, 6))
    
    ax.plot(df['step'], df_norm['unique_count'], 
            label='Unique Count (normalized)', linewidth=2, color='#2E86AB')
    ax.plot(df['step'], df_norm['entropy'], 
            label='Entropy (normalized)', linewidth=2, color='#A23B72')
    ax.plot(df['step'], df_norm['top_freq'], 
            label='Top Frequency (normalized)', linewidth=2, color='#F18F01')
    
    ax.set_xlabel('Simulation Step', fontsize=12)
    ax.set_ylabel('Normalized Value (0-1)', fontsize=12)
    ax.set_title('LAMB Simulation: All Metrics (Normalized)', 
                 fontsize=14, fontweight='bold')
    ax.grid(True, alpha=0.3)
    ax.legend(loc='best', fontsize=10)
    
    plt.tight_layout()
    
    if output_path:
        plt.savefig(output_path, dpi=300, bbox_inches='tight')
        print(f"Combined plot saved to: {output_path}")
    
    if show:
        plt.show()
    
    plt.close()


def main() -> None:
    """Main entry point for the plotter."""
    parser = argparse.ArgumentParser(
        description='Visualize LAMB simulation log files',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Plot with default settings
  python plot_simulation.py simulation_log.csv
  
  # Save to file without showing
  python plot_simulation.py simulation_log.csv -o results.png --no-show
  
  # Create combined normalized view
  python plot_simulation.py simulation_log.csv --combined
  
  # Both views saved to files
  python plot_simulation.py simulation_log.csv -o detailed.png --combined -c combined.png
        """
    )
    
    parser.add_argument('csv_file', type=str,
                       help='Path to the simulation_log.csv file')
    parser.add_argument('-o', '--output', type=str, default=None,
                       help='Save detailed plot to file (e.g., plot.png)')
    parser.add_argument('-c', '--combined-output', type=str, default=None,
                       help='Save combined normalized plot to file')
    parser.add_argument('--no-show', action='store_true',
                       help='Do not display plots interactively')
    parser.add_argument('--combined', action='store_true',
                       help='Also create combined normalized view')
    parser.add_argument('--style', type=str, 
                       default='seaborn-v0_8-darkgrid',
                       help='Matplotlib style (default: seaborn-v0_8-darkgrid)')
    
    args = parser.parse_args()
    
    csv_path = Path(args.csv_file)
    
    if not csv_path.exists():
        print(f"Error: File not found: {csv_path}")
        return
    
    show = not args.no_show
    
    # Create detailed plot
    plot_simulation_log(
        csv_path=csv_path,
        output_path=args.output,
        show=show,
        style=args.style
    )
    
    # Create combined plot if requested
    if args.combined or args.combined_output:
        plot_combined_view(
            csv_path=csv_path,
            output_path=args.combined_output,
            show=show
        )
    
    print("\nSummary statistics:")
    df = pd.read_csv(csv_path)
    print(df[['unique_count', 'entropy', 'top_freq']].describe())


if __name__ == '__main__':
    main()
