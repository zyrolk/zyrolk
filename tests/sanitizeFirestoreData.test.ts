import assert from 'node:assert/strict';
import test from 'node:test';
import { sanitizeFirestoreData } from '../src/services/firestore/sanitizeFirestoreData';

test('Firestore payload sanitization removes nested undefined values without mutating input', () => {
  const source = { name: 'Product', optional: undefined, specs: { Brand: 'Zyro', empty: undefined }, images: ['/a.jpg', undefined] };
  const result = sanitizeFirestoreData(source);
  assert.deepEqual(result, { name: 'Product', specs: { Brand: 'Zyro' }, images: ['/a.jpg'] });
  assert.equal(Object.hasOwn(source, 'optional'), true);
  assert.equal(Object.hasOwn(source.specs, 'empty'), true);
});
