import { useEffect, useState } from 'react';
import { ArrowRight, Grid3X3, Layers3 } from 'lucide-react';
import { Category, Product, WebsiteSettings } from '../types';
import HeroBanner from './HeroBanner';
import HomepageCustomerReviews, { HomepageReview } from './HomepageCustomerReviews';
import HomepageTrustStrip from './HomepageTrustStrip';
import StorefrontProductShelf from './StorefrontProductShelf';
import HomepagePreviewProductShelf from './HomepagePreviewProductShelf';
import { HomepagePreviewProductArt } from './HomepagePreviewProductCard';
import type {
  HomepagePreviewBanner,
  HomepagePreviewCategory,
  HomepagePreviewPresentation,
  HomepagePreviewPromo,
} from '../services/storefront/homepagePreviewPresentation';
import { DEFAULT_HOMEPAGE_SECTIONS } from '../services/settings/websiteSettings';
import {
  LAUNCH_CATEGORY_BANNERS,
  LAUNCH_FEATURED_CATEGORY_IDS,
  LAUNCH_MERCHANDISING_IMAGE_CONTRACT,
  formatCategoryDisplayName,
  getCategoryMonogram,
  getLaunchCategoryArtwork,
  orderByCategoryPriority,
} from '../services/storefront/launchMerchandising';
import { categoryMatches } from '../services/categories/categoryUtils';
import '../styles/homepagePreview.css';

export interface HomepageCategoryVisual {
  category: Category;
  image: string;
  itemsCount: number;
}

interface MarketplaceHomePhase1Props {
  settings?: WebsiteSettings | null;
  settingsLoading?: boolean;
  products: Product[];
  categories: Category[];
  categoryVisuals: HomepageCategoryVisual[];
  discountedProducts: Product[];
  featuredProducts: Product[];
  newArrivalProducts: Product[];
  bestSellerProducts: Product[];
  recommendedProducts: Product[];
  reviews: readonly HomepageReview[];
  wishlistProductIds: ReadonlySet<string>;
  loading: boolean;
  categoriesLoading?: boolean;
  categoriesError?: string | null;
  onExploreProducts: () => void;
  onBrowseCategories: () => void;
  onSelectCategory: (categoryId: string) => void;
  onSearch: (query: string) => void;
  onAddToCart: (product: Product) => void;
  onToggleWishlist: (product: Product) => void;
  onViewDetail: (product: Product) => void;
}

const PLACEHOLDER_TILES = Array.from({ length: 7 }, (_, index) => index);

type HomepageCategoryRailItem =
  | { kind: 'live'; category: HomepageCategoryVisual['category']; image: string; itemsCount: number }
  | { kind: 'preview'; category: HomepagePreviewCategory };

type HomepagePromoItem =
  | { kind: 'live'; id: string; name: string; image: string; onClick: () => void }
  | { kind: 'preview'; promo: HomepagePreviewPromo; onClick: () => void };

type HomepageBannerItem =
  | { kind: 'live'; id: string; name: string; image: string; hasArtwork: boolean; tone: number; onClick: () => void }
  | { kind: 'preview'; banner: HomepagePreviewBanner; onClick: () => void };

const FEATURED_CATEGORY_CARD_LIMIT = 4;
const SECONDARY_PROMO_LIMIT = 2;
const CATEGORY_BANNER_TONE_INDEX = { warm: 0, cool: 1 } as const;

export default function MarketplaceHomePhase1({
  settings,
  settingsLoading = false,
  products,
  categories,
  categoryVisuals,
  discountedProducts,
  featuredProducts,
  newArrivalProducts,
  bestSellerProducts,
  recommendedProducts,
  reviews,
  wishlistProductIds,
  loading,
  categoriesLoading = loading,
  categoriesError = null,
  onExploreProducts,
  onBrowseCategories,
  onSelectCategory,
  onSearch,
  onAddToCart,
  onToggleWishlist,
  onViewDetail,
}: MarketplaceHomePhase1Props) {
  const [previewPresentation, setPreviewPresentation] = useState<HomepagePreviewPresentation | null>(null);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    void import('../services/storefront/homepagePreviewPresentation').then(module => {
      if (module.HOMEPAGE_PREVIEW_PRESENTATION) setPreviewPresentation(module.HOMEPAGE_PREVIEW_PRESENTATION);
    });
  }, []);
  const liveCategoryRailItems: HomepageCategoryRailItem[] = categoryVisuals.map(item => ({ kind: 'live', ...item }));
  const previewCategoryRailItems: HomepageCategoryRailItem[] = previewPresentation?.categories.map(category => ({ kind: 'preview', category })) || [];
  const categoryRailItems = [...liveCategoryRailItems, ...previewCategoryRailItems].slice(0, 9);
  const bannerCategoryVisuals = orderByCategoryPriority(
    categoryVisuals,
    item => item.category.id,
    LAUNCH_CATEGORY_BANNERS.map(banner => banner.categoryId),
  ).slice(0, SECONDARY_PROMO_LIMIT);
  const bannerCategoryIds = new Set(bannerCategoryVisuals.map(item => item.category.id));
  const featuredCategoryVisuals = orderByCategoryPriority(categoryVisuals, item => item.category.id, LAUNCH_FEATURED_CATEGORY_IDS);
  // Cards skip categories that already get a wide promo banner and prefer real imagery; both are only fallbacks.
  const categoryCardVisuals = [
    ...featuredCategoryVisuals.filter(item => item.image && !bannerCategoryIds.has(item.category.id)),
    ...featuredCategoryVisuals.filter(item => !item.image && !bannerCategoryIds.has(item.category.id)),
    ...featuredCategoryVisuals.filter(item => bannerCategoryIds.has(item.category.id)),
  ];
  const promoCategoryItems: HomepagePromoItem[] = [
    ...categoryCardVisuals.slice(0, FEATURED_CATEGORY_CARD_LIMIT).map(({ category, image }) => ({
      kind: 'live' as const,
      id: category.id,
      name: formatCategoryDisplayName(category.name),
      image,
      onClick: () => onSelectCategory(category.id),
    })),
    ...(previewPresentation?.promos.map(promo => ({ kind: 'preview' as const, promo, onClick: onBrowseCategories })) || []),
  ].slice(0, FEATURED_CATEGORY_CARD_LIMIT);
  const secondaryPromoItems: HomepageBannerItem[] = [
    ...bannerCategoryVisuals.map(({ category, image }, index) => {
      const bannerImage = getLaunchCategoryArtwork(category.id).bannerImage;
      const configuredTone = LAUNCH_CATEGORY_BANNERS.find(banner => categoryMatches(banner.categoryId, category.id))?.tone;
      return {
        kind: 'live' as const,
        id: category.id,
        name: formatCategoryDisplayName(category.name),
        image: bannerImage || image,
        hasArtwork: Boolean(bannerImage),
        tone: configuredTone ? CATEGORY_BANNER_TONE_INDEX[configuredTone] : index % 2,
        onClick: () => onSelectCategory(category.id),
      };
    }),
    ...(previewPresentation?.banners.map(banner => ({ kind: 'preview' as const, banner, onClick: onBrowseCategories })) || []),
  ].slice(0, SECONDARY_PROMO_LIMIT);
  const homepageSections = settings?.homepageSections || DEFAULT_HOMEPAGE_SECTIONS;
  const recommendedShelfTitle = homepageSections.recommended.title === 'Recommended Products'
    ? 'Explore More'
    : homepageSections.recommended.title;

  const renderShelf = (shelf: {
    id: string;
    eyebrow: string;
    tone: 'deals' | 'featured' | 'new' | 'best-seller' | 'recommended';
    title: string;
    subtitle: string;
    products: Product[];
    emptyState: { title: string; description: string };
  }) => {
    const hasLiveProducts = shelf.products.length > 0;
    const shouldShowPreviewShelf = Boolean(previewPresentation) && shelf.tone === 'recommended' && !hasLiveProducts;

    if (loading || hasLiveProducts) {
      return (
        <StorefrontProductShelf
          {...shelf}
          loading={loading}
          viewAllAction={{ label: 'View all', onClick: onExploreProducts, ariaLabel: 'View all products' }}
          wishlistProductIds={wishlistProductIds}
          onAddToCart={onAddToCart}
          onToggleWishlist={onToggleWishlist}
          onViewDetail={onViewDetail}
          settings={settings}
        />
      );
    }

    if (!shouldShowPreviewShelf || !previewPresentation) return null;

    const previewProducts = previewPresentation.products.filter(product => product.shelf === 'recommended');
    return (
      <HomepagePreviewProductShelf
        id={shelf.id}
        eyebrow={shelf.eyebrow}
        tone={shelf.tone}
        title={shelf.title}
        subtitle={shelf.subtitle}
        products={previewProducts.length > 0 ? previewProducts : previewPresentation.products}
        onBrowse={onExploreProducts}
      />
    );
  };

  return (
    <div className={`zy-foundation-home zy-launch-home animate-fadeIn${previewPresentation ? ' zy-reference-preview' : ''}`}>
      <div className="zy-foundation-hero-wrap zy-ai-hero-wrap">
        <HeroBanner
          settings={settings}
          settingsLoading={settingsLoading}
          products={products}
          productsLoading={loading}
          categories={categories}
          previewPresentation={previewPresentation}
          onExploreProducts={onExploreProducts}
          onBrowseCategories={onBrowseCategories}
          onSelectCategory={onSelectCategory}
          onSearch={onSearch}
          onViewProduct={onViewDetail}
        />
      </div>

      <section className="zy-foundation-category-dock" data-zy-reveal aria-labelledby="phase-one-categories-title">
        <header className="zy-foundation-dock-header">
          <div className="zy-foundation-dock-copy">
            <span className="zy-foundation-eyebrow">Quick shopping</span>
            <h2 id="phase-one-categories-title">Explore categories</h2>
            <p>Browse live collections and find what you need faster.</p>
          </div>
          <button type="button" onClick={onBrowseCategories} className="zy-foundation-text-link">
            View all
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        {categoriesLoading && !previewPresentation ? (
          <div className="zy-foundation-category-rail" aria-label="Loading categories" aria-busy="true">
            {PLACEHOLDER_TILES.map(index => <div key={index} className="zy-foundation-category-skeleton" aria-hidden="true"><span /><i /><small /></div>)}
          </div>
        ) : categoriesError && !previewPresentation ? (
          <div className="zy-foundation-category-empty" role="alert">
            <div className="zy-foundation-empty-note">
              <span><Layers3 className="h-5 w-5" aria-hidden="true" /></span>
              <div><strong>Categories could not be loaded</strong><p>{categoriesError}</p></div>
            </div>
          </div>
        ) : categoryRailItems.length > 0 ? (
          <div className="zy-foundation-category-rail" role="list">
            {categoryRailItems.map(item => item.kind === 'live' ? (
              <button
                key={item.category.id}
                type="button"
                onClick={() => onSelectCategory(item.category.id)}
                className="zy-foundation-category-tile"
                data-zy-category-motion
                aria-label={`Browse ${formatCategoryDisplayName(item.category.name)}, ${item.itemsCount} ${item.itemsCount === 1 ? 'product' : 'products'}`}
                role="listitem"
              >
                <span className="zy-foundation-category-image" data-placeholder={item.image ? undefined : 'true'}>
                  {item.image
                    ? <img src={item.image} alt="" loading="lazy" fetchPriority="low" decoding="async" width="160" height="160" referrerPolicy="no-referrer" />
                    : <b className="zy-category-monogram" aria-hidden="true">{getCategoryMonogram(item.category.name)}</b>}
                </span>
                <strong>{formatCategoryDisplayName(item.category.name)}</strong>
                <small>{item.itemsCount} {item.itemsCount === 1 ? 'product' : 'products'}</small>
              </button>
            ) : (
              <button
                key={item.category.id}
                type="button"
                onClick={onBrowseCategories}
                className={`zy-foundation-category-tile zy-foundation-category-preview zy-foundation-category-tone-${item.category.tone}`}
                data-preview-category-id={item.category.id}
                role="listitem"
                aria-label={`Explore ${item.category.name}`}
              >
                <span className="zy-foundation-category-image"><HomepagePreviewProductArt art={item.category.art} tone={item.category.tone} /></span>
                <strong>{item.category.name}</strong>
                <small>Explore collection</small>
              </button>
            ))}
            {!previewPresentation && (
              <button type="button" onClick={onBrowseCategories} className="zy-foundation-category-tile zy-foundation-category-all" role="listitem" aria-label="Browse all categories">
                <span className="zy-foundation-category-image"><Grid3X3 className="h-6 w-6" aria-hidden="true" /></span>
                <strong>All categories</strong>
                <small>Browse collections</small>
              </button>
            )}
          </div>
        ) : (
          <div className="zy-foundation-category-empty">
            <div className="zy-foundation-empty-note" role="status">
              <span><Layers3 className="h-5 w-5" aria-hidden="true" /></span>
              <div><strong>Categories are being prepared</strong><p>Published collections will appear here automatically once they are available in the live catalog.</p></div>
            </div>
          </div>
        )}
      </section>

      <div className="zy-foundation-container zy-launch-trust-wrap" data-zy-reveal>
        <HomepageTrustStrip />
      </div>

      {promoCategoryItems.length > 0 && (
        <section className="zy-home-category-promos" data-zy-reveal aria-labelledby="homepage-category-promos-title">
          <header className="zy-home-category-promos-header">
            <div>
              <span className="zy-home-category-promos-eyebrow">Shop by category</span>
              <h2 id="homepage-category-promos-title">Explore popular collections</h2>
            </div>
          </header>
          <div className="zy-home-category-promo-grid">
            {promoCategoryItems.map((item, index) => (
              <button
                key={item.kind === 'live' ? item.id : item.promo.id}
                type="button"
                onClick={item.onClick}
                className={`zy-home-category-promo zy-home-category-promo-tone-${index % 4}${item.kind === 'preview' ? ' is-preview' : ''}`}
                aria-label={item.kind === 'live' ? `Shop ${item.name} category` : `Explore ${item.promo.categoryName}`}
                data-preview-promo-id={item.kind === 'preview' ? item.promo.id : undefined}
              >
                <span
                  className="zy-home-category-promo-media"
                  data-placeholder={item.kind === 'live' && !item.image ? 'true' : undefined}
                  aria-hidden="true"
                >
                  {item.kind === 'live'
                    ? item.image
                      ? (
                        <img
                          src={item.image}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          width={LAUNCH_MERCHANDISING_IMAGE_CONTRACT.categoryCard.width}
                          height={LAUNCH_MERCHANDISING_IMAGE_CONTRACT.categoryCard.height}
                          referrerPolicy="no-referrer"
                        />
                      )
                      : <b className="zy-category-monogram">{getCategoryMonogram(item.name)}</b>
                    : <HomepagePreviewProductArt art={item.promo.art} tone={item.promo.tone} />}
                </span>
                <span className="zy-home-category-promo-copy">
                  {item.kind === 'preview' && <small>{item.promo.eyebrow}</small>}
                  <strong>{item.kind === 'live' ? item.name : item.promo.title}</strong>
                  {item.kind === 'preview' && <small>{item.promo.subtitle}</small>}
                  <span className="zy-home-category-promo-cta">{item.kind === 'live' ? 'Shop Now' : item.promo.cta} <ArrowRight aria-hidden="true" /></span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {secondaryPromoItems.length > 0 && (
        <section className="zy-home-secondary-promos" data-zy-reveal aria-label="Explore more categories">
          <div className="zy-home-secondary-promo-grid">
            {secondaryPromoItems.map((item, index) => (
              <button
                key={item.kind === 'live' ? item.id : item.banner.id}
                type="button"
                onClick={item.onClick}
                className={`zy-home-secondary-promo zy-home-secondary-promo-tone-${item.kind === 'live' ? item.tone : index}${item.kind === 'preview' ? ' is-preview' : ''}`}
                aria-label={item.kind === 'live' ? `Explore ${item.name}` : `Explore ${item.banner.categoryName}`}
                data-preview-banner-id={item.kind === 'preview' ? item.banner.id : undefined}
                data-artwork={item.kind === 'live' && item.hasArtwork ? 'true' : undefined}
              >
                <span className="zy-home-secondary-promo-copy">
                  <small>{item.kind === 'live' ? 'Discover more' : item.banner.eyebrow}</small>
                  <strong>{item.kind === 'live' ? item.name : item.banner.title}</strong>
                  {item.kind === 'preview' && <small>{item.banner.subtitle}</small>}
                  <span className="zy-home-secondary-promo-cta">{item.kind === 'live' ? 'Shop Now' : item.banner.cta} <ArrowRight aria-hidden="true" /></span>
                </span>
                {(item.kind === 'preview' || item.image) && (
                  <span className="zy-home-secondary-promo-media" aria-hidden="true">
                    {item.kind === 'live'
                      ? (
                        <img
                          src={item.image}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          width={LAUNCH_MERCHANDISING_IMAGE_CONTRACT.categoryBanner.width}
                          height={LAUNCH_MERCHANDISING_IMAGE_CONTRACT.categoryBanner.height}
                          referrerPolicy="no-referrer"
                        />
                      )
                      : <HomepagePreviewProductArt art={item.banner.art} tone={item.banner.tone} />}
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="zy-foundation-container zy-foundation-shelf-stack">
        {homepageSections.flashDeals.enabled && renderShelf({
          id: 'homepage-flash-deals',
          eyebrow: 'Live savings',
          tone: 'deals',
          title: homepageSections.flashDeals.title,
          subtitle: homepageSections.flashDeals.subtitle,
          products: discountedProducts,
          emptyState: {
            title: 'No live deals right now',
            description: 'Products with a genuine active discount will appear here automatically.',
          },
        })}

        {homepageSections.newArrivals.enabled && renderShelf({
          id: 'homepage-new-arrivals',
          eyebrow: 'Recently added',
          tone: 'new',
          title: homepageSections.newArrivals.title,
          subtitle: homepageSections.newArrivals.subtitle,
          products: newArrivalProducts,
          emptyState: {
            title: 'No new arrivals right now',
            description: 'Products marked as new will appear here automatically.',
          },
        })}

        {homepageSections.featured.enabled && renderShelf({
          id: 'homepage-featured-products',
          eyebrow: 'Marketplace spotlight',
          tone: 'featured',
          title: homepageSections.featured.title,
          subtitle: homepageSections.featured.subtitle,
          products: featuredProducts,
          emptyState: {
            title: 'No featured products right now',
            description: 'Published products selected as featured will appear here automatically.',
          },
        })}

        {homepageSections.bestSellers.enabled && renderShelf({
          id: 'homepage-best-sellers',
          eyebrow: 'Popular picks',
          tone: 'best-seller',
          title: homepageSections.bestSellers.title,
          subtitle: homepageSections.bestSellers.subtitle,
          products: bestSellerProducts,
          emptyState: {
            title: 'No best sellers right now',
            description: 'Published products marked as best sellers will appear here automatically.',
          },
        })}

        {homepageSections.recommended.enabled && renderShelf({
          id: 'homepage-recommended-products',
          eyebrow: 'Explore more',
          tone: 'recommended',
          title: recommendedShelfTitle,
          subtitle: homepageSections.recommended.subtitle,
          products: recommendedProducts,
          emptyState: {
            title: 'More products are being refreshed',
            description: 'Available published products will appear here as the live catalog is updated.',
          },
        })}
      </div>

      {reviews.length > 0 && (
        <div className="zy-foundation-container zy-launch-reviews-wrap" data-zy-reveal>
          <HomepageCustomerReviews
            reviews={reviews}
            products={products}
            enabled={settings?.enableReviews !== false}
          />
        </div>
      )}
    </div>
  );
}
