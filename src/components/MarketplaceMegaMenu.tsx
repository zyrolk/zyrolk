import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Baby,
  BookOpen,
  CarFront,
  Dumbbell,
  Grid3X3,
  HeartPulse,
  House,
  Shirt,
  ShoppingBasket,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import type { Category } from '../types';

interface MarketplaceMegaMenuProps {
  categories: Category[];
  onSelectCategory: (categoryId: string) => void;
}

const CATEGORY_ORDER = [
  'electronics',
  'fashion',
  'home',
  'beauty',
  'groceries',
  'sports',
  'automotive',
  'health',
  'kids',
  'books',
];

const resolveCategoryIcon = (value: string) => {
  const normalized = value.toLowerCase();
  if (normalized.includes('electronic') || normalized.includes('mobile')) return Smartphone;
  if (normalized.includes('fashion') || normalized.includes('cloth')) return Shirt;
  if (normalized.includes('home') || normalized.includes('furniture')) return House;
  if (normalized.includes('beauty') || normalized.includes('cosmetic')) return Sparkles;
  if (normalized.includes('grocery') || normalized.includes('food')) return ShoppingBasket;
  if (normalized.includes('sport') || normalized.includes('fitness')) return Dumbbell;
  if (normalized.includes('auto') || normalized.includes('vehicle')) return CarFront;
  if (normalized.includes('health') || normalized.includes('wellness')) return HeartPulse;
  if (normalized.includes('kid') || normalized.includes('baby') || normalized.includes('toy')) return Baby;
  if (normalized.includes('book') || normalized.includes('stationery')) return BookOpen;
  return Grid3X3;
};

export default function MarketplaceMegaMenu({ categories, onSelectCategory }: MarketplaceMegaMenuProps) {
  const visibleCategories = useMemo(() => {
    const activeCategories = categories.filter((category) => category.isActive !== false);
    return [...activeCategories].sort((left, right) => {
      const leftValue = `${left.id} ${left.name}`.toLowerCase();
      const rightValue = `${right.id} ${right.name}`.toLowerCase();
      const leftIndex = CATEGORY_ORDER.findIndex((key) => leftValue.includes(key));
      const rightIndex = CATEGORY_ORDER.findIndex((key) => rightValue.includes(key));
      if (leftIndex === -1 && rightIndex === -1) return left.name.localeCompare(right.name);
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    }).slice(0, 10);
  }, [categories]);
  const [activeCategoryId, setActiveCategoryId] = useState<string | null>(null);
  const activeCategory = visibleCategories.find((category) => category.id === activeCategoryId) ?? visibleCategories[0];
  const ActiveIcon = activeCategory ? resolveCategoryIcon(`${activeCategory.id} ${activeCategory.name}`) : Grid3X3;

  if (visibleCategories.length === 0) {
    return (
      <div className="zy-mega-empty" role="status">
        <Grid3X3 aria-hidden="true" />
        <div>
          <strong>Categories are being prepared</strong>
          <span>Active marketplace categories will appear here automatically.</span>
        </div>
      </div>
    );
  }

  return (
    <div className="zy-mega-layout">
      <nav className="zy-mega-category-list" aria-label="Marketplace categories">
        {visibleCategories.map((category) => {
          const Icon = resolveCategoryIcon(`${category.id} ${category.name}`);
          const isActive = category.id === activeCategory?.id;
          return (
            <button
              key={category.id}
              type="button"
              className={isActive ? 'is-active' : undefined}
              onMouseEnter={() => setActiveCategoryId(category.id)}
              onFocus={() => setActiveCategoryId(category.id)}
              onClick={() => onSelectCategory(category.id)}
              aria-current={isActive ? 'true' : undefined}
            >
              <span className="zy-mega-category-icon"><Icon aria-hidden="true" /></span>
              <span>{category.name}</span>
              <ArrowRight aria-hidden="true" />
            </button>
          );
        })}
      </nav>

      {activeCategory && (
        <section className="zy-mega-feature" aria-labelledby={`mega-category-${activeCategory.id}`}>
          <div className="zy-mega-feature-copy">
            <span className="zy-mega-eyebrow">Explore the marketplace</span>
            <h2 id={`mega-category-${activeCategory.id}`}>{activeCategory.name}</h2>
            <p>Discover available products and trusted brands in {activeCategory.name.toLowerCase()}.</p>
            <button type="button" onClick={() => onSelectCategory(activeCategory.id)}>
              Shop {activeCategory.name}<ArrowRight aria-hidden="true" />
            </button>
          </div>
          <div className="zy-mega-feature-visual" aria-hidden="true">
            {activeCategory.imageUrl ? (
              <img
                src={activeCategory.imageUrl}
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />
            ) : (
              <ActiveIcon />
            )}
          </div>
          <div className="zy-mega-subcategories">
            <span>Popular in {activeCategory.name}</span>
            <div>
              {(activeCategory.subcategories ?? []).filter((subcategory) => subcategory.isActive !== false).slice(0, 8).map((subcategory) => (
                <button key={subcategory.id} type="button" onClick={() => onSelectCategory(activeCategory.id)}>
                  {subcategory.name}
                </button>
              ))}
              {!activeCategory.subcategories?.some((subcategory) => subcategory.isActive !== false) && (
                <button type="button" onClick={() => onSelectCategory(activeCategory.id)}>View all {activeCategory.name}</button>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
