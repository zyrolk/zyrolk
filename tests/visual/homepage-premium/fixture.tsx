import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import MarketplaceHomePhase1 from '@zyro/components/MarketplaceHomePhase1';
import Navbar from '@zyro/components/Navbar';
import MobileBottomNav from '@zyro/components/MobileBottomNav';
import { DEFAULT_WEBSITE_SETTINGS } from '@zyro/services/settings/websiteSettings';
import type { Category, CustomerProduct, Product } from '@zyro/types';

import '@zyro/index.css';
import '@zyro/styles/storefrontL6.css';
import '@zyro/styles/storefrontL7.css';
import '@zyro/styles/storefrontHeader.css';
import '@zyro/styles/storefrontPenpot.css';

const image = (background: string, label: string) => `data:image/svg+xml,${encodeURIComponent(`
  <svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
    <rect width="640" height="480" rx="32" fill="${background}"/>
    <circle cx="490" cy="130" r="88" fill="#ffffff" fill-opacity=".38"/>
    <rect x="80" y="125" width="300" height="190" rx="28" fill="#ffffff" fill-opacity=".78"/>
    <text x="80" y="375" font-family="Arial,sans-serif" font-size="28" font-weight="700" fill="#0b1f4a">${label}</text>
  </svg>
`)}`;

const products: Product[] = [
  {
    id: 'visual-blue-lamp', name: 'Modern Blue Desk Lamp', description: 'Synthetic visual fixture product', price: 2490,
    imageUrl: image('#dbeafe', 'Desk Lamp'), category: 'home-garden', rating: 4.8, reviewsCount: 12, stock: 8, specs: {}, isActive: true,
  },
  {
    id: 'visual-long-title', name: 'Portable Multi-Function Wireless Bluetooth Speaker with Deep Bass and Long Battery Life', description: 'Synthetic visual fixture product', price: 3990,
    imageUrl: image('#ede9fe', 'Speaker'), category: 'electronics', rating: 4.6, reviewsCount: 8, stock: 6, specs: {}, isActive: true,
  },
  {
    id: 'visual-fashion-watch', name: 'Minimal Everyday Watch', description: 'Synthetic visual fixture product', price: 3290, originalPrice: 4490, discount: 27, promotionEnabled: true,
    imageUrl: image('#ffedd5', 'Watch'), category: 'fashion', rating: 4.9, reviewsCount: 18, stock: 4, specs: {}, isActive: true, isFeatured: true,
  },
  {
    id: 'visual-health-kit', name: 'Wellness Starter Set', description: 'Synthetic visual fixture product', price: 1790,
    imageUrl: image('#fef3c7', 'Wellness'), category: 'health-beauty', rating: 4.5, reviewsCount: 5, stock: 3, specs: {}, isActive: true, isNew: true,
  },
  {
    id: 'visual-out-of-stock', name: 'Out of Stock Fixture', description: 'Synthetic visual fixture product', price: 1990,
    imageUrl: image('#e5e7eb', 'Unavailable'), category: 'accessories', rating: 4.2, reviewsCount: 3, stock: 0, specs: {}, isActive: true,
  },
];

const categories: Category[] = [
  { id: 'automotive', name: 'Automotive', icon: 'car', imageUrl: image('#dbeafe', 'Auto'), isActive: true, count: 4 },
  { id: 'kids-toys', name: 'Kids & Toys', icon: 'toy', imageUrl: image('#ede9fe', 'Kids'), isActive: true, count: 3 },
  { id: 'electronics', name: 'Electronics', icon: 'monitor', imageUrl: image('#dbeafe', 'Tech'), isActive: true, count: 7 },
  { id: 'fashion', name: 'Fashion', icon: 'shirt', imageUrl: image('#ffedd5', 'Style'), isActive: true, count: 5 },
  { id: 'health-beauty', name: 'Health & Beauty', icon: 'sparkles', imageUrl: image('#fef3c7', 'Care'), isActive: true, count: 6 },
  { id: 'home-garden', name: 'Home & Garden', icon: 'home', imageUrl: image('#dcfce7', 'Home'), isActive: true, count: 8 },
];

const categoryVisuals = categories.map(category => ({
  category,
  image: category.imageUrl || '',
  itemsCount: category.count || 0,
}));

const customerProducts: CustomerProduct[] = products.map(product => ({
  id: product.id, name: product.name, image: product.imageUrl, sellingPrice: product.price,
  category: product.category, brand: product.brand || '', model: product.model || '', stock: product.stock,
  rating: product.rating, reviewCount: product.reviewsCount, isNew: Boolean(product.isNew),
  isFeatured: Boolean(product.isFeatured), isBestSeller: Boolean(product.isBestSeller),
}));

function Fixture() {
  const [currentPage, setCurrentPage] = useState('home');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAdminMode, setIsAdminMode] = useState(false);
  const [cartCount] = useState(0);

  const noop = () => undefined;
  const selectCategory = (categoryId: string) => setCurrentPage(categoryId);

  return (
    <div className="zy-l6-shell zy-penpot-storefront">
      <Navbar
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        cartCount={cartCount}
        wishlistCount={0}
        onOpenCart={noop}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        products={customerProducts}
        categories={categories}
        isLoading={false}
        onSelectCategory={selectCategory}
        onSelectProduct={noop}
        onOpenAuthModal={noop}
        isAdminMode={isAdminMode}
        setIsAdminMode={setIsAdminMode}
        onSelectListingMode={noop}
        settings={DEFAULT_WEBSITE_SETTINGS}
        isAdminUser={false}
      />
      <main className="zy-l6-main">
        <MarketplaceHomePhase1
          settings={DEFAULT_WEBSITE_SETTINGS}
          products={products}
          categories={categories}
          categoryVisuals={categoryVisuals}
          discountedProducts={[products[2]]}
          featuredProducts={[products[0], products[2]]}
          newArrivalProducts={[products[3]]}
          bestSellerProducts={[products[1]]}
          recommendedProducts={[products[0], products[1], products[3]]}
          wishlistProductIds={new Set()}
          loading={false}
          catalogStatus="ready"
          categoriesLoading={false}
          onExploreProducts={noop}
          onBrowseCategories={() => setCurrentPage('categories')}
          onSelectCategory={selectCategory}
          onSearch={setSearchQuery}
          onAddToCart={noop}
          onToggleWishlist={noop}
          onViewDetail={noop}
          reviews={[]}
        />
      </main>
      <MobileBottomNav
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        cartCount={cartCount}
        wishlistCount={0}
        onOpenCart={noop}
        isAdminMode={isAdminMode}
        setIsAdminMode={setIsAdminMode}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Fixture />);
