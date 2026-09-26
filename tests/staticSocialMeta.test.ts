import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync('index.html', 'utf8');

const metaContent = (attribute: 'name' | 'property', key: string): string | undefined => {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return html.match(new RegExp(`<meta\\s+${attribute}="${escaped}"\\s+content="([^"]*)"`, 'u'))?.[1];
};

test('static social titles match the document title', () => {
  const title = html.match(/<title>([^<]*)<\/title>/u)?.[1];
  assert.equal(title, 'Zyro.lk — Shop Online in Sri Lanka');
  assert.equal(metaContent('property', 'og:title'), title);
  assert.equal(metaContent('name', 'twitter:title'), title);
});

test('static social descriptions match the meta description', () => {
  const description = metaContent('name', 'description');
  assert.equal(description, 'Discover everyday products across electronics, automotive, home, fashion and more at Zyro.lk.');
  assert.equal(metaContent('property', 'og:description'), description);
  assert.equal(metaContent('name', 'twitter:description'), description);
});

test('older generic social copy is gone', () => {
  assert.doesNotMatch(html, /A Trusted Sri Lankan Marketplace/u);
  assert.doesNotMatch(html, /Explore live products across every available category/u);
});

test('social image and card metadata stay unchanged', () => {
  assert.equal(metaContent('property', 'og:image'), 'https://zyro.lk/logo.png');
  assert.equal(metaContent('property', 'og:image:alt'), 'Zyro.lk marketplace');
  assert.equal(metaContent('name', 'twitter:image'), 'https://zyro.lk/logo.png');
  assert.equal(metaContent('name', 'twitter:image:alt'), 'Zyro.lk marketplace');
  assert.equal(metaContent('name', 'twitter:card'), 'summary_large_image');
  assert.equal(metaContent('property', 'og:url'), 'https://zyro.lk/');
  assert.match(html, /<link rel="canonical" href="https:\/\/zyro\.lk\/" \/>/u);
});
