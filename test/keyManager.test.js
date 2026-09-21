import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseApiKeys,
  maskKey,
  isKeyExhaustionError,
  getCandidateKeys,
  markKeyExhausted,
  markKeySuccess,
  resetKeyState,
} = await import('../src/lib/keyManager.js');

// exhaustedKeys/activeKeyIndices are module-level state shared by every
// test in this file, so each test resets it first rather than relying on
// test order or on keys never colliding across tests.

test('parseApiKeys splits comma-separated keys and trims whitespace', () => {
  assert.deepEqual(parseApiKeys('key1, key2 ,key3'), ['key1', 'key2', 'key3']);
});

test('parseApiKeys drops blanks and handles a single key with no comma', () => {
  assert.deepEqual(parseApiKeys('only-one-key'), ['only-one-key']);
  assert.deepEqual(parseApiKeys('key1,,key2,'), ['key1', 'key2']);
});

test('parseApiKeys returns [] for nullish/empty input', () => {
  assert.deepEqual(parseApiKeys(undefined), []);
  assert.deepEqual(parseApiKeys(''), []);
});

test('maskKey shows a short prefix/suffix for a real key and hides short strings entirely', () => {
  assert.equal(maskKey('AIzaSyABCDEFGHIJKLMNOP1234'), 'AIza...1234');
  assert.equal(maskKey('short'), '****');
  assert.equal(maskKey(undefined), 'none');
});

test('isKeyExhaustionError recognizes 429, RESOURCE_EXHAUSTED, UNAUTHENTICATED, and quota/invalid-key text', () => {
  assert.equal(isKeyExhaustionError(429, undefined, ''), true);
  assert.equal(isKeyExhaustionError(400, { status: 'RESOURCE_EXHAUSTED' }, ''), true);
  assert.equal(isKeyExhaustionError(400, { status: 'UNAUTHENTICATED' }, ''), true);
  assert.equal(isKeyExhaustionError(400, undefined, 'API key not valid'), true);
  assert.equal(isKeyExhaustionError(403, undefined, 'project has been suspended'), true);
});

test('isKeyExhaustionError returns false for an unrelated 400', () => {
  resetKeyState();
  assert.equal(isKeyExhaustionError(400, { status: 'INVALID_ARGUMENT' }, 'malformed request'), false);
});

test('getCandidateKeys with no exhaustion returns keys starting from the default (0) active index', () => {
  resetKeyState();
  assert.deepEqual(getCandidateKeys(['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('getCandidateKeys puts an exhausted key at the back, behind still-available keys', () => {
  resetKeyState();
  const keys = ['a', 'b', 'c'];
  markKeyExhausted('a', 60_000, 'quota', keys);

  // markKeyExhausted also advances the sticky active index past 'a', so
  // rotation now starts at 'b'.
  assert.deepEqual(getCandidateKeys(keys), ['b', 'c', 'a']);
});

test('markKeySuccess locks the active index onto that key for future requests', () => {
  resetKeyState();
  const keys = ['a', 'b', 'c'];
  markKeySuccess('c', keys);

  assert.deepEqual(getCandidateKeys(keys), ['c', 'a', 'b']);
});

test('markKeySuccess clears a previous exhaustion record for that key', () => {
  resetKeyState();
  const keys = ['a', 'b'];
  markKeyExhausted('a', 60_000, 'quota', keys);
  markKeySuccess('a', keys);

  // 'a' is available again, so a fresh rotation starting from it should
  // list it first rather than pushed to the back as cooling down.
  assert.deepEqual(getCandidateKeys(keys), ['a', 'b']);
});

test('a single-key list is returned as-is regardless of exhaustion state', () => {
  resetKeyState();
  assert.deepEqual(getCandidateKeys(['only-key']), ['only-key']);
});

test('getCandidateKeys returns [] for an empty or non-array input', () => {
  resetKeyState();
  assert.deepEqual(getCandidateKeys([]), []);
  assert.deepEqual(getCandidateKeys(undefined), []);
});
