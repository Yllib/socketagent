import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStoredData } from '#server/stored-data';

test('stored contracts preserve legacy optional fields and unknown future fields', () => {
  const memory = { settings: { recentRuns: 2 }, futureField: { enabled: true } };
  assert.deepEqual(parseStoredData('sessionMemory', memory), memory);
  const header = { jobId: 'transfer', type: 'ack', offset: 524288, futureField: true };
  assert.deepEqual(parseStoredData('transferHeader', header), header);
});

test('stored contracts reject invalid nested values without including their contents', () => {
  assert.throws(() => parseStoredData('sessionMemory', {
    settings: { recentRuns: 'private-value' },
  }), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /settings\/recentRuns/);
    assert.doesNotMatch(error.message, /private-value/);
    return true;
  });
  assert.throws(() => parseStoredData('transferHeader', {
    jobId: 'transfer', type: 'result', result: {
      sourceSessionId: 'source', exactNativeResume: false, session: { id: 'incomplete' },
    },
  }), /Invalid transferHeader/);
  assert.throws(() => parseStoredData('workReviewDeliveries', {
    schemaVersion: 1, records: [{ resultId: 123 }],
  }), /Invalid workReviewDeliveries/);
});
