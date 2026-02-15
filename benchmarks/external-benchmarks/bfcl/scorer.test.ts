/**
 * Test suite for BFCL scorer
 */

import { parseModelOutput, scoreFunctionCall, deepParamEquals } from './scorer.js';
import type { BFCLFunctionCall } from './types.js';

// Test parseModelOutput
console.log('Testing parseModelOutput...');

// Test 1: JSON format
const json1 = '{"name": "get_weather", "arguments": {"city": "San Francisco", "units": "celsius"}}';
const parsed1 = parseModelOutput(json1);
console.assert(parsed1?.name === 'get_weather', 'JSON: name should be get_weather');
console.assert(parsed1?.arguments['city'] === 'San Francisco', 'JSON: city should be San Francisco');
console.log('✓ JSON format parsing works');

// Test 2: Python-style format
const python1 = 'get_weather(city="San Francisco", units="celsius")';
const parsed2 = parseModelOutput(python1);
console.assert(parsed2?.name === 'get_weather', 'Python: name should be get_weather');
console.assert(parsed2?.arguments['city'] === 'San Francisco', 'Python: city should be San Francisco');
console.log('✓ Python-style format parsing works');

// Test 3: Markdown code block
const markdown1 = '```json\n{"name": "calculate", "arguments": {"expression": "(15 + 23) * 4"}}\n```';
const parsed3 = parseModelOutput(markdown1);
console.assert(parsed3?.name === 'calculate', 'Markdown: name should be calculate');
console.log('✓ Markdown code block parsing works');

// Test scoreFunctionCall
console.log('\nTesting scoreFunctionCall...');

const groundTruth: BFCLFunctionCall = {
  name: 'get_weather',
  arguments: { city: 'San Francisco', units: 'celsius' }
};

// Test 4: Exact match
const predicted1: BFCLFunctionCall = {
  name: 'get_weather',
  arguments: { city: 'San Francisco', units: 'celsius' }
};
const score1 = scoreFunctionCall(predicted1, groundTruth);
console.assert(score1.nameCorrect === true, 'Exact match: name should be correct');
console.assert(score1.paramsCorrect === true, 'Exact match: params should be correct');
console.log('✓ Exact match scoring works');

// Test 5: Wrong function name
const predicted2: BFCLFunctionCall = {
  name: 'get_temperature',
  arguments: { city: 'San Francisco', units: 'celsius' }
};
const score2 = scoreFunctionCall(predicted2, groundTruth);
console.assert(score2.nameCorrect === false, 'Wrong name: name should be incorrect');
console.assert(score2.paramsCorrect === true, 'Wrong name: params can still be correct');
console.log('✓ Wrong function name detection works');

// Test 6: Wrong parameters
const predicted3: BFCLFunctionCall = {
  name: 'get_weather',
  arguments: { city: 'New York', units: 'celsius' }
};
const score3 = scoreFunctionCall(predicted3, groundTruth);
console.assert(score3.nameCorrect === true, 'Wrong params: name should be correct');
console.assert(score3.paramsCorrect === false, 'Wrong params: params should be incorrect');
console.log('✓ Wrong parameters detection works');

// Test deepParamEquals
console.log('\nTesting deepParamEquals...');

// Test 7: Number-string coercion
console.assert(deepParamEquals(42, '42') === true, 'Should coerce number to string');
console.assert(deepParamEquals('42', 42) === true, 'Should coerce string to number');
console.log('✓ Number-string coercion works');

// Test 8: Boolean-string coercion
console.assert(deepParamEquals(true, 'true') === true, 'Should coerce boolean to string');
console.assert(deepParamEquals('false', false) === true, 'Should coerce string to boolean');
console.log('✓ Boolean-string coercion works');

// Test 9: Nested objects
const obj1 = { a: 1, b: { c: 2, d: 3 } };
const obj2 = { a: 1, b: { c: 2, d: 3 } };
const obj3 = { a: 1, b: { c: 2, d: 4 } };
console.assert(deepParamEquals(obj1, obj2) === true, 'Nested objects: should match');
console.assert(deepParamEquals(obj1, obj3) === false, 'Nested objects: should not match');
console.log('✓ Nested object comparison works');

// Test 10: Arrays
const arr1 = [1, 2, 3];
const arr2 = [1, 2, 3];
const arr3 = [1, 2, 4];
console.assert(deepParamEquals(arr1, arr2) === true, 'Arrays: should match');
console.assert(deepParamEquals(arr1, arr3) === false, 'Arrays: should not match');
console.log('✓ Array comparison works');

console.log('\n✓ All tests passed!');
