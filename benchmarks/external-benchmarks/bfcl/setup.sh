#!/bin/bash

# BFCL Benchmark Setup Script
# Downloads Berkeley Function Calling Leaderboard test dataset

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="$SCRIPT_DIR/data"
DATASET_URL="https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard/resolve/main/gorilla_openfunctions_v1_test_executable_simple.json"
DATASET_FILE="$DATA_DIR/gorilla_openfunctions_v1_test_executable_simple.json"

echo "=========================================="
echo "BFCL Benchmark Setup"
echo "=========================================="
echo ""

# Create data directory
mkdir -p "$DATA_DIR"

# Try to download from HuggingFace
echo "Downloading BFCL test dataset from HuggingFace..."
echo "URL: $DATASET_URL"
echo ""

if command -v curl &> /dev/null; then
    if curl -L -f -o "$DATASET_FILE" "$DATASET_URL" 2>/dev/null; then
        echo "✓ Successfully downloaded dataset to $DATASET_FILE"

        # Validate JSON
        if command -v jq &> /dev/null; then
            if jq empty "$DATASET_FILE" 2>/dev/null; then
                CASE_COUNT=$(jq '. | length' "$DATASET_FILE")
                echo "✓ Dataset validated: $CASE_COUNT test cases"
            else
                echo "⚠ Warning: Downloaded file is not valid JSON"
                rm -f "$DATASET_FILE"
            fi
        else
            # Try with node if available
            if command -v node &> /dev/null; then
                if node -e "JSON.parse(require('fs').readFileSync('$DATASET_FILE', 'utf-8'))" 2>/dev/null; then
                    echo "✓ Dataset validated"
                else
                    echo "⚠ Warning: Downloaded file is not valid JSON"
                    rm -f "$DATASET_FILE"
                fi
            fi
        fi
    else
        echo "⚠ Failed to download dataset from HuggingFace"
    fi
elif command -v wget &> /dev/null; then
    if wget -O "$DATASET_FILE" "$DATASET_URL" 2>/dev/null; then
        echo "✓ Successfully downloaded dataset to $DATASET_FILE"

        # Validate JSON
        if command -v jq &> /dev/null; then
            if jq empty "$DATASET_FILE" 2>/dev/null; then
                CASE_COUNT=$(jq '. | length' "$DATASET_FILE")
                echo "✓ Dataset validated: $CASE_COUNT test cases"
            else
                echo "⚠ Warning: Downloaded file is not valid JSON"
                rm -f "$DATASET_FILE"
            fi
        fi
    else
        echo "⚠ Failed to download dataset from HuggingFace"
    fi
else
    echo "⚠ Neither curl nor wget found. Cannot download dataset."
fi

# Check if download was successful
if [ -f "$DATASET_FILE" ] && [ -s "$DATASET_FILE" ]; then
    echo ""
    echo "=========================================="
    echo "Setup Complete!"
    echo "=========================================="
    echo "Dataset location: $DATASET_FILE"
    echo ""
    echo "You can now run the benchmark:"
    echo "  cd $SCRIPT_DIR"
    echo "  npx ts-node runner.ts"
    echo ""
else
    echo ""
    echo "=========================================="
    echo "Download Failed - Using Built-in Fallback"
    echo "=========================================="
    echo ""
    echo "The benchmark will use built-in sample data (10 test cases)"
    echo "instead of the full BFCL dataset."
    echo ""
    echo "You can still run the benchmark:"
    echo "  cd $SCRIPT_DIR"
    echo "  npx ts-node runner.ts"
    echo ""
    echo "To manually download the dataset later:"
    echo "  curl -L -o '$DATASET_FILE' '$DATASET_URL'"
    echo ""
fi

# Create a README in the data directory
cat > "$DATA_DIR/README.md" << 'EOF'
# BFCL Test Data

This directory contains the Berkeley Function Calling Leaderboard test dataset.

## Dataset Source

- **Name**: Berkeley Function Calling Leaderboard (BFCL)
- **Source**: https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard
- **Subset**: `gorilla_openfunctions_v1_test_executable_simple.json`
- **License**: Apache 2.0

## Dataset Format

Each test case contains:
- `id`: Unique identifier
- `question`: Natural language query
- `functions`: Available functions (with JSON schema)
- `ground_truth`: Expected function call

## Fallback Behavior

If the dataset cannot be downloaded, the benchmark runner will automatically
use built-in sample data (10 representative test cases).

## Manual Download

To download the dataset manually:

```bash
curl -L -o gorilla_openfunctions_v1_test_executable_simple.json \
  https://huggingface.co/datasets/gorilla-llm/Berkeley-Function-Calling-Leaderboard/resolve/main/gorilla_openfunctions_v1_test_executable_simple.json
```
EOF

echo "Created README at $DATA_DIR/README.md"
