/**
 * Main test suite entry point
 * 
 * Run all tests: npm test
 * Run specific file: npx vitest tests/pii-detector.test.ts
 * Run in watch mode: npm test -- --watch
 */

import { describe } from 'vitest';

describe('Test Suite', () => {
  it('should run all tests', () => {
    expect(true).toBe(true);
  });
});
