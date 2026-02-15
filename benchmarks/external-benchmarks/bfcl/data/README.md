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
