#!/usr/bin/env python3
"""
SWE-bench Evaluation Bridge

Bridge script to run SWE-bench evaluation from TypeScript runner.
Takes predictions JSON and outputs evaluation results.
"""

import sys
import json
import os
import subprocess
from pathlib import Path
from typing import Dict, List, Any

def check_docker() -> bool:
    """Check if Docker is available and running."""
    try:
        result = subprocess.run(
            ['docker', 'info'],
            capture_output=True,
            timeout=10
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False

def run_evaluation(predictions_path: str, output_path: str = None) -> Dict[str, Any]:
    """
    Run SWE-bench evaluation on predictions.

    Args:
        predictions_path: Path to predictions JSON file
        output_path: Optional path to save results

    Returns:
        Evaluation results as dictionary
    """
    if not os.path.exists(predictions_path):
        return {
            'error': f'Predictions file not found: {predictions_path}',
            'success': False
        }

    # Check Docker
    if not check_docker():
        return {
            'error': 'Docker is not running. Please start Docker Desktop.',
            'success': False
        }

    # Load predictions
    try:
        with open(predictions_path, 'r') as f:
            predictions = json.load(f)
    except Exception as e:
        return {
            'error': f'Failed to load predictions: {str(e)}',
            'success': False
        }

    if not predictions:
        return {
            'error': 'No predictions found in file',
            'success': False
        }

    # Create temporary directory for evaluation
    temp_dir = Path(predictions_path).parent / 'eval_temp'
    temp_dir.mkdir(exist_ok=True)

    # Run SWE-bench evaluation
    try:
        # SWE-bench evaluation command
        cmd = [
            'python', '-m', 'swebench.harness.run_evaluation',
            '--predictions_path', predictions_path,
            '--swe_bench_tasks', 'princeton-nlp/SWE-bench_Lite',
            '--log_dir', str(temp_dir / 'logs'),
            '--testbed', str(temp_dir / 'testbed'),
            '--skip_existing', 'False',
            '--timeout', '900',  # 15 minutes per test
            '--num_workers', '1'  # Conservative for memory
        ]

        print(f"Running evaluation: {' '.join(cmd)}", file=sys.stderr)

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=3600  # 1 hour total timeout
        )

        if result.returncode != 0:
            return {
                'error': f'Evaluation failed: {result.stderr}',
                'success': False,
                'stdout': result.stdout,
                'stderr': result.stderr
            }

        # Parse evaluation results
        results_file = temp_dir / 'logs' / 'results.json'
        if not results_file.exists():
            # Try to find results in log directory
            log_files = list((temp_dir / 'logs').glob('**/*.json'))
            if log_files:
                results_file = log_files[0]
            else:
                return {
                    'error': 'Evaluation completed but no results file found',
                    'success': False,
                    'stdout': result.stdout
                }

        with open(results_file, 'r') as f:
            results = json.load(f)

        # Save results if output path specified
        if output_path:
            with open(output_path, 'w') as f:
                json.dump(results, f, indent=2)

        return {
            'success': True,
            'results': results,
            'predictions_count': len(predictions),
            'results_file': str(results_file)
        }

    except subprocess.TimeoutExpired:
        return {
            'error': 'Evaluation timeout (>1 hour)',
            'success': False
        }
    except Exception as e:
        return {
            'error': f'Evaluation error: {str(e)}',
            'success': False
        }

def evaluate_single_task(instance_id: str, patch: str, task_data: Dict[str, Any]) -> Dict[str, Any]:
    """
    Evaluate a single task prediction.

    Args:
        instance_id: Task instance ID
        patch: Generated patch
        task_data: Task metadata from SWE-bench dataset

    Returns:
        Evaluation result for this task
    """
    # This is a simplified single-task evaluator
    # For full evaluation, use run_evaluation()

    temp_dir = Path('/tmp') / f'swebench_{instance_id}'
    temp_dir.mkdir(exist_ok=True)

    # Write prediction to file
    prediction = {
        'instance_id': instance_id,
        'model_patch': patch,
        'model_name_or_path': 'claude-orchestrator'
    }

    pred_file = temp_dir / 'prediction.json'
    with open(pred_file, 'w') as f:
        json.dump([prediction], f)

    # Run evaluation
    return run_evaluation(str(pred_file))

def main():
    """Main entry point for CLI usage."""
    if len(sys.argv) < 2:
        print(json.dumps({
            'error': 'Usage: evaluate.py <predictions.json> [output.json]',
            'success': False
        }))
        sys.exit(1)

    predictions_path = sys.argv[1]
    output_path = sys.argv[2] if len(sys.argv) > 2 else None

    # Run evaluation
    result = run_evaluation(predictions_path, output_path)

    # Output as JSON to stdout
    print(json.dumps(result, indent=2))

    # Exit with error code if evaluation failed
    if not result.get('success', False):
        sys.exit(1)

if __name__ == '__main__':
    main()
