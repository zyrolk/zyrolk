import { TouchEvent, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig, useReducedMotion } from 'motion/react';
import { ArrowRight, Banknote, ChevronLeft, ChevronRight, ShieldCheck, ShoppingBag, Sparkles, Store, Truck } from 'lucide-react';
import { Category, Product, WebsiteSettings } from '../types';
import { normalizeSlideSpeed } from '../services/hero-slider/heroSlider';

interface HeroBannerProps {
  onExploreProducts: () => void;
  onBrowseCategories?: () => void;
  settings?: WebsiteSettings | null;
  products?: readonly Product[];
  categories?: readonly Category[];
}

const MARKETPLACE_MESSAGE = 'Shop fashion, home, beauty, electronics, lifestyle, accessories and thousands of products in one trusted Sri Lankan marketplace.';
const PREMIUM_ELECTRONICS_PATTERN = /premium\s+electronics/giu;

const replacePremiumElectronics = (value: string, replacement: string): string =>
  value.replace(PREMIUM_ELECTRONICS_PATTERN, replacement).trim();

const isPromotionalBadge = (badge: string): boolean =>
  /\b(?:deal|discount|limited|offer|off|sale|save)\b/iu.test(badge);

const campaignTone = (value?: string): string => {
  if (value?.includes('orange')) return 'from-orange-950/90 via-blue-950/80 to-blue-900/45';
  if (value?.includes('emerald')) return 'from-emerald-950/90 via-blue-950/80 to-blue-900/45';
  if (value?.includes('purple')) return 'from-violet-950/90 via-blue-950/80 to-blue-900/45';
  return 'from-slate-950/92 via-blue-950/75 to-blue-900/32';
};

export default function HeroBanner({
  onExploreProducts,
  onBrowseCategories,
  settings,
}: HeroBannerProps) {
  const [currentSlide, setCurrentSlide] = useState(0);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const touchStartX = useRef<number | null>(null);
  const shouldReduceMotion = useReducedMotion();

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

  const slides = cmsSlides.length > 0 ? cmsSlides : [{
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
  const displayBadge = replacePremiumElectronics(activeSlide.badge, 'Marketplace offer');
  const displayTitle = replacePremiumElectronics(activeSlide.title, 'Marketplace Collection');
  const displayCta = replacePremiumElectronics(activeSlide.cta, 'Shop Marketplace');
  const displaySubtitle = MARKETPLACE_MESSAGE;
  const displayDescription = /\belectronics?\b/iu.test(activeSlide.description)
    ? ''
    : replacePremiumElectronics(activeSlide.description, 'marketplace products');
  const slideDuration = normalizeSlideSpeed(settings?.autoSlideSpeed) * 1000;
  const isSliderActive = settings?.enableSlider !== false;

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
        className="zy-hero-v2"
        data-zy-reveal
        aria-label="Featured marketplace campaigns"
        aria-roledescription="carousel"
        onMouseEnter={() => setIsPlaying(false)}
        onMouseLeave={() => setIsPlaying(!shouldReduceMotion)}
        onFocusCapture={() => setIsPlaying(false)}
        onBlurCapture={() => setIsPlaying(!shouldReduceMotion)}
      >
        <div className="zy-hero-v2-stage" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
          <div className="zy-hero-v2-ambient" aria-hidden="true" />
          <AnimatePresence mode="wait">
            <motion.article
              key={activeSlide.id}
              className="zy-hero-v2-slide"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.48, ease: 'easeOut' }}
              role="group"
              aria-roledescription="slide"
              aria-label={`${currentSlide + 1} of ${slides.length}: ${displayTitle || 'Marketplace campaign'}`}
            >
              <div className="zy-hero-v2-copy">
                <div className="zy-hero-v2-copy-inner">
                  <div className="zy-hero-v2-kicker">
                    <Store className="h-4 w-4" aria-hidden="true" />
                    Sri Lanka's trusted marketplace
                  </div>

                  <h1>Everything you need.<span>One trusted marketplace.</span></h1>

                  {displayTitle && <h2 className="zy-hero-v2-campaign-title">{displayTitle}</h2>}
                  <p className="zy-hero-v2-subtitle">{displaySubtitle}</p>
                  {displayDescription && <p className="zy-hero-v2-description">{displayDescription}</p>}

                  <div className="zy-hero-v2-actions">
                    <button type="button" onClick={handlePrimaryAction} className="zy-hero-v2-primary">
                      <ShoppingBag className="h-5 w-5" aria-hidden="true" />
                      {displayCta || 'Shop Now'}
                    </button>
                    <button type="button" onClick={onBrowseCategories || onExploreProducts} className="zy-hero-v2-secondary">
                      Browse Categories
                      <ArrowRight className="h-5 w-5" aria-hidden="true" />
                    </button>
                  </div>

                  <div className="zy-hero-v2-trust" aria-label="Shopping benefits">
                    <span><Banknote className="h-4 w-4" aria-hidden="true" />Cash on Delivery</span>
                    <span><Truck className="h-4 w-4" aria-hidden="true" />Islandwide Delivery</span>
                    <span><ShieldCheck className="h-4 w-4" aria-hidden="true" />Secure Shopping</span>
                  </div>
                </div>
              </div>

              <div className="zy-hero-v2-visual">
                <div className={`zy-hero-v2-visual-tone bg-gradient-to-br ${campaignTone(activeSlide.bgGradient)}`} aria-hidden="true" />
                <div className="zy-hero-v2-placeholder" aria-hidden={Boolean(activeSlide.image)}>
                  <span className="zy-hero-v2-placeholder-icon"><ShoppingBag className="h-10 w-10" aria-hidden="true" /></span>
                  <div>
                    <strong>A marketplace for every category</strong>
                    <small>Campaign artwork added in CMS will appear here automatically.</small>
                  </div>
                </div>
                {activeSlide.image && (
                  <img
                    src={activeSlide.image}
                    alt=""
                    className="zy-hero-v2-image"
                    loading={currentSlide === 0 ? 'eager' : 'lazy'}
                    fetchPriority={currentSlide === 0 ? 'high' : 'low'}
                    decoding="async"
                    referrerPolicy="no-referrer"
                    aria-hidden="true"
                    onError={(event) => { event.currentTarget.hidden = true; }}
                  />
                )}
                <div className="zy-hero-v2-image-shade" aria-hidden="true" />
                {displayBadge && (
                  <span className={isPromotionalBadge(displayBadge) ? 'zy-hero-v2-badge is-deal' : 'zy-hero-v2-badge'}>
                    <Sparkles className="h-4 w-4" aria-hidden="true" />
                    {displayBadge}
                  </span>
                )}
                {displayTitle && (
                  <div className="zy-hero-v2-visual-caption">
                    <span>Featured campaign</span>
                    <strong>{displayTitle}</strong>
                  </div>
                )}
              </div>
            </motion.article>
          </AnimatePresence>

          {isSliderActive && slides.length > 1 && (
            <>
              <button type="button" onClick={handlePrevious} className="zy-hero-v2-arrow is-left" aria-label="Previous slide">
                <ChevronLeft className="h-5 w-5" aria-hidden="true" />
              </button>
              <button type="button" onClick={handleNext} className="zy-hero-v2-arrow is-right" aria-label="Next slide">
                <ChevronRight className="h-5 w-5" aria-hidden="true" />
              </button>
            </>
          )}

          <div className="zy-hero-v2-pagination" aria-label="Hero slides">
            {slides.map((slide, index) => (
              <button
                key={slide.id}
                type="button"
                onClick={() => handleSlideSelect(index)}
                className={index === currentSlide ? 'is-active' : ''}
                aria-label={`Show slide ${index + 1} of ${slides.length}: ${replacePremiumElectronics(slide.title, 'Marketplace Collection') || 'Marketplace campaign'}`}
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
