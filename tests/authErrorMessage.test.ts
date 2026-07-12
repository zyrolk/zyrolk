import assert from 'node:assert/strict';
import test from 'node:test';
import { getAuthErrorMessage } from '../src/features/auth/authErrorMessage';

test('authentication errors are projected to customer-safe messages', () => {
  assert.equal(getAuthErrorMessage({ code: 'auth/invalid-credential' }), 'Incorrect email or password.');
  assert.equal(getAuthErrorMessage({ code: 'auth/email-already-in-use' }), 'Email already exists.');
  assert.equal(getAuthErrorMessage({ code: 'auth/network-request-failed' }), 'Network error. Please try again.');
});

test('unknown authentication errors never expose provider details', () => {
  assert.equal(
    getAuthErrorMessage({ code: 'auth/internal-error', message: 'Firebase: Error (auth/internal-error).' }),
    'Unexpected error. Please try again later.',
  );
  assert.equal(getAuthErrorMessage(new Error('Firebase: Error (auth/unknown).')), 'Unexpected error. Please try again later.');
});
