import React from 'react';
import { createRoot } from 'react-dom/client';
import ProductCard from '../../src/components/ProductCard';
import { CategoryDisplayProvider } from '../../src/components/CategoryDisplayContext';
import type { Product } from '../../src/types';
import '../../src/index.css';
import '../../src/styles/storefrontL6.css';
import '../../src/styles/storefrontL7.css';
import './fixture.css';

const svgDataUri = (body: string, background: string): string => (
  `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600">
      <rect width="600" height="600" rx="48" fill="${background}" />
      ${body}
    </svg>
  `)}`
);

const normalImage = svgDataUri(
  '<circle cx="300" cy="280" r="150" fill="#1d4ed8"/><circle cx="300" cy="280" r="108" fill="#dbeafe"/><text x="300" y="295" text-anchor="middle" font-size="42" font-family="Arial" fill="#1d4ed8">ZYRO</text>',
  '#eff6ff',
);

const discountedImage = svgDataUri(
  '<rect x="150" y="150" width="300" height="260" rx="36" fill="#2563eb"/><circle cx="300" cy="280" r="82" fill="#bfdbfe"/><path d="M220 435h160" stroke="#0f172a" stroke-width="24" stroke-linecap="round"/>',
  '#f8fafc',
);

const baseProduct: Product = {
  id: 'visual-fixture-normal',
  name: 'Compact Wireless Audio Speaker',
  description: 'Deterministic synthetic visual fixture.',
  price: 2499,
  imageUrl: normalImage,
  category: 'electronics',
  rating: 4.6,
  reviewsCount: 28,
  stock: 18,
  specs: {},
  isActive: true,
};

const fixtures: Array<{ id: string; label: string; product: Product }> = [
  { id: 'normal', label: 'Normal in-stock', product: baseProduct },
  {
    id: 'long-title',
    label: 'Long title',
    product: {
      ...baseProduct,
      id: 'visual-fixture-long-title',
      name: 'Universal Adjustable Magnetic Phone Holder with 360 Degree Dashboard Mount',
      price: 1799,
      stock: 7,
    },
  },
  {
    id: 'discount',
    label: 'Discounted',
    product: {
      ...baseProduct,
      id: 'visual-fixture-discount',
      name: 'Premium Bluetooth Receiver',
      imageUrl: discountedImage,
      price: 2499,
      originalPrice: 2999,
      promotionEnabled: true,
      stock: 4,
      isNew: true,
    },
  },
  {
    id: 'out-of-stock',
    label: 'Out of stock',
    product: {
      ...baseProduct,
      id: 'visual-fixture-out-of-stock',
      name: 'Silicone Food Cover Set',
      price: 1299,
      stock: 0,
      isFeatured: true,
    },
  },
  {
    id: 'missing-image',
    label: 'Missing image fallback',
    product: {
      ...baseProduct,
      id: 'visual-fixture-missing-image',
      name: 'Portable LED Work Light',
      imageUrl: '',
      price: 1599,
      stock: 12,
    },
  },
];

const viewportLabel = new URLSearchParams(window.location.search).get('viewport') || `${window.innerWidth}`;

function ProductCardFixture() {
  return (
    <div className="zy-visual-fixture-page">
      <header className="zy-visual-fixture-header">
        <strong>Zyro.lk ProductCard fixture</strong>
        <span>{viewportLabel}px · synthetic data only</span>
      </header>
      <main className="zy-visual-fixture-grid" aria-label="Synthetic ProductCard cases">
        {fixtures.map(({ id, label, product }) => (
          <section className="zy-visual-fixture-case" data-fixture-case={id} key={id} aria-label={label}>
            <ProductCard
              product={product}
              isWishlisted={id === 'discount'}
              settings={{ enableCOD: true }}
              onAddToCart={() => undefined}
              onToggleWishlist={() => undefined}
              onViewDetail={() => undefined}
            />
          </section>
        ))}
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <CategoryDisplayProvider value={[{ id: 'electronics', name: 'Electronics', icon: 'cpu' }]}>
    <ProductCardFixture />
  </CategoryDisplayProvider>,
);
