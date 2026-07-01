import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeqTracker } from '../common.js';

test('SeqTracker counts received, detects gaps and duplicates', () => {
  const t = new SeqTracker();
  t.record(1);
  t.record(2);
  t.record(2);   // duplicate
  t.record(4);   // gap: 3 missing
  const s = t.summary();
  assert.equal(s.received, 4);
  assert.equal(s.unique, 3);
  assert.equal(s.duplicates, 1);
  assert.deepEqual(s.missing, [3]);
  assert.equal(s.highestSeq, 4);
});

test('SeqTracker with no messages is empty', () => {
  const s = new SeqTracker().summary();
  assert.equal(s.received, 0);
  assert.equal(s.unique, 0);
  assert.equal(s.duplicates, 0);
  assert.deepEqual(s.missing, []);
  assert.equal(s.highestSeq, 0);
});
