#!/usr/bin/env node
/**
 * Example usage of BFCL benchmark components
 *
 * This demonstrates how to use the scorer independently
 * without running the full benchmark.
 */

import { parseModelOutput, scoreFunctionCall } from './scorer.js';
import { SAMPLE_TEST_CASES } from './sample-data.js';
import type { BFCLFunctionCall } from './types.js';

console.log('BFCL Scorer Example Usage\n');

// Example 1: Parse and score a correct function call
console.log('Example 1: Correct function call');
console.log('='.repeat(50));

const testCase = SAMPLE_TEST_CASES[0]; // Weather test
console.log(`Question: ${testCase.question}`);
console.log(`Expected: ${testCase.groundTruth.name}(${JSON.stringify(testCase.groundTruth.arguments)})`);

const correctOutput = `
I'll call the weather function to get the temperature in San Francisco.

\`\`\`json
{
  "name": "get_weather",
  "arguments": {
    "city": "San Francisco",
    "units": "celsius"
  }
}
\`\`\`
`;

console.log(`\nModel output:\n${correctOutput}`);

const parsed = parseModelOutput(correctOutput);
console.log(`\nParsed: ${parsed?.name}(${JSON.stringify(parsed?.arguments)})`);

if (parsed) {
  const score = scoreFunctionCall(parsed, testCase.groundTruth);
  console.log(`\nScore:`);
  console.log(`  Function name correct: ${score.nameCorrect ? '✓' : '✗'}`);
  console.log(`  Parameters correct: ${score.paramsCorrect ? '✓' : '✗'}`);
  console.log(`  Overall: ${score.nameCorrect && score.paramsCorrect ? 'PASS ✓' : 'FAIL ✗'}`);
}

// Example 2: Parse and score an incorrect function call
console.log('\n\nExample 2: Incorrect function call (wrong city)');
console.log('='.repeat(50));

const incorrectOutput = 'get_weather(city="New York", units="celsius")';
console.log(`Model output: ${incorrectOutput}`);

const parsed2 = parseModelOutput(incorrectOutput);
console.log(`Parsed: ${parsed2?.name}(${JSON.stringify(parsed2?.arguments)})`);

if (parsed2) {
  const score2 = scoreFunctionCall(parsed2, testCase.groundTruth);
  console.log(`\nScore:`);
  console.log(`  Function name correct: ${score2.nameCorrect ? '✓' : '✗'}`);
  console.log(`  Parameters correct: ${score2.paramsCorrect ? '✓' : '✗'}`);
  console.log(`  Overall: ${score2.nameCorrect && score2.paramsCorrect ? 'PASS ✓' : 'FAIL ✗'}`);
}

// Example 3: Test type coercion
console.log('\n\nExample 3: Type coercion (string vs number)');
console.log('='.repeat(50));

const searchCase = SAMPLE_TEST_CASES[1]; // Web search test
console.log(`Question: ${searchCase.question}`);
console.log(`Expected num_results: ${searchCase.groundTruth.arguments['num_results']} (number)`);

// Model returns string instead of number
const coercionOutput: BFCLFunctionCall = {
  name: 'web_search',
  arguments: {
    query: 'best restaurants in Tokyo',
    num_results: '5' // String instead of number
  }
};

console.log(`Model returned: ${JSON.stringify(coercionOutput)}`);
console.log(`  (num_results is a string "5" instead of number 5)`);

const score3 = scoreFunctionCall(coercionOutput, searchCase.groundTruth);
console.log(`\nScore:`);
console.log(`  Function name correct: ${score3.nameCorrect ? '✓' : '✗'}`);
console.log(`  Parameters correct: ${score3.paramsCorrect ? '✓' : '✗'} (with type coercion)`);
console.log(`  Overall: ${score3.nameCorrect && score3.paramsCorrect ? 'PASS ✓' : 'FAIL ✗'}`);

// Example 4: Available test cases
console.log('\n\nExample 4: Available built-in test cases');
console.log('='.repeat(50));
console.log(`Total cases: ${SAMPLE_TEST_CASES.length}\n`);

for (const tc of SAMPLE_TEST_CASES) {
  console.log(`${tc.id.padEnd(15)} - ${tc.question.substring(0, 60)}...`);
}

console.log('\n' + '='.repeat(50));
console.log('To run the full benchmark: npm run bench:quick');
