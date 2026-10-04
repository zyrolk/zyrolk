import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import type { PublicProductReader } from '../functions/src/api/products/publicProductMetadata';

const functionsSourceRoot = path.resolve('functions/src') + path.sep;
const functionsRequire = createRequire(path.resolve('functions/package.json'));
const typescript = functionsRequire('typescript') as typeof import('typescript');
const moduleExtensions = (Module as unknown as { _extensions: Record<string, (module: { _compile(code: string, filename: string): void }, filename: string) => void> })._extensions;
const originalTypeScriptLoader = moduleExtensions['.ts'];
moduleExtensions['.ts'] = function loadFunctionsSource(module, filename) {
  if (!filename.startsWith(functionsSourceRoot)) return originalTypeScriptLoader.call(this, module, filename);
  const { outputText } = typescript.transpileModule(readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022 },
  });
  module._compile(outputText, filename);
};

const metadata = functionsRequire('./src/api/products/publicProductMetadata.ts') as typeof import('../functions/src/api/products/publicProductMetadata');

const shell = `<!doctype html><html><head>
<title>Zyro.lk — Shop Online in Sri Lanka</title>
<meta name="description" content="Generic Zyro description">
<link rel="canonical" href="https://zyro.lk/">
<meta property="og:type" content="website">
<meta property="og:title" content="Zyro.lk — Shop Online in Sri Lanka">
<meta property="og:description" content="Generic Zyro description">
<meta property="og:image" content="https://zyro.lk/logo.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Zyro.lk — Shop Online in Sri Lanka">
<script type="application/ld+json">{"@type":"Organization","name":"Zyro.lk"}</script>
<script type="module" src="/assets/index-abc.js"></script>
</head><body><div id="root"></div></body></html>`;

const record = (overrides: Record<string, unknown> = {}) => ({
  isActive: true,
  name: 'Safe <Product> & "special"',
  shortDescription: 'A <strong>useful</strong> product with </script> text.',
  imageUrl: 'https://firebasestorage.googleapis.com/v0/b/zyrolk-e0164.firebasestorage.app/o/products%2Fsafe.webp?alt=media',
  price: 2850,
  stock: 3,
  category: 'Home & Garden',
  brand: 'Zyro Brand',
  costPrice: 12,
  supplierMetadata: { secret: 'do-not-leak' },
  localDemand: 99,
  ...overrides,
});

const fakeDb = (records: Record<string, Record<string, unknown>>, failure?: Error): PublicProductReader => ({
  collection: (name) => {
    assert.equal(name, 'products');
    return { doc: (id) => ({
      get: async () => {
        if (failure) throw failure;
        const value = records[id];
        return { exists: Boolean(value), data: () => value };
      },
    }) };
  },
});

const fakeFetch = async (): Promise<Response> => new Response(shell, { status: 200, headers: { 'content-type': 'text/html' } });

interface FakeResponse {
  statusCode?: number;
  headers: Record<string, string>;
  body?: string;
  set: (name: string, value: string) => FakeResponse;
  status: (code: number) => FakeResponse;
  send: (body: string) => FakeResponse;
}

type PublicMetadataHandler = ReturnType<typeof import('../functions/src/api/products/publicProductMetadata').createPublicProductMetadataHandler>;

const invoke = async (handler: PublicMetadataHandler, rawId: string): Promise<FakeResponse> => {
  const response: FakeResponse = {
    headers: {},
    set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
  };
  await handler({ params: { documentId: rawId } } as never, response as never, (() => undefined) as never);
  return response;
};

test('valid products render escaped product metadata, JSON-LD, and the current SPA shell', async () => {
  const product = metadata.projectPublicProductMetadata('safe-id', record());
  assert.ok(product);
  const output = metadata.renderProductMetadataIntoShell(shell, product);
  assert.match(output, /<title>Safe &amp; &quot;special&quot; \| Zyro\.lk<\/title>/);
  assert.match(output, /<link rel="canonical" href="https:\/\/zyro\.lk\/products\/safe-id">/);
  assert.match(output, /property="og:type" content="product"/);
  assert.match(output, /property="og:image" content="https:\/\/firebasestorage/);
  assert.match(output, /name="twitter:card" content="summary_large_image"/);
  assert.match(output, /product:price:currency" content="LKR"/);
  assert.match(output, /id="zyro-server-product-structured-data"/);
  assert.match(output, /<script type="module" src="\/assets\/index-abc\.js"><\/script>/);
  assert.doesNotMatch(output, /do-not-leak|supplierMetadata|localDemand|costPrice/);
  assert.doesNotMatch(output, /<\/script> text/);
});

test('two products produce distinct truthful titles, canonical URLs, and images', () => {
  const first = metadata.projectPublicProductMetadata('first', record({ name: 'First Product', imageUrl: 'https://example.com/first.webp' }));
  const second = metadata.projectPublicProductMetadata('second', record({ name: 'Second Product', imageUrl: 'https://example.com/second.webp' }));
  assert.ok(first && second);
  const firstHtml = metadata.renderProductMetadataIntoShell(shell, first);
  const secondHtml = metadata.renderProductMetadataIntoShell(shell, second);
  assert.match(firstHtml, /First Product \| Zyro\.lk/);
  assert.match(secondHtml, /Second Product \| Zyro\.lk/);
  assert.match(firstHtml, /products\/first/);
  assert.match(secondHtml, /products\/second/);
  assert.match(firstHtml, /first\.webp/);
  assert.match(secondHtml, /second\.webp/);
});

test('inactive, missing, malformed, and unavailable products render noindex shells without product metadata', () => {
  const missing = metadata.renderNoIndexShell(shell, 'https://zyro.lk/products/missing');
  assert.match(missing, /name="robots" content="noindex, nofollow"/);
  assert.doesNotMatch(missing, /og:type" content="product"|zyro-server-product-structured-data|product:price/);
  assert.equal(metadata.projectPublicProductMetadata('inactive', record({ isActive: false })), null);
  assert.equal(metadata.validatePublicProductId('%E0%A4%A'), null);
  assert.equal(metadata.validatePublicProductId('../private'), null);
  assert.equal(metadata.validatePublicProductId('a/b'), null);
  assert.equal(metadata.validatePublicProductId('safe-id'), 'safe-id');
});

test('missing image and description remain truthful and safe', () => {
  const product = metadata.projectPublicProductMetadata('fallback', record({ imageUrl: 'not-a-url', imageUrls: ['http://insecure.example/a.webp'], shortDescription: '', description: '' }));
  assert.ok(product);
  assert.equal(product.imageUrl, undefined);
  assert.equal(product.description, 'Shop Safe & "special" on Zyro.lk.');
  const output = metadata.renderProductMetadataIntoShell(shell, product);
  assert.doesNotMatch(output, /property="og:image"|name="twitter:image"/);
  assert.match(output, /Shop Safe &amp; &quot;special&quot;/);
});

test('public handler returns valid, invalid, and Firestore-failure responses with safe cache behavior', async () => {
  const validHandler = metadata.createPublicProductMetadataHandler({
    db: fakeDb({ 'valid-id': record({ name: 'Valid Product' }) }),
    fetchImpl: fakeFetch,
  });
  const valid = await invoke(validHandler, 'valid-id');
  assert.equal(valid.statusCode, 200);
  assert.equal(valid.headers['cache-control'], metadata.PUBLIC_PRODUCT_METADATA_CACHE_CONTROL);
  assert.match(valid.body || '', /Valid Product \| Zyro\.lk/);

  const invalidHandler = metadata.createPublicProductMetadataHandler({
    db: fakeDb({}),
    fetchImpl: fakeFetch,
  });
  const invalid = await invoke(invalidHandler, 'unknown-id');
  assert.equal(invalid.statusCode, 404);
  assert.equal(invalid.headers['cache-control'], metadata.PRIVATE_PRODUCT_METADATA_CACHE_CONTROL);
  assert.match(invalid.body || '', /noindex, nofollow/);
  assert.doesNotMatch(invalid.body || '', /og:type" content="product"|product:price/);

  const failedHandler = metadata.createPublicProductMetadataHandler({
    db: fakeDb({}, new Error('Firestore unavailable')),
    fetchImpl: fakeFetch,
  });
  const failed = await invoke(failedHandler, 'valid-id');
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.headers['cache-control'], metadata.PRIVATE_PRODUCT_METADATA_CACHE_CONTROL);
  assert.match(failed.body || '', /noindex, nofollow/);
});

test('public App Check exception and Hosting rewrite are exact and existing routes remain present', () => {
  const app = readFileSync('functions/src/api/app.ts', 'utf8');
  const hosting = readFileSync('firebase.json', 'utf8');
  assert.equal(metadata.isPublicProductMetadataRequest('GET', '/products/valid-id'), true);
  assert.equal(metadata.isPublicProductMetadataRequest('POST', '/products/valid-id'), false);
  assert.equal(metadata.isPublicProductMetadataRequest('GET', '/products/valid-id/extra'), false);
  assert.match(app, /isPublicProductMetadataRequest\(req\.method, req\.path\)/);
  assert.match(app, /app\.get\("\/products\/:documentId"/);
  assert.match(hosting, /"source": "\/sitemap\.xml"[\s\S]*"function": "api"/);
  assert.match(hosting, /"source": "\/api\/\*\*"[\s\S]*"function": "api"/);
  assert.match(hosting, /"source": "\/products\/\*"[\s\S]*"function": "api"/);
  assert.match(hosting, /"source": "\/products\/\*"[\s\S]*"source": "\*\*"[\s\S]*"destination": "\/index\.html"/);
});
