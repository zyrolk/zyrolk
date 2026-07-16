import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync('src/App.tsx', 'utf8');
const styles = readFileSync('src/index.css', 'utf8');
const categoriesPage = app.slice(
  app.indexOf("currentPage === 'categories'"),
  app.indexOf('{/* PAGE 4: WISHLIST */}'),
);

test('Categories keeps the existing live-category filtering and selection behavior', () => {
  assert.match(app, /const storefrontCategories = useMemo\([\s\S]*categoryCounts\[category\.id\][\s\S]*> 0/);
  assert.match(categoriesPage, /storefrontCategories\.map/);
  assert.match(categoriesPage, /categoryCounts\[cat\.id\] \|\| 0/);
  assert.match(categoriesPage, /categoryMatches\(product\.category, cat\.id\)/);
  assert.match(categoriesPage, /setSelectedCategory\(cat\.id\);\s*setCurrentPage\('products'\);/);
});

test('Categories renders premium cards with honest image fallbacks and live counts', () => {
  assert.match(categoriesPage, /zy-category-collection-card/);
  assert.match(categoriesPage, /cat\.imageUrl\?\.trim\(\) \|\| activeProducts\.find/);
  assert.match(categoriesPage, /Collection image coming soon/);
  assert.match(categoriesPage, /Explore live products selected for this marketplace collection\./);
  assert.match(categoriesPage, /Explore Collection/);
  assert.match(categoriesPage, /itemsCount === 1 \? 'product' : 'products'/);
  assert.doesNotMatch(categoriesPage, /unsplash|placeholder product|demo product/iu);
});

test('Categories exposes loading and compact empty states without zero-product cards', () => {
  assert.match(app, /const isCategoriesPageLoading = loading/);
  assert.match(categoriesPage, /aria-label="Loading shopping collections" aria-busy="true"/);
  assert.match(categoriesPage, /zy-category-skeleton/);
  assert.match(categoriesPage, /Collections are being refreshed/);
  assert.match(categoriesPage, /setCurrentPage\('products'\); setSelectedCategory\('all'\);/);
  assert.doesNotMatch(categoriesPage, /0 Products/);
});

test('Categories presentation includes responsive grid, mobile snap scrolling, and accessible interactions', () => {
  assert.match(categoriesPage, /aria-labelledby="categories-page-title"/);
  assert.match(categoriesPage, /role="list" aria-label="Shopping collections"/);
  assert.match(categoriesPage, /aria-label=\{`Explore \$\{cat\.name\}, \$\{itemsCount\}/);
  assert.match(styles, /\.zy-categories-grid\s*\{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(min-width: 1200px\)[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*overflow-x: auto[\s\S]*scroll-snap-type: x mandatory/);
  assert.match(styles, /scroll-snap-align: start/);
  assert.match(styles, /scroll-snap-stop: always/);
  assert.match(styles, /\.zy-category-collection-card:focus-visible/);
  assert.match(styles, /min-height: 3rem/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /\.zy-category-collection-card:hover \.zy-category-collection-image,[\s\S]*transform: none/);
});
