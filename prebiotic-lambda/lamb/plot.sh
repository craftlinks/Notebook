#!/bin/bash
# Convenient wrapper for plot_simulation.py

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${SCRIPT_DIR}/.venv/bin/python"

# Check if venv exists
if [ ! -f "$PYTHON" ]; then
    echo "Virtual environment not found. Creating one..."
    python -m venv "${SCRIPT_DIR}/.venv"
    "${SCRIPT_DIR}/.venv/bin/pip" install pandas matplotlib
fi

# Run the plotter
exec "$PYTHON" "${SCRIPT_DIR}/plot_simulation.py" "$@"
