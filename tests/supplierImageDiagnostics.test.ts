import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createSupplierImageFailureReporter,
  SupplierImageFailureDetails,
} from '../src/services/supplierImageDiagnostics';

const imageTarget = (url = 'https://ayp.lk/storage/products/a2z/7295.jpg') => ({
  currentSrc: url,
  complete: true,
  naturalWidth: 0,
  naturalHeight: 0,
  getAttribute: (name: string) => name === 'src' ? url : null,
});

test('supplier image diagnostics produce no production log output', () => {
  const messages: Array<{ message: string; details: SupplierImageFailureDetails }> = [];
  const report = createSupplierImageFailureReporter();

  report(imageTarget(), {
    nodeEnvironment: 'production',
    log: (message, details) => messages.push({ message, details }),
  });

  assert.equal(messages.length, 0);
});

test('supplier image diagnostics log each failed URL once during development', () => {
  const messages: Array<{ message: string; details: SupplierImageFailureDetails }> = [];
  const report = createSupplierImageFailureReporter();
  const context = {
    nodeEnvironment: 'development',
    online: true,
    pageUrl: 'http://localhost:3000/',
    timestamp: '2026-07-23T00:00:00.000Z',
    log: (message: string, details: SupplierImageFailureDetails) => messages.push({ message, details }),
  };

  report(imageTarget(), context);
  report(imageTarget(), context);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].message, 'Image failed to load');
  assert.deepEqual(messages[0].details, {
    currentSrc: 'https://ayp.lk/storage/products/a2z/7295.jpg',
    src: 'https://ayp.lk/storage/products/a2z/7295.jpg',
    complete: true,
    naturalWidth: 0,
    naturalHeight: 0,
    'navigator.onLine': true,
    'location.href': 'http://localhost:3000/',
    timestamp: '2026-07-23T00:00:00.000Z',
  });
});

test('Supplier Hub preserves the No image fallback after reporting a load failure', () => {
  const source = readFileSync('src/components/SupplierHubFiveStars.tsx', 'utf8');

  assert.match(source, /if \(!isValidSupplierImageUrl\(src\) \|\| failed\)[\s\S]*?No image/);
  assert.match(source, /onError=\{\(event\) => \{[\s\S]*?reportSupplierImageFailure\(event\.currentTarget\);[\s\S]*?setFailed\(true\);/);
});
