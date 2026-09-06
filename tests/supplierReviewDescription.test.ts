import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  sanitizeSupplierDescriptionHtml,
  supplierDescriptionLooksLikeHtml,
  supplierDescriptionPlainText,
} from '../src/services/supplierReviewDescription';

const productDetail = readFileSync(new URL('../src/components/ProductDetailModal.tsx', import.meta.url), 'utf8');

test('safe supplier HTML keeps formatting without exposing literal markup', () => {
  const safe = sanitizeSupplierDescriptionHtml('<h4>Rose Gold Watch</h4><p><strong>Elegant</strong> everyday style.</p>');
  assert.equal(safe, '<h4>Rose Gold Watch</h4><p><strong>Elegant</strong> everyday style.</p>');
  assert.doesNotMatch(safe, /&lt;h4&gt;|&lt;\/h4&gt;/u);
  assert.match(productDetail, /dangerouslySetInnerHTML=\{\{ __html: safeProductDescriptionHtml \}\}/u);
});

test('plain-text descriptions remain readable and are not treated as HTML', () => {
  const plain = 'A comfortable watch with a rose-gold finish.\nFast delivery available.';
  assert.equal(supplierDescriptionLooksLikeHtml(plain), false);
  assert.equal(supplierDescriptionPlainText(plain), plain);
  assert.match(productDetail, /\{productDescription\}/u);
});

test('scripts, event handlers, unsafe URLs, styles, and executable markup are removed', () => {
  const unsafe = sanitizeSupplierDescriptionHtml(
    '<p onclick="alert(1)" style="color:red">Safe</p>'
    + '<script>alert(document.cookie)</script>'
    + '<img src="x" onerror="alert(2)">'
    + '<iframe src="https://evil.example"></iframe>'
    + '<a href="javascript:alert(3)">click</a>',
  );
  assert.equal(unsafe, '<p>Safe</p>click');
  assert.doesNotMatch(unsafe, /script|onclick|onerror|iframe|javascript:|style=|<img|<a/iu);
});

test('paragraphs, headings, lists, emphasis, and line breaks are preserved', () => {
  const formatted = sanitizeSupplierDescriptionHtml(
    '<h4>Features</h4><ul><li><b>Lightweight</b></li><li><em>Durable</em></li></ul><p>Ready<br>to ship.</p>',
  );
  assert.equal(
    formatted,
    '<h4>Features</h4><ul><li><b>Lightweight</b></li><li><em>Durable</em></li></ul><p>Ready<br>to ship.</p>',
  );
});
