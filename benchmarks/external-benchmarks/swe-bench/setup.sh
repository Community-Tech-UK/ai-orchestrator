#!/bin/bash
#
# SWE-bench Lite Setup Script
# Sets up Python environment, installs dependencies, and downloads the dataset
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SCRIPT_DIR/venv"
DATA_DIR="$SCRIPT_DIR/data"

echo "🔧 SWE-bench Lite Setup"
echo "======================="
echo ""

# Check Python version
echo "1️⃣  Checking Python version..."
if ! command -v python3 &> /dev/null; then
    echo "❌ Error: python3 not found. Please install Python 3.10 or higher."
    exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
REQUIRED_VERSION="3.10"

if ! python3 -c "import sys; exit(0 if sys.version_info >= (3, 10) else 1)"; then
    echo "❌ Error: Python $PYTHON_VERSION found, but 3.10+ required."
    exit 1
fi

echo "✅ Python $PYTHON_VERSION detected"
echo ""

# Create virtual environment
echo "2️⃣  Creating virtual environment..."
if [ -d "$VENV_DIR" ]; then
    echo "⚠️  Virtual environment already exists at $VENV_DIR"
    read -p "   Delete and recreate? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$VENV_DIR"
        python3 -m venv "$VENV_DIR"
        echo "✅ Virtual environment recreated"
    else
        echo "ℹ️  Using existing virtual environment"
    fi
else
    python3 -m venv "$VENV_DIR"
    echo "✅ Virtual environment created at $VENV_DIR"
fi
echo ""

# Activate virtual environment
echo "3️⃣  Activating virtual environment..."
source "$VENV_DIR/bin/activate"
echo "✅ Virtual environment activated"
echo ""

# Upgrade pip
echo "4️⃣  Upgrading pip..."
pip install --upgrade pip -q
echo "✅ pip upgraded"
echo ""

# Install dependencies
echo "5️⃣  Installing Python packages..."
echo "   Installing swebench..."
pip install swebench -q
echo "   Installing datasets (for HuggingFace)..."
pip install datasets -q
echo "   Installing additional dependencies..."
pip install docker gitpython -q
echo "✅ Python packages installed"
echo ""

# Check Docker
echo "6️⃣  Checking Docker..."
if ! command -v docker &> /dev/null; then
    echo "⚠️  Warning: Docker not found."
    echo "   SWE-bench requires Docker to run test evaluations."
    echo "   Please install Docker Desktop from https://www.docker.com/products/docker-desktop"
    echo ""
else
    # Check if Docker daemon is running
    if docker info &> /dev/null; then
        echo "✅ Docker is installed and running"
    else
        echo "⚠️  Warning: Docker is installed but not running."
        echo "   Please start Docker Desktop before running evaluations."
    fi
fi
echo ""

# Create data directory
echo "7️⃣  Creating data directory..."
mkdir -p "$DATA_DIR"
echo "✅ Data directory created at $DATA_DIR"
echo ""

# Download SWE-bench Lite dataset
echo "8️⃣  Downloading SWE-bench Lite dataset..."
python3 << 'PYTHON_SCRIPT'
import os
import json
from datasets import load_dataset
from pathlib import Path

# Get the script directory
script_dir = Path(__file__).parent if hasattr(Path(__file__), 'parent') else Path.cwd()
data_dir = script_dir / "data"
data_file = data_dir / "swe-bench-lite.json"

if data_file.exists():
    print(f"ℹ️  Dataset already exists at {data_file}")
    response = input("   Re-download? (y/N): ").strip().lower()
    if response != 'y':
        print("ℹ️  Using existing dataset")
        exit(0)

print("📥 Downloading SWE-bench Lite from HuggingFace...")
print("   This may take a few minutes...")

try:
    # Load the SWE-bench Lite split
    dataset = load_dataset("princeton-nlp/SWE-bench_Lite", split="test")

    # Convert to list of dictionaries
    data = [dict(example) for example in dataset]

    # Save to JSON
    with open(data_file, 'w') as f:
        json.dump(data, f, indent=2)

    print(f"✅ Downloaded {len(data)} tasks")
    print(f"✅ Saved to {data_file}")

except Exception as e:
    print(f"❌ Error downloading dataset: {e}")
    exit(1)

PYTHON_SCRIPT

echo ""

# Success message
echo "🎉 Setup Complete!"
echo ""
echo "Next steps:"
echo "  1. Activate the virtual environment:"
echo "     source $VENV_DIR/bin/activate"
echo ""
echo "  2. Ensure Docker is running (required for test evaluation)"
echo ""
echo "  3. Run the benchmark:"
echo "     npx ts-node runner.ts --limit 10  # Test with 10 tasks"
echo "     npx ts-node runner.ts             # Full benchmark (300 tasks)"
echo ""
