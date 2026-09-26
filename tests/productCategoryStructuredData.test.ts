import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStorefrontSeo } from '../src/services/seo/storefrontSeo';
import type { Category, Product } from '../src/types';

type Crumb = { position: number; name: string; item: string };
type GraphNode = Record<string, unknown> & { itemListElement?: Crumb[] };

const origin = 'https://zyro.lk';
const electronics: Category = { id: 'electronics', name: 'Electronics', icon: 'cpu' };
const categories: Category[] = [electronics];
const product = {
  id: 'p-123', name: 'V11 Wireless Speaker', description: 'Speaker', price: 4500, imageUrl: '', category: 'electronics',
  rating: 0, reviewsCount: 0, stock: 4, isActive: true,
} as Product;

const graphOf = (seo: ReturnType<typeof buildStorefrontSeo>): GraphNode[] => seo.structuredData['@graph'] as GraphNode[];
const breadcrumbs = (graph: GraphNode[]) => graph.filter((node) => node['@type'] === 'BreadcrumbList');
const collections = (graph: GraphNode[]) => graph.filter((node) => node['@type'] === 'CollectionPage');

test('A: a normal category page emits one category breadcrumb and a CollectionPage', () => {
  const seo = buildStorefrontSeo({ currentPage: 'products', category: electronics, categories, requestedCategoryId: 'electronics', origin });
  const graph = graphOf(seo);
  const lists = breadcrumbs(graph);
  assert.equal(lists.length, 1);
  assert.equal(collections(graph).length, 1);
  assert.equal(seo.canonical, `${origin}/categories/electronics`);
  assert.deepEqual(lists[0].itemListElement?.map((crumb) => crumb.item), [
    `${origin}/`,
    `${origin}/categories`,
    `${origin}/categories/electronics`,
  ]);
  assert.equal(seo.robots, 'index, follow');
});

test('B: a direct product page emits one product breadcrumb and no CollectionPage', () => {
  const seo = buildStorefrontSeo({ currentPage: 'products', product, requestedProductId: 'p-123', categories, origin });
  const graph = graphOf(seo);
  const lists = breadcrumbs(graph);
  assert.equal(lists.length, 1);
  assert.equal(collections(graph).length, 0);
  assert.deepEqual(lists[0].itemListElement?.map((crumb) => [crumb.name, crumb.item]), [
    ['Home', `${origin}/`],
    ['Electronics', `${origin}/categories/electronics`],
    ['V11 Wireless Speaker', `${origin}/products/p-123`],
  ]);
});

test('C: a product opened with category context emits only the product breadcrumb', () => {
  const seo = buildStorefrontSeo({
    currentPage: 'products', product, requestedProductId: 'p-123',
    category: electronics, requestedCategoryId: 'electronics', categories, origin,
  });
  const graph = graphOf(seo);
  const lists = breadcrumbs(graph);
  assert.equal(lists.length, 1);
  assert.equal(collections(graph).length, 0);
  assert.deepEqual(lists[0].itemListElement?.map((crumb) => [crumb.name, crumb.item]), [
    ['Home', `${origin}/`],
    ['Electronics', `${origin}/categories/electronics`],
    ['V11 Wireless Speaker', `${origin}/products/p-123`],
  ]);
  assert.equal(seo.canonical, `${origin}/products/p-123`);
  assert.equal(seo.structuredData['@type'], 'Product');
  assert.equal(seo.robots, 'index, follow');
});

test('D: an unknown requested category without an open product stays noindex', () => {
  const seo = buildStorefrontSeo({ currentPage: 'products', category: null, requestedCategoryId: 'missing-category', categories, origin });
  const graph = graphOf(seo);
  assert.equal(seo.robots, 'noindex, follow');
  assert.equal(breadcrumbs(graph).length, 0);
  assert.equal(collections(graph).length, 0);
});
