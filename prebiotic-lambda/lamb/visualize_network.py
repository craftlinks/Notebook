#!/usr/bin/env python3
"""
Reaction Network Visualizer for Lambda Calculus Turing Gas

Visualizes the reaction network exported from the lamb interpreter's :export_graph command.
Shows species as nodes and reactions as edges, with analysis of network closure.

Usage:
    python visualize_network.py network_data.json [output.png]
"""

import json
import sys
from pathlib import Path
from typing import Any

import matplotlib.pyplot as plt
import matplotlib.patches as mpatches
import networkx as nx
import numpy as np

# Maximum number of species for full network visualization
# Beyond this, the graph becomes unreadable and takes too long to compute
MAX_SPECIES_FOR_VISUALIZATION = 150


def load_network(filepath: str) -> dict[str, Any]:
    """Load the JSON network data."""
    with open(filepath) as f:
        return json.load(f)


def build_reaction_graph(data: dict[str, Any]) -> tuple[nx.DiGraph, nx.DiGraph, dict[int, str], dict[int, int]]:
    """
    Build directed graphs from the reaction data.
    
    Returns:
        - closed_graph: Only reactions that stay within the population
        - full_graph: All reactions including those producing external results
        - labels: Node ID -> lambda expression label
        - counts: Node ID -> population count
    """
    labels = {n['id']: n['label'] for n in data['nodes']}
    counts = {n['id']: n['count'] for n in data['nodes']}
    
    closed_graph = nx.DiGraph()
    full_graph = nx.DiGraph()
    
    # Add all nodes
    for node in data['nodes']:
        closed_graph.add_node(node['id'])
        full_graph.add_node(node['id'])
    
    # Process reactions: A(B) -> C
    # We represent this as edges from both A and B to C
    for link in data['links']:
        src = link['source']  # The "function" being applied
        tgt = link['target']  # The "argument"
        res = link['result']  # The product
        
        # Store the full reaction info as edge data
        full_graph.add_edge(src, tgt, result=res, closed=(res != -1))
        
        if res != -1:
            closed_graph.add_edge(src, tgt, result=res)
    
    return closed_graph, full_graph, labels, counts


def analyze_network(data: dict[str, Any], labels: dict[int, str]) -> dict[str, Any]:
    """Analyze the reaction network for interesting properties."""
    total_reactions = len(data['links'])
    closed_reactions = sum(1 for link in data['links'] if link['result'] != -1)
    open_reactions = total_reactions - closed_reactions
    
    # Find which reactions "leak" out of the network
    leaks = [(link['source'], link['target']) for link in data['links'] if link['result'] == -1]
    
    # Build a product graph: edges point from (source, target) pair to result
    # Analyze which nodes are "productive" (can create other nodes)
    producers: dict[int, set[int]] = {n['id']: set() for n in data['nodes']}
    for link in data['links']:
        if link['result'] != -1:
            producers[link['source']].add(link['result'])
    
    # Find "universal" nodes that produce the same result regardless of argument
    universal_nodes: dict[int, int] = {}
    for node in data['nodes']:
        nid = node['id']
        results_as_function = set()
        for link in data['links']:
            if link['source'] == nid and link['result'] != -1:
                results_as_function.add(link['result'])
        if len(results_as_function) == 1:
            universal_nodes[nid] = list(results_as_function)[0]
    
    # Find "identity-like" behavior: A(X) -> X for all X
    identity_like = []
    for node in data['nodes']:
        nid = node['id']
        is_identity = True
        for link in data['links']:
            if link['source'] == nid:
                if link['result'] != link['target']:
                    is_identity = False
                    break
        if is_identity:
            identity_like.append(nid)
    
    return {
        'total_reactions': total_reactions,
        'closed_reactions': closed_reactions,
        'open_reactions': open_reactions,
        'closure_ratio': closed_reactions / total_reactions if total_reactions > 0 else 0,
        'leaks': leaks,
        'producers': producers,
        'universal_nodes': universal_nodes,
        'identity_like': identity_like,
    }


def shorten_label(label: str, max_len: int = 12) -> str:
    """Shorten a lambda expression label for display."""
    if len(label) <= max_len:
        return label
    # Count the number of leading \vN. patterns
    parts = label.split('.')
    if len(parts) <= 2:
        return label[:max_len-2] + '..'
    # Show first param and depth indicator
    return f"{parts[0]}..({len(parts)-1})"


def visualize_network(
    data: dict[str, Any],
    output_path: str | None = None,
    show_all_edges: bool = False
) -> None:
    """Create a visualization of the reaction network."""
    closed_graph, full_graph, labels, counts = build_reaction_graph(data)
    analysis = analyze_network(data, labels)
    
    num_species = len(data['nodes'])
    too_large = num_species > MAX_SPECIES_FOR_VISUALIZATION
    
    if too_large:
        print(f"⚠️  Network has {num_species} species (>{MAX_SPECIES_FOR_VISUALIZATION})")
        print("   Generating analysis-only summary (network graph skipped)")
    
    # Create figure layout based on whether we're showing the network
    if too_large:
        fig = plt.figure(figsize=(10, 12))
        fig.patch.set_facecolor('#0d1117')
        ax2 = fig.add_subplot(111)
        ax2.set_facecolor('#0d1117')
        ax2.axis('off')
        ax1 = None
    else:
        fig = plt.figure(figsize=(16, 10))
        fig.patch.set_facecolor('#0d1117')
        ax1 = fig.add_subplot(121)
        ax1.set_facecolor('#0d1117')
        ax2 = fig.add_subplot(122)
        ax2.set_facecolor('#0d1117')
        ax2.axis('off')
    
    # ===== Network Visualization (only if not too large) =====
    G = full_graph if show_all_edges else closed_graph
    pos = {}
    
    if not too_large and len(G.nodes()) > 0:
        pos = nx.spring_layout(G, k=2.5, iterations=100, seed=42)
    
    # Only draw network if not too large
    cmap = plt.cm.plasma  # Define cmap here for legend use
    
    if not too_large and ax1 is not None:
        # Node sizes based on population count
        max_count = max(counts.values()) if counts else 1
        node_sizes = [300 + 1500 * (counts.get(n, 1) / max_count) for n in G.nodes()]
        
        # Node colors: gradient based on ID (shows evolutionary relationship)
        num_nodes = len(G.nodes())
        node_colors = [cmap(i / max(num_nodes - 1, 1)) for i in range(num_nodes)]
        
        # Draw edges
        edge_colors = []
        edge_styles = []
        for u, v in G.edges():
            edge_data = G.edges[u, v]
            if edge_data.get('result', -1) == -1:
                edge_colors.append('#ff6b6b')  # Red for leaks
                edge_styles.append('dashed')
            else:
                edge_colors.append('#4a5568')  # Gray for closed
                edge_styles.append('solid')
        
        # Draw the network
        nx.draw_networkx_edges(
            G, pos, ax=ax1,
            edge_color=edge_colors,
            alpha=0.4,
            arrows=True,
            arrowsize=10,
            connectionstyle="arc3,rad=0.1",
            width=1.5
        )
        
        nx.draw_networkx_nodes(
            G, pos, ax=ax1,
            node_size=node_sizes,
            node_color=node_colors,
            edgecolors='#e2e8f0',
            linewidths=2
        )
        
        # Labels: shortened versions
        short_labels = {n: shorten_label(labels.get(n, str(n))) for n in G.nodes()}
        nx.draw_networkx_labels(
            G, pos, ax=ax1,
            labels=short_labels,
            font_size=8,
            font_color='#e2e8f0',
            font_family='monospace'
        )
        
        ax1.set_title('Reaction Network', color='#e2e8f0', fontsize=14, fontweight='bold')
        ax1.axis('off')
    
    # ===== Analysis Panel =====
    analysis_text = []
    if too_large:
        analysis_text.append("═══ NETWORK ANALYSIS (Summary Only) ═══\n")
        analysis_text.append(f"⚠️  {num_species} species exceeds visualization limit ({MAX_SPECIES_FOR_VISUALIZATION})\n")
    else:
        analysis_text.append("═══ NETWORK ANALYSIS ═══\n")
    analysis_text.append(f"Species Count: {len(data['nodes'])}")
    analysis_text.append(f"Total Population: {sum(counts.values())}")
    analysis_text.append(f"Total Reactions: {analysis['total_reactions']}")
    analysis_text.append(f"Closed Reactions: {analysis['closed_reactions']}")
    analysis_text.append(f"Open (Leak) Reactions: {analysis['open_reactions']}")
    analysis_text.append(f"Closure Ratio: {analysis['closure_ratio']:.1%}")
    
    analysis_text.append("\n═══ SPECIES (by abundance) ═══\n")
    sorted_nodes = sorted(data['nodes'], key=lambda x: -x['count'])
    for i, node in enumerate(sorted_nodes[:8]):  # Top 8
        pct = 100 * node['count'] / sum(counts.values())
        analysis_text.append(f"{i+1}. {shorten_label(node['label'], 20)}")
        analysis_text.append(f"   Count: {node['count']} ({pct:.1f}%)")
    
    if len(sorted_nodes) > 8:
        analysis_text.append(f"   ... and {len(sorted_nodes) - 8} more species")
    
    if analysis['universal_nodes']:
        analysis_text.append("\n═══ CONSTANT FUNCTIONS ═══")
        analysis_text.append("(Always produce same result)\n")
        for nid, result in list(analysis['universal_nodes'].items())[:5]:
            analysis_text.append(f"  {shorten_label(labels[nid], 16)} → {shorten_label(labels[result], 12)}")
    
    if analysis['leaks']:
        analysis_text.append("\n═══ LEAK REACTIONS ═══")
        analysis_text.append("(Produce external results)\n")
        for src, tgt in analysis['leaks'][:5]:
            analysis_text.append(f"  {shorten_label(labels[src], 12)}({shorten_label(labels[tgt], 12)}) → ?")
        if len(analysis['leaks']) > 5:
            analysis_text.append(f"  ... and {len(analysis['leaks']) - 5} more")
    
    ax2.text(
        0.05, 0.95, '\n'.join(analysis_text),
        transform=ax2.transAxes,
        fontsize=10,
        fontfamily='monospace',
        verticalalignment='top',
        color='#e2e8f0',
        bbox=dict(boxstyle='round', facecolor='#1a1f2e', edgecolor='#4a5568', alpha=0.9)
    )
    
    # Legend (only if network was drawn)
    if not too_large and ax1 is not None:
        legend_elements = [
            mpatches.Patch(facecolor=cmap(0.2), edgecolor='#e2e8f0', label='Most Abundant'),
            mpatches.Patch(facecolor=cmap(0.8), edgecolor='#e2e8f0', label='Least Abundant'),
        ]
        ax1.legend(handles=legend_elements, loc='lower left', 
                   facecolor='#1a1f2e', edgecolor='#4a5568',
                   labelcolor='#e2e8f0', fontsize=9)
    
    plt.tight_layout()
    
    if output_path:
        plt.savefig(output_path, dpi=150, facecolor='#0d1117', edgecolor='none')
        print(f"Saved visualization to {output_path}")
    
    plt.show()


def print_reaction_table(data: dict[str, Any]) -> None:
    """Print a text-based reaction table for analysis."""
    labels = {n['id']: n['label'] for n in data['nodes']}
    n = len(data['nodes'])
    
    print("\n═══ REACTION MATRIX ═══")
    print("(Row applies to Column → Result)")
    print()
    
    # Build matrix
    matrix: dict[tuple[int, int], int] = {}
    for link in data['links']:
        matrix[(link['source'], link['target'])] = link['result']
    
    # Header
    header = "     │ " + " ".join(f"{i:3}" for i in range(n))
    print(header)
    print("─" * len(header))
    
    for i in range(n):
        row = f"{i:3}  │ "
        for j in range(n):
            res = matrix.get((i, j), -1)
            if res == -1:
                row += "  X "
            else:
                row += f"{res:3} "
        print(row)
    
    print()
    print("Legend: X = produces expression outside population")


def main() -> None:
    if len(sys.argv) < 2:
        print("Usage: python visualize_network.py <network.json> [output.png]")
        print("\nExample:")
        print("  python visualize_network.py 07.json network_viz.png")
        sys.exit(1)
    
    json_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None
    
    if not Path(json_path).exists():
        print(f"Error: File not found: {json_path}")
        sys.exit(1)
    
    print(f"Loading network from {json_path}...")
    data = load_network(json_path)
    
    num_species = len(data['nodes'])
    num_reactions = len(data['links'])
    print(f"Found {num_species} species and {num_reactions} reactions")
    
    # Print reaction table (only for small networks)
    if num_species <= MAX_SPECIES_FOR_VISUALIZATION:
        print_reaction_table(data)
    else:
        print(f"\n⚠️  Skipping reaction table ({num_species} species is too large)")
        print(f"   Network visualization will show analysis summary only")
    
    # Visualize
    visualize_network(data, output_path)


if __name__ == "__main__":
    main()
