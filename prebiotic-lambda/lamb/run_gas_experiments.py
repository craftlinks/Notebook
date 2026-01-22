#!/usr/bin/env python3
"""
Experiment runner for LAMB Turing Gas simulations.

Runs multiple simulations with unique output files and generates plots for each.
Supports both random initialization and loading from existing .lamb soup files.
"""

import subprocess
import sys
import os
import re
import json
import tempfile
from pathlib import Path
from datetime import datetime
from typing import Optional, Any
import argparse


def merge_soup_files(input_files: list[Path]) -> tuple[Optional[Path], int]:
    """
    Merge multiple .lamb soup files into a single temporary file.
    
    Renumbers soup_* bindings to avoid conflicts when merging multiple files.
    
    Args:
        input_files: List of .lamb files to merge
    
    Returns:
        Tuple of (path to merged temporary file or None on error, soup count)
    """
    merged_bindings: list[str] = []
    soup_index = 0
    
    # Pattern to match soup_N = <expression>;
    soup_pattern = re.compile(r'^soup_\d+\s*=\s*(.+);$')
    # Pattern to match any binding: name = expression;
    binding_pattern = re.compile(r'^(\w+)\s*=\s*(.+);$')
    
    for input_file in input_files:
        if not input_file.exists():
            print(f"❌ Input file not found: {input_file}")
            return None, 0
        
        try:
            content = input_file.read_text()
        except IOError as e:
            print(f"❌ Failed to read {input_file}: {e}")
            return None, 0
        
        for line in content.splitlines():
            line = line.strip()
            
            # Skip empty lines and comments
            if not line or line.startswith('//'):
                continue
            
            # Check if it's a soup_* binding
            soup_match = soup_pattern.match(line)
            if soup_match:
                expr = soup_match.group(1)
                merged_bindings.append(f"soup_{soup_index} = {expr};")
                soup_index += 1
                continue
            
            # Check if it's any other binding (non-soup)
            binding_match = binding_pattern.match(line)
            if binding_match:
                name = binding_match.group(1)
                expr = binding_match.group(2)
                # Only include non-soup bindings
                if not name.startswith('soup_'):
                    merged_bindings.append(f"{name} = {expr};")
    
    if soup_index == 0:
        print("⚠️  No soup_* bindings found in input files")
    
    # Create temporary file for merged content
    try:
        fd, temp_path = tempfile.mkstemp(suffix='.lamb', prefix='merged_soup_')
        with os.fdopen(fd, 'w') as f:
            f.write("// LAMB_SOUP_V1\n")
            f.write(f"// Merged from: {', '.join(str(p) for p in input_files)}\n")
            f.write(f"// count={soup_index}\n\n")
            f.write('\n'.join(merged_bindings))
            f.write('\n')
        return Path(temp_path), soup_index
    except IOError as e:
        print(f"❌ Failed to create merged soup file: {e}")
        return None, 0


def run_simulation(
    lamb_path: Path,
    pool_size: int,
    iterations: int,
    depth: int,
    max_steps: int,
    log_file: str,
    soup_file: str,
    graph_file: str,
    run_id: int,
    total_runs: int,
    input_files: Optional[list[Path]] = None
) -> tuple[bool, str]:
    """
    Run a single LAMB simulation.
    
    Args:
        lamb_path: Path to the lamb executable
        pool_size: Number of expressions in the soup (ignored if input_files provided)
        iterations: Number of reaction iterations
        depth: Maximum expression depth
        max_steps: Maximum reduction steps per reaction
        log_file: Base name for the log file (without .csv)
        soup_file: Filename for the soup dump (.lamb)
        graph_file: Filename for the reaction network graph (.json)
        run_id: Current run number (for display)
        total_runs: Total number of runs (for display)
        input_files: Optional list of .lamb files to load as initial soup
    
    Returns:
        Tuple of (success: bool, output: str)
    """
    # Build the commands to send to lamb
    commands = f"""
:gas {pool_size} {iterations} {depth} {max_steps} {log_file}
:dump_soup {soup_file}
:export_graph {graph_file}
:quit
"""
    
    # If input files are provided, merge them first to get actual pool size
    merged_soup_path: Optional[Path] = None
    actual_pool_size = pool_size
    if input_files:
        merged_soup_path, actual_pool_size = merge_soup_files(input_files)
        if merged_soup_path is None:
            return False, "Failed to merge input soup files"
    
    print(f"\n{'='*60}")
    print(f"🧪 Run {run_id}/{total_runs}")
    print(f"{'='*60}")
    if input_files:
        print(f"Input files: {', '.join(str(f) for f in input_files)}")
        print(f"Loaded pool: {actual_pool_size} expressions")
    print(f"Parameters: pool={actual_pool_size}, iterations={iterations}, depth={depth}, max_steps={max_steps}")
    print(f"Log file:   {log_file}.csv")
    print(f"Soup file:  {soup_file}")
    print(f"Graph file: {graph_file}")
    print("-" * 60)
    
    # If input files are provided, prepend load command for merged soup
    if input_files and merged_soup_path:
        commands = f":load {merged_soup_path}\n" + commands
    
    try:
        result = subprocess.run(
            [str(lamb_path)],
            input=commands,
            capture_output=True,
            text=True,
            timeout=None  # Long simulations may take a while
        )
        
        # Check for errors in output
        if "ERROR" in result.stderr or result.returncode != 0:
            print(f"❌ Run failed!")
            print(f"stderr: {result.stderr}")
            return False, result.stdout + result.stderr
        
        # Extract key stats from output
        output = result.stdout
        
        # Print summary
        if "=== SIMULATION COMPLETE ===" in output:
            # Extract stats
            for line in output.split('\n'):
                if 'Converged reactions:' in line or \
                   'Diverged reactions:' in line or \
                   'Error reactions:' in line or \
                   'Unique Spec:' in line or \
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
    finally:
        # Clean up merged soup file if we created one
        if merged_soup_path and merged_soup_path.exists():
            try:
                merged_soup_path.unlink()
            except OSError:
                pass  # Best effort cleanup


def generate_plots(
    log_file: Path,
    plot_script: Path,
    python_path: Path,
    run_id: int
) -> bool:
    """Generate plots for a simulation log file."""
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


def generate_network_graph(
    graph_file: Path,
    network_script: Path,
    python_path: Path,
    run_id: int
) -> bool:
    """Generate network visualization from reaction graph JSON."""
    if not graph_file.exists():
        print(f"⚠️  Graph file not found: {graph_file}")
        return False
    
    output_png = graph_file.with_suffix('.png').with_name(
        graph_file.stem.replace('_graph', '_network') + '.png'
    )
    
    try:
        result = subprocess.run(
            [
                str(python_path),
                str(network_script),
                str(graph_file),
                str(output_png)
            ],
            capture_output=True,
            text=True
        )
        
        if result.returncode == 0:
            # Extract key metrics from output
            output_lines = result.stdout.strip().split('\n')
            for line in output_lines:
                if 'Closure Ratio:' in line or 'species' in line.lower():
                    pass  # Could print metrics here
            print(f"🕸️  Network graph: {output_png.name}")
            return True
        else:
            print(f"⚠️  Network graph generation failed: {result.stderr}")
            return False
            
    except Exception as e:
        print(f"⚠️  Network graph error: {e}")
        return False


def extract_stats_from_output(output: str) -> dict[str, Any]:
    """Extract simulation statistics from lamb output."""
    stats: dict[str, Any] = {}
    
    for line in output.split('\n'):
        line = line.strip()
        if 'Converged reactions:' in line:
            try:
                stats['converged_reactions'] = int(line.split(':')[1].strip())
            except (ValueError, IndexError):
                pass
        elif 'Diverged reactions:' in line:
            try:
                stats['diverged_reactions'] = int(line.split(':')[1].strip())
            except (ValueError, IndexError):
                pass
        elif 'Error reactions:' in line:
            try:
                stats['error_reactions'] = int(line.split(':')[1].strip())
            except (ValueError, IndexError):
                pass
        elif 'Unique Spec:' in line:
            # Take the last occurrence (final state)
            try:
                parts = line.split()
                for i, p in enumerate(parts):
                    if p == 'Spec:':
                        stats['final_unique_species'] = int(parts[i+1])
                        # Extract diversity percentage
                        for j, p2 in enumerate(parts):
                            if p2.endswith('%'):
                                stats['final_diversity_pct'] = float(p2.rstrip('%').lstrip('('))
                                break
                        break
            except (ValueError, IndexError):
                pass
        elif 'Dominant:' in line:
            # Take the last occurrence (final state)
            try:
                # Format: "Dominant: \v1.v2.v3.v1 (Count: 178, 8.90%)"
                parts = line.split('Dominant:')[1].strip()
                if '(Count:' in parts:
                    expr_part = parts.split('(Count:')[0].strip()
                    count_part = parts.split('(Count:')[1]
                    count = int(count_part.split(',')[0].strip())
                    stats['final_dominant_expr'] = expr_part
                    stats['final_dominant_count'] = count
            except (ValueError, IndexError):
                pass
    
    return stats


def save_experiment_summary(
    output_dir: Path,
    args: argparse.Namespace,
    input_files: Optional[list[Path]],
    results: list[dict[str, Any]],
    successful_runs: int,
    failed_runs: int,
    start_time: datetime,
    end_time: datetime
) -> None:
    """Save experiment summary to JSON and text files."""
    # Reconstruct the CLI command
    cli_parts = ['python', 'run_experiments.py']
    if input_files:
        cli_parts.extend(['--input'] + [str(f) for f in input_files])
    cli_parts.extend([
        '--runs', str(args.runs),
        '--pool', str(args.pool),
        '--iterations', str(args.iterations),
        '--depth', str(args.depth),
        '--max-steps', str(args.max_steps),
    ])
    if args.output_dir:
        cli_parts.extend(['--output-dir', args.output_dir])
    if args.no_plots:
        cli_parts.append('--no-plots')
    if args.lamb != './lamb_gas':
        cli_parts.extend(['--lamb', args.lamb])
    
    cli_command = ' '.join(cli_parts)
    
    summary = {
        'experiment': {
            'cli_command': cli_command,
            'start_time': start_time.isoformat(),
            'end_time': end_time.isoformat(),
            'duration_seconds': (end_time - start_time).total_seconds(),
            'output_directory': str(output_dir),
        },
        'parameters': {
            'runs': args.runs,
            'pool_size': args.pool,
            'iterations': args.iterations,
            'depth': args.depth,
            'max_steps': args.max_steps,
            'generate_plots': not args.no_plots,
        },
        'input_files': [str(f) for f in input_files] if input_files else None,
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
        f.write("LAMB TURING GAS EXPERIMENT SUMMARY\n")
        f.write("=" * 70 + "\n\n")
        
        f.write("COMMAND TO REPRODUCE:\n")
        f.write(f"  {cli_command}\n\n")
        
        f.write("TIMING:\n")
        f.write(f"  Started:  {start_time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"  Finished: {end_time.strftime('%Y-%m-%d %H:%M:%S')}\n")
        f.write(f"  Duration: {(end_time - start_time).total_seconds():.1f} seconds\n\n")
        
        f.write("PARAMETERS:\n")
        f.write(f"  Runs:       {args.runs}\n")
        f.write(f"  Pool size:  {args.pool}\n")
        f.write(f"  Iterations: {args.iterations:,}\n")
        f.write(f"  Depth:      {args.depth}\n")
        f.write(f"  Max steps:  {args.max_steps}\n")
        f.write(f"  Plots:      {'Yes' if not args.no_plots else 'No'}\n\n")
        
        if input_files:
            f.write("INPUT FILES:\n")
            for inp in input_files:
                f.write(f"  - {inp}\n")
            f.write("\n")
        
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
                f.write(f"  Log:   {run.get('log_file', 'N/A')}\n")
                f.write(f"  Soup:  {run.get('soup_file', 'N/A')}\n")
                f.write(f"  Graph: {run.get('graph_file', 'N/A')}\n")
                if 'stats' in run:
                    stats = run['stats']
                    if 'converged_reactions' in stats:
                        f.write(f"  Converged: {stats['converged_reactions']:,}\n")
                    if 'diverged_reactions' in stats:
                        f.write(f"  Diverged:  {stats['diverged_reactions']:,}\n")
                    if 'final_unique_species' in stats:
                        f.write(f"  Final unique species: {stats['final_unique_species']}")
                        if 'final_diversity_pct' in stats:
                            f.write(f" ({stats['final_diversity_pct']:.2f}% diversity)")
                        f.write("\n")
                    if 'final_dominant_expr' in stats:
                        f.write(f"  Dominant: {stats['final_dominant_expr']}")
                        if 'final_dominant_count' in stats:
                            f.write(f" (count: {stats['final_dominant_count']})")
                        f.write("\n")
        
        f.write("\n" + "=" * 70 + "\n")
        f.write(f"Output directory: {output_dir}\n")
        f.write("=" * 70 + "\n")
    
    print(f"📄 Summary saved: experiment_summary.json, experiment_summary.txt")


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Run multiple LAMB Turing Gas simulations',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Run 10 simulations with random initialization
  python run_experiments.py
  
  # Custom parameters
  python run_experiments.py --runs 5 --pool 500 --iterations 500000
  
  # Specify output directory
  python run_experiments.py --output-dir ./results
  
  # Run from existing soup file(s)
  python run_experiments.py --input soup1.lamb soup2.lamb --iterations 1000000
  
  # Continue evolving a previous experiment's soup
  python run_experiments.py --input experiments_old/run_01_soup.lamb --runs 3
        """
    )
    
    parser.add_argument('--input', '-i', type=str, nargs='+', default=None,
                       metavar='FILE',
                       help='Input .lamb file(s) to use as initial soup (soups are merged)')
    parser.add_argument('--runs', type=int, default=10,
                       help='Number of simulation runs (default: 10)')
    parser.add_argument('--pool', type=int, default=1000,
                       help='Pool size - number of expressions (default: 1000, ignored if --input provided)')
    parser.add_argument('--iterations', type=int, default=1000000,
                       help='Number of iterations/collisions (default: 1000000)')
    parser.add_argument('--depth', type=int, default=14,
                       help='Max expression depth for random generation (default: 7)')
    parser.add_argument('--max-steps', type=int, default=500,
                       help='Max reduction steps per reaction (default: 500)')
    parser.add_argument('--output-dir', type=str, default=None,
                       help='Output directory for results (default: ./experiments_TIMESTAMP)')
    parser.add_argument('--no-plots', action='store_true',
                       help='Skip plot generation')
    parser.add_argument('--lamb', type=str, default='./lamb_gas',
                       help='Path to lamb_gas executable (default: ./lamb_gas)')
    
    args = parser.parse_args()
    
    # Record start time
    start_time = datetime.now()
    
    # Process input files if provided
    input_files: Optional[list[Path]] = None
    if args.input:
        input_files = [Path(f).resolve() for f in args.input]
        # Validate all input files exist
        for f in input_files:
            if not f.exists():
                print(f"❌ Input file not found: {f}")
                return 1
    
    # Setup paths
    script_dir = Path(__file__).parent.resolve()
    lamb_path = Path(args.lamb).resolve() if not Path(args.lamb).is_absolute() else Path(args.lamb)
    
    if not lamb_path.exists():
        lamb_path = script_dir / 'lamb_gas'
    
    if not lamb_path.exists():
        print(f"❌ lamb_gas executable not found at {lamb_path}")
        print("   Please compile it first: make lamb_gas")
        return 1
    
    plot_script = script_dir / 'plot_simulation.py'
    network_script = script_dir / 'visualize_network.py'
    python_path = script_dir / '.venv' / 'bin' / 'python'
    
    if not python_path.exists():
        python_path = Path(sys.executable)
    
    # Create output directory
    if args.output_dir:
        output_dir = Path(args.output_dir)
    else:
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        output_dir = script_dir / f'experiments_{timestamp}'
    
    output_dir.mkdir(parents=True, exist_ok=True)
    
    # Print experiment header
    print("\n" + "=" * 70)
    print("🔬 LAMB TURING GAS EXPERIMENT SUITE")
    print("=" * 70)
    if input_files:
        print(f"Input files: {len(input_files)} file(s)")
        for f in input_files:
            print(f"             - {f}")
        print(f"(Pool size determined by loaded soup)")
    else:
        print(f"Pool size:   {args.pool}")
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
    results: list[dict] = []
    
    # Change to output directory for lamb to write files there
    original_cwd = os.getcwd()
    os.chdir(output_dir)
    
    try:
        for run_id in range(1, args.runs + 1):
            # Generate unique filenames
            log_base = f'run_{run_id:02d}_log'
            soup_file = f'run_{run_id:02d}_soup.lamb'
            graph_file = f'run_{run_id:02d}_graph.json'
            
            success, output = run_simulation(
                lamb_path=lamb_path,
                pool_size=args.pool,
                iterations=args.iterations,
                depth=args.depth,
                max_steps=args.max_steps,
                log_file=log_base,
                soup_file=soup_file,
                graph_file=graph_file,
                run_id=run_id,
                total_runs=args.runs,
                input_files=input_files
            )
            
            if success:
                successful_runs += 1
                # Extract statistics from simulation output
                stats = extract_stats_from_output(output)
                results.append({
                    'run_id': run_id,
                    'log_file': f'{log_base}.csv',
                    'soup_file': soup_file,
                    'graph_file': graph_file,
                    'success': True,
                    'stats': stats
                })
                
                # Generate plots if requested
                if not args.no_plots and plot_script.exists():
                    log_path = Path(f'{log_base}.csv')  # We're already in output_dir
                    generate_plots(log_path, plot_script, python_path, run_id)
                
                # Generate network visualization
                if not args.no_plots and network_script.exists():
                    graph_path = Path(graph_file)  # We're already in output_dir
                    generate_network_graph(graph_path, network_script, python_path, run_id)
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
        input_files=input_files,
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
