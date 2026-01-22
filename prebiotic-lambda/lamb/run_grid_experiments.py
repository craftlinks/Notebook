#!/usr/bin/env python3
"""
Experiment runner for LAMB 2D Spatial Grid simulations.

Runs multiple spatial simulations with unique output files and generates plots for each.
The grid simulation combines Cellular Automata with Lambda Calculus for spatial chemistry.

Supports two modes:
1. Batch mode (lamb_grid): Headless simulations with CSV logging and plots.
2. View mode (lamb_view): Interactive graphical visualization with raylib.

Metabolic Model features:
- Catalytic interactions: A applies to B → C. A survives (catalyst), B transforms.
- Aging: Cells die at MAX_AGE (100 steps).
- Cosmic rays: Empty cells have a chance to spontaneously spawn new combinators.
"""

import subprocess
import sys
import os
import json
from pathlib import Path
from datetime import datetime
from typing import Optional, Any
import argparse


def run_grid_simulation(
    lamb_path: Path,
    width: int,
    height: int,
    density: int,
    iterations: int,
    depth: int,
    max_steps: int,
    log_file: str,
    run_id: int,
    total_runs: int,
) -> tuple[bool, str]:
    """
    Run a single LAMB grid simulation.
    
    Args:
        lamb_path: Path to the lamb executable
        width: Grid width
        height: Grid height
        density: Initial population density (percentage)
        iterations: Number of simulation steps
        depth: Maximum expression depth for seeding
        max_steps: Maximum reduction steps per reaction
        log_file: Base name for the log file (without .csv)
        run_id: Current run number (for display)
        total_runs: Total number of runs (for display)
    
    Returns:
        Tuple of (success: bool, output: str)
    """
    # Build the commands to send to lamb
    commands = f"""
:grid {width} {height} {density} {iterations} {depth} {max_steps} {log_file}
:quit
"""
    
    print(f"\n{'='*60}")
    print(f"🧪 Run {run_id}/{total_runs}")
    print(f"{'='*60}")
    print(f"Grid:       {width}x{height} ({width*height} cells)")
    print(f"Density:    {density}% (~{(width*height*density)//100} creatures)")
    print(f"Iterations: {iterations:,}")
    print(f"Depth:      {depth}")
    print(f"Max steps:  {max_steps}")
    print(f"Log file:   {log_file}.csv")
    print("-" * 60)
    
    try:
        result = subprocess.run(
            [str(lamb_path)],
            input=commands,
            capture_output=True,
            text=True,
            timeout=None  # Long simulations may take a while
        )
        
        # Check for errors
        if result.returncode != 0:
            print(f"❌ Run failed with exit code {result.returncode}")
            print(f"stderr: {result.stderr}")
            return False, result.stdout + result.stderr
        
        output = result.stdout
        
        # Print summary from output
        if "=== SIMULATION COMPLETE ===" in output:
            for line in output.split('\n'):
                if 'Total steps:' in line or \
                   'Reactions:' in line or \
                   'Movements:' in line or \
                   'Age deaths:' in line or \
                   'Cosmic rays:' in line or \
                   'Population:' in line or \
                   'Unique:' in line or \
                   'Dominant:' in line:
                    print(f"  {line.strip()}")
            print(f"✅ Run {run_id} completed successfully!")
        
        return True, output
        
    except subprocess.TimeoutExpired:
        print(f"❌ Run {run_id} timed out!")
        return False, "Timeout"
    except Exception as e:
        print(f"❌ Run {run_id} failed with error: {e}")
        return False, str(e)


def generate_plots(
    log_file: Path,
    plot_script: Path,
    python_path: Path,
    run_id: int
) -> bool:
    """Generate plots for a grid simulation log file."""
    if not log_file.exists():
        print(f"⚠️  Log file not found: {log_file}")
        return False
    
    detailed_plot = log_file.with_suffix('.png')
    combined_plot = log_file.with_name(log_file.stem + '_combined.png')
    
    try:
        result = subprocess.run(
            [
                str(python_path),
                str(plot_script),
                str(log_file),
                '-o', str(detailed_plot),
                '--combined',
                '-c', str(combined_plot),
                '--no-show'
            ],
            capture_output=True,
            text=True
        )
        
        if result.returncode == 0:
            print(f"📊 Plots generated: {detailed_plot.name}, {combined_plot.name}")
            return True
        else:
            print(f"⚠️  Plot generation failed: {result.stderr}")
            return False
            
    except Exception as e:
        print(f"⚠️  Plot generation error: {e}")
        return False


def launch_view(
    lamb_view_path: Path,
    width: int,
    height: int,
    cell_size: int,
    density: int,
    depth: int,
    eval_steps: int,
    max_mass: int,
) -> int:
    """
    Launch the interactive lamb_view graphical visualizer.
    
    Args:
        lamb_view_path: Path to the lamb_view executable
        width: Grid width
        height: Grid height
        cell_size: Cell size in pixels
        density: Initial population density (percentage)
        depth: Maximum expression depth for seeding
        eval_steps: Maximum reduction steps per reaction
        max_mass: Maximum allowed AST mass
    
    Returns:
        Exit code from lamb_view
    """
    cmd = [
        str(lamb_view_path),
        '--width', str(width),
        '--height', str(height),
        '--cell-size', str(cell_size),
        '--density', str(density),
        '--depth', str(depth),
        '--eval-steps', str(eval_steps),
        '--max-mass', str(max_mass),
    ]
    
    print("\n" + "=" * 70)
    print("🖥️  LAUNCHING LAMB VIEW - Interactive Visualizer")
    print("=" * 70)
    print(f"Grid:        {width}x{height} ({width * height} cells)")
    print(f"Cell size:   {cell_size} px")
    print(f"Window:      {width * cell_size}x{height * cell_size + 60} px")
    print(f"Density:     {density}% (~{(width * height * density) // 100} creatures)")
    print(f"Depth:       {depth}")
    print(f"Eval steps:  {eval_steps}")
    print(f"Max mass:    {max_mass}")
    print("-" * 70)
    print("Controls: SPACE=pause, S=step, UP/DOWN=speed, R=reset, H=help, ESC=quit")
    print("=" * 70)
    print()
    
    try:
        result = subprocess.run(cmd)
        return result.returncode
    except KeyboardInterrupt:
        print("\n🛑 View interrupted by user")
        return 130
    except Exception as e:
        print(f"❌ Failed to launch lamb_view: {e}")
        return 1


def extract_stats_from_output(output: str) -> dict[str, Any]:
    """Extract simulation statistics from lamb output."""
    stats: dict[str, Any] = {}
    
    for line in output.split('\n'):
        line = line.strip()
        if 'Total steps:' in line:
            try:
                stats['total_steps'] = int(line.split(':')[1].strip())
            except (ValueError, IndexError):
                pass
        elif 'Reactions:' in line:
            try:
                # Format: "Reactions: X successful, Y diverged"
                parts = line.split(':')[1].strip()
                if 'successful' in parts:
                    stats['reactions_success'] = int(parts.split('successful')[0].strip())
                if 'diverged' in parts:
                    div_part = parts.split(',')[1].strip()
                    stats['reactions_diverged'] = int(div_part.split('diverged')[0].strip())
            except (ValueError, IndexError):
                pass
        elif 'Movements:' in line:
            try:
                stats['movements'] = int(line.split(':')[1].strip())
            except (ValueError, IndexError):
                pass
        elif 'Age deaths:' in line:
            try:
                stats['deaths_age'] = int(line.split(':')[1].strip())
            except (ValueError, IndexError):
                pass
        elif 'Cosmic rays:' in line:
            try:
                # Format: "Cosmic rays: X spawns"
                parts = line.split(':')[1].strip()
                stats['cosmic_spawns'] = int(parts.split('spawns')[0].strip())
            except (ValueError, IndexError):
                pass
        elif 'Population:' in line and 'FINAL' not in line:
            try:
                stats['final_population'] = int(line.split(':')[1].strip())
            except (ValueError, IndexError):
                pass
        elif 'Unique:' in line:
            try:
                parts = line.split()
                for i, p in enumerate(parts):
                    if p == 'Unique:':
                        stats['final_unique_species'] = int(parts[i+1])
                        break
            except (ValueError, IndexError):
                pass
        elif 'Dominant:' in line:
            try:
                parts = line.split('Dominant:')[1].strip()
                if '(' in parts:
                    expr = parts.split('(')[0].strip()
                    stats['final_dominant_expr'] = expr
            except (ValueError, IndexError):
                pass
    
    return stats


def save_experiment_summary(
    output_dir: Path,
    args: argparse.Namespace,
    results: list[dict[str, Any]],
    successful_runs: int,
    failed_runs: int,
    start_time: datetime,
    end_time: datetime
) -> None:
    """Save experiment summary to JSON and text files."""
    # Reconstruct CLI command
    cli_parts = ['python', 'run_grid_experiments.py']
    cli_parts.extend([
        '--runs', str(args.runs),
        '--width', str(args.width),
        '--height', str(args.height),
        '--density', str(args.density),
        '--iterations', str(args.iterations),
        '--depth', str(args.depth),
        '--max-steps', str(args.max_steps),
        '--max-mass', str(args.max_mass),
    ])
    if args.output_dir:
        cli_parts.extend(['--output-dir', args.output_dir])
    if args.no_plots:
        cli_parts.append('--no-plots')
    if args.lamb != './lamb_grid':
        cli_parts.extend(['--lamb', args.lamb])
    if args.lamb_view != './lamb_view':
        cli_parts.extend(['--lamb-view', args.lamb_view])
    
    cli_command = ' '.join(cli_parts)
    
    summary = {
        'experiment': {
            'type': '2D_spatial_grid',
            'cli_command': cli_command,
            'start_time': start_time.isoformat(),
            'end_time': end_time.isoformat(),
            'duration_seconds': (end_time - start_time).total_seconds(),
            'output_directory': str(output_dir),
        },
        'parameters': {
            'runs': args.runs,
            'grid_width': args.width,
            'grid_height': args.height,
            'grid_cells': args.width * args.height,
            'density_percent': args.density,
            'initial_population': (args.width * args.height * args.density) // 100,
            'iterations': args.iterations,
            'depth': args.depth,
            'max_steps': args.max_steps,
            'max_mass': args.max_mass,
            'generate_plots': not args.no_plots,
        },
        'summary': {
            'successful_runs': successful_runs,
            'failed_runs': failed_runs,
            'total_runs': args.runs,
        },
        'runs': results,
    }
    
    # Save JSON
    json_path = output_dir / 'experiment_summary.json'
    with open(json_path, 'w') as f:
        json.dump(summary, f, indent=2)
    
    # Save human-readable text
    txt_path = output_dir / 'experiment_summary.txt'
    with open(txt_path, 'w') as f:
        f.write("=" * 70 + "\n")
        f.write("LAMB 2D SPATIAL GRID EXPERIMENT SUMMARY\n")
        f.write("=" * 70 + "\n\n")
        
        f.write("COMMAND TO REPRODUCE:\n")
        f.write(f"  {cli_command}\n\n")
        
        f.write("TIMING:\n")
        f.write(f"  Started:  {start_time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"  Finished: {end_time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"  Duration: {(end_time - start_time).total_seconds():.1f} seconds\n\n")
        
        f.write("PARAMETERS:\n")
        f.write(f"  Runs:             {args.runs}\n")
        f.write(f"  Grid size:        {args.width}x{args.height} ({args.width * args.height} cells)\n")
        f.write(f"  Density:          {args.density}%\n")
        f.write(f"  Initial pop:      {(args.width * args.height * args.density) // 100}\n")
        f.write(f"  Iterations:       {args.iterations:,}\n")
        f.write(f"  Depth:            {args.depth}\n")
        f.write(f"  Max steps:        {args.max_steps}\n")
        f.write(f"  Max mass:         {args.max_mass}\n")
        f.write(f"  Plots:            {'Yes' if not args.no_plots else 'No'}\n\n")
        
        f.write("RESULTS:\n")
        f.write(f"  Successful: {successful_runs}/{args.runs}\n")
        f.write(f"  Failed:     {failed_runs}/{args.runs}\n\n")
        
        f.write("RUN DETAILS:\n")
        f.write("-" * 70 + "\n")
        for run in results:
            run_id = run.get('run_id', '?')
            success = run.get('success', False)
            f.write(f"\nRun {run_id}: {'SUCCESS' if success else 'FAILED'}\n")
            if success:
                f.write(f"  Log:  {run.get('log_file', 'N/A')}\n")
                f.write(f"  Soup: {run.get('soup_file', 'N/A')}\n")
                if 'stats' in run:
                    stats = run['stats']
                    if 'total_steps' in stats:
                        f.write(f"  Steps: {stats['total_steps']:,}\n")
                    if 'reactions_success' in stats:
                        f.write(f"  Reactions: {stats['reactions_success']:,} successful")
                        if 'reactions_diverged' in stats:
                            f.write(f", {stats['reactions_diverged']:,} diverged")
                        f.write("\n")
                    if 'deaths_age' in stats:
                        f.write(f"  Age deaths: {stats['deaths_age']:,}\n")
                    if 'cosmic_spawns' in stats:
                        f.write(f"  Cosmic spawns: {stats['cosmic_spawns']:,}\n")
                    if 'final_unique_species' in stats:
                        f.write(f"  Final unique species: {stats['final_unique_species']}\n")
                    if 'final_dominant_expr' in stats:
                        f.write(f"  Dominant: {stats['final_dominant_expr']}\n")
        
        f.write("\n" + "=" * 70 + "\n")
        f.write(f"Output directory: {output_dir}\n")
        f.write("=" * 70 + "\n")
    
    print(f"📄 Summary saved: experiment_summary.json, experiment_summary.txt")


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Run LAMB 2D Spatial Grid simulations (batch or interactive view)',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run 5 batch simulations with default settings
  python run_grid_experiments.py --runs 5
  
  # Launch interactive graphical view
  python run_grid_experiments.py --view
  
  # Launch view with custom grid size
  python run_grid_experiments.py --view --width 80 --height 60 --cell-size 12
  
  # Large grid with longer simulation
  python run_grid_experiments.py --width 50 --height 50 --iterations 100000
  
  # Dense population, shallow expressions
  python run_grid_experiments.py --density 50 --depth 3
  
  # Custom output directory
  python run_grid_experiments.py --output-dir ./grid_results
        """
    )
    
    # Mode selection
    parser.add_argument('--view', '-v', action='store_true',
                       help='Launch interactive graphical view (lamb_view) instead of batch mode')
    
    # Grid parameters (shared between modes)
    parser.add_argument('--width', '-W', type=int, default=33,
                       help='Grid width (default: 33 for batch, 120 for view)')
    parser.add_argument('--height', '-H', type=int, default=33,
                       help='Grid height (default: 33 for batch, 80 for view)')
    parser.add_argument('--density', '-d', type=int, default=10,
                       help='Initial population density percentage (default: 10 for batch, 25 for view)')
    parser.add_argument('--depth', type=int, default=14,
                       help='Max expression depth for seeding (default: 14 for batch, 5 for view)')
    parser.add_argument('--max-steps', '--eval-steps', type=int, default=500,
                       help='Max reduction steps per reaction (default: 500 for batch, 100 for view)')
    parser.add_argument('--max-mass', type=int, default=2000,
                       help='Max allowed AST mass (default: 2000)')
    
    # View-specific parameters
    parser.add_argument('--cell-size', '-c', type=int, default=10,
                       help='Cell size in pixels for view mode (default: 10)')
    
    # Batch-specific parameters
    parser.add_argument('--runs', type=int, default=5,
                       help='Number of simulation runs for batch mode (default: 5)')
    parser.add_argument('--iterations', '-i', type=int, default=500000,
                       help='Number of simulation steps for batch mode (default: 500000)')
    parser.add_argument('--output-dir', type=str, default=None,
                       help='Output directory for batch mode (default: ./grid_experiments_TIMESTAMP)')
    parser.add_argument('--no-plots', action='store_true',
                       help='Skip plot generation in batch mode')
    
    # Executable paths
    parser.add_argument('--lamb', type=str, default='./lamb_grid',
                       help='Path to lamb_grid executable (default: ./lamb_grid)')
    parser.add_argument('--lamb-view', type=str, default='./lamb_view',
                       help='Path to lamb_view executable (default: ./lamb_view)')
    
    args = parser.parse_args()
    
    # Validate parameters
    if args.density < 1 or args.density > 100:
        print("❌ Density must be between 1 and 100")
        return 1
    
    # Setup paths
    script_dir = Path(__file__).parent.resolve()
    
    # Handle view mode
    if args.view:
        lamb_view_path = Path(args.lamb_view).resolve() if not Path(args.lamb_view).is_absolute() else Path(args.lamb_view)
        
        if not lamb_view_path.exists():
            lamb_view_path = script_dir / 'lamb_view'
        
        if not lamb_view_path.exists():
            print(f"❌ lamb_view executable not found at {lamb_view_path}")
            print("   Please compile it first: make lamb_view")
            return 1
        
        # Use view-appropriate defaults if user didn't override
        width = args.width if args.width != 33 else 120
        height = args.height if args.height != 33 else 80
        density = args.density if args.density != 10 else 25
        depth = args.depth if args.depth != 14 else 5
        eval_steps = args.max_steps if args.max_steps != 500 else 100
        
        return launch_view(
            lamb_view_path=lamb_view_path,
            width=width,
            height=height,
            cell_size=args.cell_size,
            density=density,
            depth=depth,
            eval_steps=eval_steps,
            max_mass=args.max_mass,
        )
    
    # Batch mode
    # Record start time
    start_time = datetime.now()
    
    lamb_path = Path(args.lamb).resolve() if not Path(args.lamb).is_absolute() else Path(args.lamb)
    
    if not lamb_path.exists():
        lamb_path = script_dir / 'lamb_grid'
    
    if not lamb_path.exists():
        print(f"❌ lamb_grid executable not found at {lamb_path}")
        print("   Please compile it first: make lamb_grid")
        return 1
    
    plot_script = script_dir / 'plot_grid_simulation.py'
    # Fall back to regular plot script if grid-specific one doesn't exist
    if not plot_script.exists():
        plot_script = script_dir / 'plot_simulation.py'
    
    python_path = script_dir / '.venv' / 'bin' / 'python'
    if not python_path.exists():
        python_path = Path(sys.executable)
    
    # Create output directory
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        output_dir = script_dir / f'grid_experiments_{timestamp}'
    
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Print experiment header
    print("\n" + "=" * 70)
    print("🌐 LAMB 2D SPATIAL GRID EXPERIMENT SUITE")
    print("=" * 70)
    print(f"Grid size:   {args.width}x{args.height} ({args.width * args.height} cells)")
    print(f"Density:     {args.density}% (~{(args.width * args.height * args.density) // 100} creatures)")
    print(f"Runs:        {args.runs}")
    print(f"Iterations:  {args.iterations:,}")
    print(f"Depth:       {args.depth}")
    print(f"Max steps:   {args.max_steps}")
    print(f"Output dir:  {output_dir}")
    print(f"Lamb path:   {lamb_path}")
    print("=" * 70)
    
    # Track results
    successful_runs = 0
    failed_runs = 0
    results: list[dict[str, Any]] = []
    
    # Change to output directory
    original_cwd = os.getcwd()
    os.chdir(output_dir)
    
    try:
        for run_id in range(1, args.runs + 1):
            # Generate unique filenames
            log_base = f'run_{run_id:02d}_log'
            soup_file = f'{log_base}.lamb'
            
            success, output = run_grid_simulation(
                lamb_path=lamb_path,
                width=args.width,
                height=args.height,
                density=args.density,
                iterations=args.iterations,
                depth=args.depth,
                max_steps=args.max_steps,
                log_file=log_base,
                run_id=run_id,
                total_runs=args.runs,
            )
            
            if success:
                successful_runs += 1
                stats = extract_stats_from_output(output)
                results.append({
                    'run_id': run_id,
                    'log_file': f'{log_base}.csv',
                    'soup_file': soup_file,
                    'success': True,
                    'stats': stats
                })
                
                # Generate plots if requested
                if not args.no_plots and plot_script.exists():
                    log_path = Path(f'{log_base}.csv')
                    generate_plots(log_path, plot_script, python_path, run_id)
            else:
                failed_runs += 1
                results.append({
                    'run_id': run_id,
                    'success': False
                })
    
    finally:
        os.chdir(original_cwd)
    
    # Record end time
    end_time = datetime.now()
    
    # Save experiment summary
    save_experiment_summary(
        output_dir=output_dir,
        args=args,
        results=results,
        successful_runs=successful_runs,
        failed_runs=failed_runs,
        start_time=start_time,
        end_time=end_time
    )
    
    # Print summary
    print("\n" + "=" * 70)
    print("📋 EXPERIMENT SUMMARY")
    print("=" * 70)
    print(f"Successful runs: {successful_runs}/{args.runs}")
    print(f"Failed runs:     {failed_runs}/{args.runs}")
    print(f"Output directory: {output_dir}")
    print()
    
    # List generated files
    print("Generated files:")
    for item in sorted(output_dir.iterdir()):
        size = item.stat().st_size
        if size > 1024 * 1024:
            size_str = f"{size / (1024*1024):.1f}MB"
        elif size > 1024:
            size_str = f"{size / 1024:.1f}KB"
        else:
            size_str = f"{size}B"
        print(f"  {item.name:40} {size_str:>10}")
    
    print("\n" + "=" * 70)
    print("🎉 Experiment suite complete!")
    print("=" * 70)
    
    return 0 if failed_runs == 0 else 1


if __name__ == '__main__':
    sys.exit(main())
