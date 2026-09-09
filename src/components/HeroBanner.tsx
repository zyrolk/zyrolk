import {
  FormEvent,
  KeyboardEvent,
  TouchEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Layers3,
  Search,
  ShoppingBag,
  Sparkles,
  Store,
} from 'lucide-react';
import { Category, Product, WebsiteSettings } from '../types';
import { isProductExplicitlyActive } from '../services/storefront/productAvailability';
import { normalizeSlideSpeed } from '../services/hero-slider/heroSlider';
import { projectCustomerProducts } from '../services/product-search/customerProjection';
import { searchCustomerProducts } from '../services/product-search/customerProductSearch';
import { normalizeSearchText } from '../services/product-search/productSearchMetadata';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import type { HomepagePreviewPresentation } from '../services/storefront/homepagePreviewPresentation';
import { HomepagePreviewProductArt } from './HomepagePreviewProductCard';
import '../styles/storefrontHero.css';

interface HeroBannerProps {
  onExploreProducts: () => void;
  onBrowseCategories?: () => void;
  onSelectCategory?: (categoryId: string) => void;
  onSearch?: (query: string) => void;
  onViewProduct?: (product: Product) => void;
  settings?: WebsiteSettings | null;
  products?: readonly Product[];
  categories?: readonly Category[];
  previewPresentation?: HomepagePreviewPresentation | null;
}

const MARKETPLACE_MESSAGE = 'Browse products from trusted Sri Lankan suppliers, add to cart, and pay with Cash on Delivery when your order arrives.';
const REFERENCE_HERO_BADGE = 'NEW ARRIVALS';
const REFERENCE_HERO_TITLE = 'Upgrade Your Everyday';
const REFERENCE_HERO_CTA = 'Shop Now';
const LEGACY_HERO_COPY_PATTERN = new RegExp([
  ['marketplace', 'collection'].join('\\s+'),
  ['special', 'promotion', 'in', 'colombo'].join('\\s+'),
  ['order', 'now'].join('\\s+'),
].join('|'), 'iu');
const PREMIUM_ELECTRONICS_PATTERN = /premium\s+electronics/giu;
const PREFERRED_CATEGORY_ORDER = ['electronics', 'fashion', 'home', 'beauty', 'groceries', 'sports'];

const replacePremiumElectronics = (value: string, replacement: string): string =>
  value.replace(PREMIUM_ELECTRONICS_PATTERN, replacement).trim();

const normalizeHeroPresentationText = (value: string | undefined, fallback: string): string => {
  const clean = replacePremiumElectronics(value || '', '').replace(/\s+/gu, ' ').trim();
  return !clean || LEGACY_HERO_COPY_PATTERN.test(clean) ? fallback : clean;
};

const sortCategories = (categories: readonly Category[]): Category[] => [...categories]
  .filter(category => category.isActive !== false)
  .sort((left, right) => {
    const leftKey = normalizeSearchText(`${left.id} ${left.name}`);
    const rightKey = normalizeSearchText(`${right.id} ${right.name}`);
    const leftIndex = PREFERRED_CATEGORY_ORDER.findIndex(value => leftKey.includes(value));
    const rightIndex = PREFERRED_CATEGORY_ORDER.findIndex(value => rightKey.includes(value));
    const leftRank = leftIndex < 0 ? PREFERRED_CATEGORY_ORDER.length : leftIndex;
    const rightRank = rightIndex < 0 ? PREFERRED_CATEGORY_ORDER.length : rightIndex;
    return leftRank - rightRank || left.name.localeCompare(right.name);
  });

export default function HeroBanner({
  onExploreProducts,
  onBrowseCategories,
  onSelectCategory,
  onSearch,
  onViewProduct,
  settings,
  products = [],
  categories = [],
  previewPresentation = null,
}: HeroBannerProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const touchStartX = useRef<number | null>(null);
  const searchShellRef = useRef<HTMLDivElement | null>(null);
  const shouldReduceMotion = useReducedMotion();
  const debouncedQuery = useDebouncedValue(searchQuery, 120);

  const configuredSlides = settings?.heroBanners?.filter(banner => banner.enabled !== false) || [];
  const cmsSlides = configuredSlides.map((banner, index) => ({
    id: banner.id || `banner-${index}`,
    badge: banner.badge?.trim() || '',
    title: banner.title?.trim() || '',
    subtitle: banner.subtitle?.trim() || '',
    description: banner.description?.trim() || '',
    image: banner.image?.trim() || '',
    bgGradient: banner.bgGradient,
    cta: banner.buttonText?.trim() || '',
    ctaUrl: banner.buttonUrl?.trim() || '',
  }));

  const slides = previewPresentation?.hero ? [previewPresentation.hero, ...cmsSlides] : cmsSlides.length > 0 ? cmsSlides : [{
    id: 'live-catalog',
    badge: '',
    title: '',
    subtitle: '',
    description: '',
    image: '',
    bgGradient: 'blue',
    cta: 'Shop Now',
    ctaUrl: '/products',
  }];

  const activeSlide = slides[currentSlide];
  const isReferencePreview = Boolean(previewPresentation);
  const displayBadge = normalizeHeroPresentationText(activeSlide.badge, REFERENCE_HERO_BADGE);
  const displayTitle = normalizeHeroPresentationText(activeSlide.title, REFERENCE_HERO_TITLE);
  const displayCta = normalizeHeroPresentationText(activeSlide.cta, REFERENCE_HERO_CTA);
  const displaySubtitle = normalizeHeroPresentationText(activeSlide.subtitle || activeSlide.description, MARKETPLACE_MESSAGE);
  const slideDuration = normalizeSlideSpeed(settings?.autoSlideSpeed) * 1000;
  const isSliderActive = settings?.enableSlider !== false;

  const liveProducts = useMemo(
    () => products.filter(product => isProductExplicitlyActive(product.isActive)),
    [products],
  );
  const customerProducts = useMemo(() => projectCustomerProducts(liveProducts), [liveProducts]);
  const popularCategories = useMemo(() => sortCategories(categories).slice(0, 6), [categories]);
  const visualCategories = useMemo(() => sortCategories(categories).slice(0, 5), [categories]);
  const visualProducts = useMemo(
    () => liveProducts.filter(product => Boolean(product.imageUrl)).slice(0, 2),
    [liveProducts],
  );
  const previewHeroProducts = previewPresentation?.categories
    .filter(category => category.art === 'mobile' || category.art === 'audio' || category.art === 'watch')
    .slice(0, 3) || [];
  const productSuggestions = useMemo(
    () => debouncedQuery.trim() ? searchCustomerProducts(customerProducts, debouncedQuery).slice(0, 5) : [],
    [customerProducts, debouncedQuery],
  );
  const categorySuggestions = useMemo(() => {
    const normalizedQuery = normalizeSearchText(debouncedQuery);
    if (!normalizedQuery) return [];
    return sortCategories(categories)
      .filter(category => normalizeSearchText(category.name).includes(normalizedQuery))
      .slice(0, 3);
  }, [categories, debouncedQuery]);
  const suggestionCount = productSuggestions.length + categorySuggestions.length;

  useEffect(() => {
    if (!isPlaying || !isSliderActive || slides.length < 2 || shouldReduceMotion) return;
    const intervalTime = 50;
    const step = (intervalTime / slideDuration) * 100;
    const timer = window.setInterval(() => {
      setProgress(previous => {
        if (previous >= 100) {
          setCurrentSlide(current => (current + 1) % slides.length);
          return 0;
        }
        return previous + step;
      });
    }, intervalTime);
    return () => window.clearInterval(timer);
  }, [isPlaying, isSliderActive, shouldReduceMotion, slideDuration, slides.length]);

  useEffect(() => {
    setCurrentSlide(current => Math.min(current, Math.max(0, slides.length - 1)));
    setProgress(0);
  }, [slides.length]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!searchShellRef.current?.contains(event.target as Node)) {
        setIsSearchOpen(false);
        setActiveSuggestion(-1);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const handlePrimaryAction = () => {
    const target = activeSlide.ctaUrl;
    if (!target || target === '/products') {
      onExploreProducts();
      return;
    }
    if (target === '/categories' && onBrowseCategories) {
      onBrowseCategories();
      return;
    }
    if (target.startsWith('/')) {
      window.location.assign(target);
      return;
    }
    window.open(target, '_blank', 'noopener,noreferrer');
  };

  const handleSearch = (event?: FormEvent) => {
    event?.preventDefault();
    const query = searchQuery.trim();
    setIsSearchOpen(false);
    setActiveSuggestion(-1);
    if (query && onSearch) onSearch(query);
    else onExploreProducts();
  };

  const selectProductSuggestion = (productId: string, productName: string) => {
    const product = liveProducts.find(item => item.id === productId);
    setSearchQuery(productName);
    setIsSearchOpen(false);
    if (product && onViewProduct) onViewProduct(product);
    else if (onSearch) onSearch(productName);
  };

  const selectCategorySuggestion = (category: Category) => {
    setSearchQuery(category.name);
    setIsSearchOpen(false);
    if (onSelectCategory) onSelectCategory(category.id);
    else onBrowseCategories?.();
  };

  const handleSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setIsSearchOpen(false);
      setActiveSuggestion(-1);
      return;
    }
    if (!isSearchOpen || suggestionCount === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveSuggestion(current => (current + 1) % suggestionCount);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveSuggestion(current => (current - 1 + suggestionCount) % suggestionCount);
    } else if (event.key === 'Enter' && activeSuggestion >= 0) {
      event.preventDefault();
      if (activeSuggestion < productSuggestions.length) {
        const product = productSuggestions[activeSuggestion];
        selectProductSuggestion(product.id, product.name);
      } else {
        const category = categorySuggestions[activeSuggestion - productSuggestions.length];
        if (category) selectCategorySuggestion(category);
      }
    }
  };

  const handleSlideSelect = (index: number) => {
    setCurrentSlide(index);
    setProgress(0);
  };

  const handlePrevious = () => handleSlideSelect((currentSlide - 1 + slides.length) % slides.length);
  const handleNext = () => handleSlideSelect((currentSlide + 1) % slides.length);

  const handleTouchStart = (event: TouchEvent) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
    setIsPlaying(false);
  };

  const handleTouchEnd = (event: TouchEvent) => {
    const startX = touchStartX.current;
    const endX = event.changedTouches[0]?.clientX;
    touchStartX.current = null;
    setIsPlaying(!shouldReduceMotion);
    if (startX === null || endX === undefined || Math.abs(startX - endX) < 48 || slides.length < 2) return;
    if (startX > endX) handleNext();
    else handlePrevious();
  };

  return (
    <MotionConfig reducedMotion="user">
      <section
        className="zy-hero-v2 zy-ai-hero"
        data-zy-reveal="immediate"
        aria-label="Zyro.lk Sri Lankan marketplace"
        onMouseEnter={() => setIsPlaying(false)}
        onMouseLeave={() => setIsPlaying(!shouldReduceMotion)}
        onFocusCapture={() => setIsPlaying(false)}
        onBlurCapture={() => setIsPlaying(!shouldReduceMotion)}
      >
        <div className={`zy-hero-v2-stage zy-ai-hero-stage${isReferencePreview ? ' is-reference-preview' : ''}`} onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
          <div className="zy-hero-v2-ambient zy-ai-hero-ambient" aria-hidden="true" />
          <AnimatePresence mode="wait">
            <motion.article
              key={activeSlide.id}
              className="zy-hero-v2-slide zy-ai-hero-slide"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.48, ease: 'easeOut' }}
              role="group"
              aria-roledescription="slide"
              aria-label={`${currentSlide + 1} of ${slides.length}: ${displayTitle || 'Marketplace campaign'}`}
            >
              <div className="zy-hero-v2-copy zy-ai-hero-copy">
                <div className="zy-hero-v2-copy-inner zy-ai-hero-copy-inner">
                  <div className="zy-hero-v2-kicker zy-ai-hero-kicker">
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                    {displayBadge}
                  </div>

                  <h1>
                    {displayTitle}
                  </h1>
                  <p className="zy-hero-v2-subtitle zy-ai-hero-subtitle">{displaySubtitle}</p>

                  {!isReferencePreview && <div className="zy-ai-hero-search-shell" ref={searchShellRef}>
                    <form className="zy-ai-hero-search" role="search" onSubmit={handleSearch}>
                      <Search className="zy-ai-hero-search-icon" aria-hidden="true" />
                      <label className="sr-only" htmlFor="homepage-hero-search">Search products, brands and categories</label>
                      <input
                        id="homepage-hero-search"
                        type="search"
                        value={searchQuery}
                        onChange={event => {
                          setSearchQuery(event.target.value);
                          setIsSearchOpen(true);
                          setActiveSuggestion(-1);
                        }}
                        onFocus={() => setIsSearchOpen(true)}
                        onKeyDown={handleSearchKeyDown}
                        placeholder="What are you looking for today?"
                        autoComplete="off"
                        aria-autocomplete="list"
                        aria-controls="homepage-hero-suggestions"
                        aria-expanded={isSearchOpen && suggestionCount > 0}
                        aria-activedescendant={activeSuggestion >= 0 ? `homepage-hero-suggestion-${activeSuggestion}` : undefined}
                      />
                      <div className="zy-ai-hero-search-tools">
                        <button type="submit" className="zy-ai-hero-search-submit" aria-label="Search marketplace">
                          <Search aria-hidden="true" />
                        </button>
                      </div>
                    </form>

                    <AnimatePresence>
                      {isSearchOpen && searchQuery.trim() && (
                        <motion.div
                          id="homepage-hero-suggestions"
                          className="zy-ai-hero-suggestions"
                          role="listbox"
                          aria-label="Search suggestions"
                          initial={{ opacity: 0, y: -6 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -4 }}
                        >
                          {suggestionCount > 0 ? (
                            <>
                              {productSuggestions.map((product, index) => (
                                <button
                                  key={product.id}
                                  id={`homepage-hero-suggestion-${index}`}
                                  type="button"
                                  role="option"
                                  aria-selected={activeSuggestion === index}
                                  className={activeSuggestion === index ? 'is-active' : ''}
                                  onMouseEnter={() => setActiveSuggestion(index)}
                                  onClick={() => selectProductSuggestion(product.id, product.name)}
                                >
                                  <span className="zy-ai-hero-suggestion-image">
                                    {product.image
                                      ? <img src={product.image} alt="" loading="lazy" decoding="async" />
                                      : <ShoppingBag aria-hidden="true" />}
                                  </span>
                                  <span><strong>{product.name}</strong><small>{product.brand || product.category}</small></span>
                                  <ArrowRight aria-hidden="true" />
                                </button>
                              ))}
                              {categorySuggestions.map((category, index) => {
                                const suggestionIndex = productSuggestions.length + index;
                                return (
                                  <button
                                    key={category.id}
                                    id={`homepage-hero-suggestion-${suggestionIndex}`}
                                    type="button"
                                    role="option"
                                    aria-selected={activeSuggestion === suggestionIndex}
                                    className={activeSuggestion === suggestionIndex ? 'is-active' : ''}
                                    onMouseEnter={() => setActiveSuggestion(suggestionIndex)}
                                    onClick={() => selectCategorySuggestion(category)}
                                  >
                                    <span className="zy-ai-hero-suggestion-image"><Layers3 aria-hidden="true" /></span>
                                    <span><strong>{category.name}</strong><small>Category</small></span>
                                    <ArrowRight aria-hidden="true" />
                                  </button>
                                );
                              })}
                            </>
                          ) : (
                            <div className="zy-ai-hero-search-empty">
                              <Search aria-hidden="true" />
                              <span><strong>No matching suggestions yet</strong><small>Press Enter to search the full catalogue.</small></span>
                            </div>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>}

                  <div className="zy-hero-v2-actions zy-ai-hero-actions">
                    <button type="button" onClick={handlePrimaryAction} className="zy-hero-v2-primary zy-ai-hero-primary">
                      <ShoppingBag className="h-5 w-5" aria-hidden="true" />
                      {displayCta || 'Shop Now'}
                    </button>
                    {!isReferencePreview && (
                      <button type="button" onClick={onBrowseCategories || onExploreProducts} className="zy-hero-v2-secondary zy-ai-hero-secondary">
                        Explore Categories
                        <ArrowRight className="h-5 w-5" aria-hidden="true" />
                      </button>
                    )}
                  </div>

                  {!isReferencePreview && popularCategories.length > 0 && (
                    <div className="zy-ai-hero-popular" aria-label="Explore popular categories">
                      <span>Popular categories</span>
                      <div>
                        {popularCategories.map(category => (
                          <button
                            key={category.id}
                            type="button"
                            onClick={() => onSelectCategory ? onSelectCategory(category.id) : onBrowseCategories?.()}
                          >
                            {category.name}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div
                className="zy-hero-v2-visual zy-ai-hero-visual"
                aria-label={isReferencePreview ? 'Marketplace collection artwork' : 'Live marketplace categories and products'}
              >
                {isReferencePreview ? (
                  <div className="zy-reference-hero-art" aria-label="Mobile, audio and smartwatch collections">
                    <span className="zy-reference-hero-art-orb is-large" aria-hidden="true" />
                    <span className="zy-reference-hero-art-orb is-small" aria-hidden="true" />
                    {previewHeroProducts.map(product => (
                      <span key={product.id} className={`zy-reference-hero-device is-${product.art}`}>
                        <HomepagePreviewProductArt art={product.art} tone={product.tone} />
                        <span className="sr-only">{product.name}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="zy-reference-hero-art is-live" aria-label="Live marketplace collections">
                    <span className="zy-reference-hero-art-orb is-large" aria-hidden="true" />
                    <span className="zy-reference-hero-art-orb is-small" aria-hidden="true" />
                    {activeSlide.image ? (
                      <div className="zy-reference-hero-cms-media">
                        <img
                          src={activeSlide.image}
                          alt=""
                          loading={currentSlide === 0 ? 'eager' : 'lazy'}
                          fetchPriority={currentSlide === 0 ? 'high' : 'low'}
                          decoding="async"
                          referrerPolicy="no-referrer"
                          aria-hidden="true"
                          onError={event => { event.currentTarget.hidden = true; }}
                        />
                      </div>
                    ) : visualProducts.length > 0 ? visualProducts.map((product, index) => (
                      <button
                        key={product.id}
                        type="button"
                        className={`zy-reference-hero-live-product is-${index + 1}`}
                        onClick={() => onViewProduct ? onViewProduct(product) : onExploreProducts()}
                        aria-label={`View ${product.name}`}
                      >
                        <img src={product.imageUrl} alt="" loading="lazy" decoding="async" />
                      </button>
                    )) : (
                      <div className="zy-reference-hero-live-empty">
                        <Store aria-hidden="true" />
                        <span><strong>Live collections</strong><small>Published products appear here automatically.</small></span>
                      </div>
                    )}
                    {visualCategories.length > 0 && (
                      <div className="zy-reference-hero-live-categories" aria-label="Available categories">
                        {visualCategories.slice(0, 3).map(category => (
                          <button
                            key={category.id}
                            type="button"
                            onClick={() => onSelectCategory ? onSelectCategory(category.id) : onBrowseCategories?.()}
                            aria-label={`Explore ${category.name}`}
                          >
                            {category.imageUrl
                              ? <img src={category.imageUrl} alt="" loading="lazy" decoding="async" />
                              : <Layers3 aria-hidden="true" />}
                            <span>{category.name}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </motion.article>
          </AnimatePresence>

          {isSliderActive && slides.length > 1 && (
            <div className="zy-ai-hero-slider-controls">
              <button type="button" onClick={handlePrevious} aria-label="Previous campaign">
                <ChevronLeft aria-hidden="true" />
              </button>
              <span>{currentSlide + 1} / {slides.length}</span>
              <button type="button" onClick={handleNext} aria-label="Next campaign">
                <ChevronRight aria-hidden="true" />
              </button>
            </div>
          )}

          <div className="zy-hero-v2-pagination zy-ai-hero-pagination" aria-label="Hero campaigns">
            {slides.map((slide, index) => (
              <button
                key={slide.id}
                type="button"
                onClick={() => handleSlideSelect(index)}
                className={index === currentSlide ? 'is-active' : ''}
                aria-label={`Show campaign ${index + 1} of ${slides.length}: ${normalizeHeroPresentationText(slide.title, REFERENCE_HERO_TITLE)}`}
                aria-current={index === currentSlide ? 'true' : undefined}
              >
                {index === currentSlide && isSliderActive && slides.length > 1 && <span style={{ width: `${Math.min(progress, 100)}%` }} />}
              </button>
            ))}
          </div>
        </div>

      </section>
    </MotionConfig>
  );
}
