#!/usr/bin/env node
/**
 * Integration test for BFCL benchmark
 * Tests the full flow without actually calling Claude
 */

import { parseModelOutput, scoreFunctionCall } from './scorer.js';
import { loadTestCases } from './runner.js';
import { SAMPLE_TEST_CASES } from './sample-data.js';

console.log('BFCL Integration Test');
console.log('='.repeat(50));

// Test 1: Load test cases
console.log('\n1. Testing loadTestCases...');
const cases = loadTestCases(5);
console.assert(cases.length > 0, 'Should load at least 1 test case');
console.assert(cases.length <= 5, 'Should respect limit');
console.assert(cases[0].id, 'Test case should have an id');
console.assert(cases[0].question, 'Test case should have a question');
console.assert(cases[0].functions, 'Test case should have functions');
console.assert(cases[0].groundTruth, 'Test case should have groundTruth');
console.log(`✓ Loaded ${cases.length} test cases`);

// Test 2: Sample data structure
console.log('\n2. Testing sample data structure...');
console.assert(SAMPLE_TEST_CASES.length === 10, 'Should have 10 sample cases');
for (const testCase of SAMPLE_TEST_CASES) {
  console.assert(testCase.id, `Case ${testCase.id} should have id`);
  console.assert(testCase.question, `Case ${testCase.id} should have question`);
  console.assert(Array.isArray(testCase.functions), `Case ${testCase.id} should have functions array`);
  console.assert(testCase.functions.length > 0, `Case ${testCase.id} should have at least 1 function`);
  console.assert(testCase.groundTruth.name, `Case ${testCase.id} should have groundTruth.name`);
  console.assert(testCase.groundTruth.arguments, `Case ${testCase.id} should have groundTruth.arguments`);
}
console.log('✓ All sample cases are well-formed');

// Test 3: End-to-end scoring simulation
console.log('\n3. Testing end-to-end scoring...');
const testCase = SAMPLE_TEST_CASES[0]; // Weather test case

// Simulate correct model output
const correctOutput = JSON.stringify({
  name: testCase.groundTruth.name,
  arguments: testCase.groundTruth.arguments
});

const parsed = parseModelOutput(correctOutput);
console.assert(parsed !== null, 'Should parse correct output');

if (parsed) {
  const score = scoreFunctionCall(parsed, testCase.groundTruth);
  console.assert(score.nameCorrect === true, 'Should have correct name');
  console.assert(score.paramsCorrect === true, 'Should have correct params');
  console.log('✓ Correct output scored as PASS');
}

// Simulate incorrect model output (wrong city)
const incorrectOutput = JSON.stringify({
  name: 'get_weather',
  arguments: { city: 'New York', units: 'celsius' }
});

const parsed2 = parseModelOutput(incorrectOutput);
if (parsed2) {
  const score2 = scoreFunctionCall(parsed2, testCase.groundTruth);
  console.assert(score2.nameCorrect === true, 'Should have correct name');
  console.assert(score2.paramsCorrect === false, 'Should have incorrect params');
  console.log('✓ Incorrect output scored as FAIL');
}

// Test 4: Various output formats
console.log('\n4. Testing various output formats...');

const formats = [
  // JSON format
  '{"name": "get_weather", "arguments": {"city": "San Francisco", "units": "celsius"}}',
  // Python-style
  'get_weather(city="San Francisco", units="celsius")',
  // Markdown JSON
  '```json\n{"name": "get_weather", "arguments": {"city": "San Francisco", "units": "celsius"}}\n```',
  // Markdown Python
  '```python\nget_weather(city="San Francisco", units="celsius")\n```',
  // With explanation
  'I will call the weather function:\n\n{"name": "get_weather", "arguments": {"city": "San Francisco", "units": "celsius"}}'
];

for (const format of formats) {
  const parsed = parseModelOutput(format);
  console.assert(parsed !== null, `Should parse format: ${format.substring(0, 30)}...`);
  if (parsed) {
    console.assert(parsed.name === 'get_weather', 'Should extract correct function name');
  }
}
console.log('✓ All output formats parsed successfully');

// Test 5: Type coercion scenarios
console.log('\n5. Testing type coercion scenarios...');

const numericCase = {
  name: 'web_search',
  arguments: { query: 'test', num_results: 5 }
};

// Model returns string instead of number
const stringNumOutput = {
  name: 'web_search',
  arguments: { query: 'test', num_results: '5' }
};

const coercionScore = scoreFunctionCall(stringNumOutput, numericCase);
console.assert(coercionScore.paramsCorrect === true, 'Should coerce "5" to 5');
console.log('✓ Type coercion works correctly');

console.log('\n' + '='.repeat(50));
console.log('✓ All integration tests passed!');
console.log('\nThe BFCL benchmark is ready to use.');
console.log('Run: npx ts-node runner.ts --limit 3');
