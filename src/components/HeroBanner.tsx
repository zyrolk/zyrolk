import {
  CSSProperties,
  KeyboardEvent,
  TouchEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react';
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react';
import { Category, Product, WebsiteSettings } from '../types';
import { isProductExplicitlyActive } from '../services/storefront/productAvailability';
import {
  DEFAULT_HERO_FOCAL_POINT,
  HERO_IMAGE_CONTRACT,
  HeroCampaignSlide,
  compareHeroSlideOrder,
  isStructurallyValidHeroSlide,
  normalizeSlideSpeed,
  resolveHeroArtwork,
  toHeroCampaignSlide,
} from '../services/hero-slider/heroSlider';
import type { HomepagePreviewHero, HomepagePreviewPresentation } from '../services/storefront/homepagePreviewPresentation';
import {
  LAUNCH_HERO_BANNERS,
  pickLaunchHeroProducts,
  resolveLaunchHeroTarget,
  toLaunchHeroSlide,
} from '../services/storefront/launchMerchandising';
import { HomepagePreviewProductArt } from './HomepagePreviewProductCard';
import '../styles/launchMerchandising.css';

interface HeroBannerProps {
  onExploreProducts: () => void;
  onBrowseCategories?: () => void;
  onSelectCategory?: (categoryId: string) => void;
  /** Kept for API compatibility; search lives in the header. */
  onSearch?: (query: string) => void;
  onViewProduct?: (product: Product) => void;
  settings?: WebsiteSettings | null;
  /** True until the first `settings/website` snapshot resolves, so fallback slides never flash before CMS slides. */
  settingsLoading?: boolean;
  products?: readonly Product[];
  productsLoading?: boolean;
  /** Kept for API compatibility; category browsing lives below the hero. */
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
const HERO_PRODUCT_LIMIT = 5;
const SWIPE_THRESHOLD_PX = 48;
const SLIDE_EASE = [0.22, 1, 0.36, 1] as const;

const launchSlides: readonly HeroCampaignSlide[] = LAUNCH_HERO_BANNERS.map(toLaunchHeroSlide);

const replacePremiumElectronics = (value: string, replacement: string): string =>
  value.replace(PREMIUM_ELECTRONICS_PATTERN, replacement).trim();

const normalizeHeroPresentationText = (value: string | undefined, fallback: string): string => {
  const clean = replacePremiumElectronics(value || '', '').replace(/\s+/gu, ' ').trim();
  return !clean || LEGACY_HERO_COPY_PATTERN.test(clean) ? fallback : clean;
};

const isCampaignSlide = (slide: HeroCampaignSlide | HomepagePreviewHero): slide is HeroCampaignSlide =>
  'theme' in slide;

const slideVariants = {
  enter: (direction: number) => ({ opacity: 0, x: direction * 24 }),
  center: { opacity: 1, x: 0 },
  exit: (direction: number) => ({ opacity: 0, x: direction * -24 }),
};

export default function HeroBanner({
  onExploreProducts,
  onBrowseCategories,
  onSelectCategory,
  onViewProduct,
  settings,
  settingsLoading = false,
  products = [],
  productsLoading = false,
  previewPresentation = null,
}: HeroBannerProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [direction, setDirection] = useState(1);
  const [isPlaying, setIsPlaying] = useState(true);
  const touchStartX = useRef<number | null>(null);
  const remainingRef = useRef(0);
  const shouldReduceMotion = useReducedMotion();

  const configuredSlides = settings?.heroBanners?.filter(banner => banner.enabled !== false) || [];
  const cmsSlides = configuredSlides.map((banner, index) => toHeroCampaignSlide(banner, index))
    .filter(isStructurallyValidHeroSlide)
    .sort(compareHeroSlideOrder);
  const liveSlides = cmsSlides.length > 0 ? cmsSlides : launchSlides;

  const slides = previewPresentation?.hero ? [previewPresentation.hero, ...cmsSlides] : liveSlides;

  const activeSlide = slides[Math.min(currentSlide, slides.length - 1)];
  const isReferencePreview = Boolean(previewPresentation);
  const isLoadingSettings = settingsLoading && !isReferencePreview;
  const stage: HeroCampaignSlide = isCampaignSlide(activeSlide) ? activeSlide : {
    id: activeSlide.id,
    badge: activeSlide.badge,
    title: activeSlide.title,
    subtitle: activeSlide.subtitle,
    description: activeSlide.description,
    image: activeSlide.image,
    mobileImage: '',
    imageAlt: '',
    focalPointDesktop: DEFAULT_HERO_FOCAL_POINT,
    focalPointMobile: DEFAULT_HERO_FOCAL_POINT,
    theme: 'zyro',
    cta: activeSlide.cta,
    ctaUrl: activeSlide.ctaUrl,
    sortOrder: currentSlide,
    visualCategoryIds: [],
    visualOffset: 0,
  };
  const artwork = resolveHeroArtwork(stage);
  const displayBadge = normalizeHeroPresentationText(activeSlide.badge, REFERENCE_HERO_BADGE);
  const displayTitle = normalizeHeroPresentationText(activeSlide.title, REFERENCE_HERO_TITLE);
  const displayCta = normalizeHeroPresentationText(activeSlide.cta, REFERENCE_HERO_CTA);
  const displaySubtitle = normalizeHeroPresentationText(activeSlide.subtitle || activeSlide.description, MARKETPLACE_MESSAGE);
  const slideDuration = normalizeSlideSpeed(settings?.autoSlideSpeed) * 1000;
  const isSliderActive = settings?.enableSlider !== false;
  const hasMultipleSlides = isSliderActive && slides.length > 1;
  const canAutoplay = isPlaying && hasMultipleSlides && !shouldReduceMotion && !isLoadingSettings;

  const liveProducts = useMemo(
    () => products.filter(product => isProductExplicitlyActive(product.isActive)),
    [products],
  );
  const heroProducts = !isReferencePreview && !artwork.hasArtwork
    ? pickLaunchHeroProducts(liveProducts, stage.visualCategoryIds, HERO_PRODUCT_LIMIT, stage.visualOffset)
    : [];
  const previewHeroProducts = previewPresentation?.categories
    .filter(category => category.art === 'mobile' || category.art === 'audio' || category.art === 'watch')
    .slice(0, 3) || [];

  useEffect(() => {
    remainingRef.current = slideDuration;
  }, [currentSlide, slideDuration]);

  useEffect(() => {
    if (!canAutoplay) return;
    const startedAt = performance.now();
    const timer = window.setTimeout(() => {
      setDirection(1);
      setCurrentSlide(current => (current + 1) % slides.length);
    }, remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (performance.now() - startedAt));
    };
  }, [canAutoplay, currentSlide, slides.length]);

  useEffect(() => {
    setCurrentSlide(current => Math.min(current, Math.max(0, slides.length - 1)));
  }, [slides.length]);

  useEffect(() => {
    if (!hasMultipleSlides || isLoadingSettings) return;
    const next = slides[(currentSlide + 1) % slides.length];
    if (!isCampaignSlide(next)) return;
    const nextArtwork = resolveHeroArtwork(next);
    if (!nextArtwork.hasArtwork) return;
    const image = new Image();
    image.decoding = 'async';
    image.src = window.matchMedia('(max-width: 767px)').matches ? nextArtwork.mobile : nextArtwork.desktop;
  }, [currentSlide, hasMultipleSlides, isLoadingSettings, slides]);

  const handlePrimaryAction = () => {
    const target = activeSlide.ctaUrl;
    const destination = resolveLaunchHeroTarget(target);
    if (destination.kind === 'products') {
      onExploreProducts();
      return;
    }
    if (destination.kind === 'categories') {
      (onBrowseCategories || onExploreProducts)();
      return;
    }
    if (destination.kind === 'category' && onSelectCategory) {
      onSelectCategory(destination.categoryId);
      return;
    }
    if (destination.kind !== 'external') {
      window.location.assign(target);
      return;
    }
    window.open(destination.url, '_blank', 'noopener,noreferrer');
  };

  const handleSlideSelect = (index: number, nextDirection = index >= currentSlide ? 1 : -1) => {
    setDirection(nextDirection);
    setCurrentSlide(index);
  };

  const handlePrevious = () => handleSlideSelect((currentSlide - 1 + slides.length) % slides.length, -1);
  const handleNext = () => handleSlideSelect((currentSlide + 1) % slides.length, 1);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!hasMultipleSlides) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      handlePrevious();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      handleNext();
    }
  };

  const handleTouchStart = (event: TouchEvent) => {
    touchStartX.current = event.touches[0]?.clientX ?? null;
    setIsPlaying(false);
  };

  const handleTouchEnd = (event: TouchEvent) => {
    const startX = touchStartX.current;
    const endX = event.changedTouches[0]?.clientX;
    touchStartX.current = null;
    setIsPlaying(true);
    if (startX === null || endX === undefined || Math.abs(startX - endX) < SWIPE_THRESHOLD_PX || !hasMultipleSlides) return;
    if (startX > endX) handleNext();
    else handlePrevious();
  };

  if (isLoadingSettings) {
    return (
      <section className="zy-campaign-hero" data-zy-reveal="immediate" aria-label="Zyro.lk Sri Lankan marketplace" aria-busy="true">
        <div className="zy-campaign-hero-stage is-loading">
          <div className="zy-campaign-hero-skeleton" aria-hidden="true">
            <span className="is-badge" />
            <span className="is-title" />
            <span className="is-title is-short" />
            <span className="is-text" />
            <span className="is-cta" />
          </div>
        </div>
      </section>
    );
  }

  const slideStyle = {
    '--zy-ch-focal-desktop': stage.focalPointDesktop,
    '--zy-ch-focal-mobile': stage.focalPointMobile,
  } as CSSProperties;

  return (
    <MotionConfig reducedMotion="user">
      <section
        className="zy-campaign-hero"
        data-zy-reveal="immediate"
        aria-roledescription="carousel"
        aria-label="Zyro.lk Sri Lankan marketplace"
        onMouseEnter={() => setIsPlaying(false)}
        onMouseLeave={() => setIsPlaying(true)}
        onFocusCapture={() => setIsPlaying(false)}
        onBlurCapture={() => setIsPlaying(true)}
        onKeyDown={handleKeyDown}
      >
        <div
          className="zy-campaign-hero-stage"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <AnimatePresence initial={false} custom={direction}>
            <motion.article
              key={activeSlide.id}
              className="zy-campaign-hero-slide"
              data-theme={stage.theme}
              data-artwork={artwork.hasArtwork ? 'true' : 'false'}
              style={slideStyle}
              custom={direction}
              variants={slideVariants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: 0.6, ease: SLIDE_EASE }}
              role="group"
              aria-roledescription="slide"
              aria-label={`${currentSlide + 1} of ${slides.length}: ${displayTitle}`}
            >
              <motion.div
                className="zy-campaign-hero-visual"
                initial={{ scale: 1, x: 0 }}
                animate={shouldReduceMotion ? { scale: 1, x: 0 } : { scale: 1.045, x: -8 }}
                transition={{ duration: slideDuration / 1000 + 0.8, ease: 'linear' }}
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
                ) : artwork.hasArtwork ? (
                  <picture className="zy-campaign-hero-artwork">
                    <source
                      media="(max-width: 767px)"
                      srcSet={artwork.mobile}
                      width={HERO_IMAGE_CONTRACT.mobile.width}
                      height={HERO_IMAGE_CONTRACT.mobile.height}
                    />
                    <img
                      src={artwork.desktop}
                      alt={stage.imageAlt || displayTitle}
                      width={HERO_IMAGE_CONTRACT.desktop.width}
                      height={HERO_IMAGE_CONTRACT.desktop.height}
                      loading={currentSlide === 0 ? 'eager' : 'lazy'}
                      fetchPriority={currentSlide === 0 ? 'high' : 'low'}
                      decoding="async"
                      referrerPolicy="no-referrer"
                      onError={event => { event.currentTarget.hidden = true; }}
                    />
                  </picture>
                ) : heroProducts.length > 0 ? (
                  <div className="zy-campaign-hero-products" data-count={heroProducts.length}>
                    {heroProducts.map((product, index) => (
                      <button
                        key={product.id}
                        type="button"
                        className="zy-campaign-hero-product"
                        onClick={() => onViewProduct ? onViewProduct(product) : onExploreProducts()}
                        aria-label={`View ${product.name}`}
                        tabIndex={-1}
                      >
                        <img
                          src={product.imageUrl}
                          alt=""
                          width={480}
                          height={480}
                          loading={currentSlide === 0 && index === 0 ? 'eager' : 'lazy'}
                          fetchPriority={currentSlide === 0 && index === 0 ? 'high' : 'low'}
                          decoding="async"
                          referrerPolicy="no-referrer"
                        />
                      </button>
                    ))}
                  </div>
                ) : productsLoading ? (
                  <div className="zy-campaign-hero-products is-loading" data-count={3} aria-hidden="true">
                    <span /><span /><span />
                  </div>
                ) : (
                  <div className="zy-campaign-hero-shapes" aria-hidden="true"><span /><span /><span /></div>
                )}
              </motion.div>

              <motion.div
                className="zy-campaign-hero-copy"
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, delay: 0.12, ease: 'easeOut' }}
              >
                <span className="zy-campaign-hero-badge">{displayBadge}</span>
                <h1>{displayTitle}</h1>
                <p className="zy-campaign-hero-subtitle">{displaySubtitle}</p>
                <button type="button" onClick={handlePrimaryAction} className="zy-campaign-hero-cta">
                  {displayCta || 'Shop Now'}
                  <ArrowRight aria-hidden="true" />
                </button>
              </motion.div>
            </motion.article>
          </AnimatePresence>

          {hasMultipleSlides && (
            <>
              <div className="zy-campaign-hero-arrows">
                <button type="button" onClick={handlePrevious} aria-label="Previous slide">
                  <ChevronLeft aria-hidden="true" />
                </button>
                <button type="button" onClick={handleNext} aria-label="Next slide">
                  <ChevronRight aria-hidden="true" />
                </button>
              </div>
              <div className="zy-campaign-hero-dots" role="group" aria-label="Choose slide">
                {slides.map((slide, index) => (
                  <button
                    key={slide.id}
                    type="button"
                    onClick={() => handleSlideSelect(index)}
                    className={index === currentSlide ? 'is-active' : ''}
                    aria-label={`Show slide ${index + 1} of ${slides.length}: ${normalizeHeroPresentationText(slide.title, REFERENCE_HERO_TITLE)}`}
                    aria-current={index === currentSlide ? 'true' : undefined}
                  >
                    {index === currentSlide && !shouldReduceMotion && (
                      <span
                        key={`${slide.id}-${currentSlide}`}
                        className="zy-campaign-hero-progress"
                        style={{ animationDuration: `${slideDuration}ms`, animationPlayState: canAutoplay ? 'running' : 'paused' }}
                      />
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
    </MotionConfig>
  );
}
