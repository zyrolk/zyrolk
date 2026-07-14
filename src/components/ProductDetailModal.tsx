import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  X, Star, Heart, ShoppingCart, Check, Phone, 
  Truck, MessageSquare, ArrowRight, Plus, Minus, ShoppingBag,
  ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Maximize2, Sparkles, CheckCircle2, HelpCircle,
  Banknote, Headphones, LockKeyhole
} from 'lucide-react';
import { collection, query, where, getDocs, addDoc } from 'firebase/firestore';
import { onAuthStateChanged } from 'firebase/auth';
import { db, auth } from '../firebase';
import { Product, WebsiteSettings } from '../types';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  LatestRequestGate, PRODUCT_IMAGE_FALLBACK, ProductReviewView, SubmissionGuard, buildProductGallery,
  calculateReviewSummary, clampGalleryIndex, getDialogEscapeAction, getFocusWrapIndex, groupProductSpecifications,
  nextGalleryIndexForKey, projectProductReview, selectRelatedProducts,
} from '../features/product-experience/productExperience';
import ProductSpecificationsPanel from '../features/product-experience/ProductSpecificationsPanel';
import RelatedProductsRail from '../features/product-experience/RelatedProductsRail';

interface ProductDetailModalProps {
  product: Product | null;
  isOpen: boolean;
  onClose: () => void;
  isWishlisted: boolean;
  onAddToCart: (product: Product, quantity?: number) => void;
  onToggleWishlist: (product: Product) => void;
  allProducts: Product[];
  onSelectProduct: (product: Product) => void;
  onBuyNow: (product: Product, quantity: number) => void;
  settings?: WebsiteSettings | null;
}

export default function ProductDetailModal({
  product,
  isOpen,
  onClose,
  isWishlisted,
  onAddToCart,
  onToggleWishlist,
  allProducts = [],
  onSelectProduct,
  onBuyNow,
  settings
}: ProductDetailModalProps) {
  const isWishlistEnabled = settings?.enableWishlist !== false;
  const isReviewsEnabled = settings?.enableReviews !== false;

  // Swipeable image gallery states
  const [activeImageIndex, setActiveImageIndex] = useState(0);
  const [touchStartX, setTouchStartX] = useState(0);
  const [touchEndX, setTouchEndX] = useState(0);

  // Layout states
  const [quantity, setQuantity] = useState(1);
  const [addedMessage, setAddedMessage] = useState(false);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [showStickyBar, setShowStickyBar] = useState(false);
  
  // Hover zoom states (Desktop)
  const [zoomPos, setZoomPos] = useState({ x: 0, y: 0 });
  const [isZooming, setIsZooming] = useState(false);

  // Full-screen zoom lightbox states (Tap/Click)
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [lightboxZoom, setLightboxZoom] = useState(1);
  const [lightboxPan, setLightboxPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Reviews & settings states
  const [reviews, setReviews] = useState<ProductReviewView[]>([]);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [reviewError, setReviewError] = useState('');
  const [visibleReviewCount, setVisibleReviewCount] = useState(4);
  const [newRating, setNewRating] = useState(5);
  const [newComment, setNewComment] = useState("");
  const [newCustomerName, setNewCustomerName] = useState("");
  const [reviewSuccess, setReviewSuccess] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [announcement, setAnnouncement] = useState('');
  const prefersReducedMotion = useReducedMotion();

  // Refs
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const stickySentinelRef = useRef<HTMLDivElement>(null);
  const relatedScrollRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const lightboxRef = useRef<HTMLDivElement>(null);
  const lightboxCloseButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const galleryButtonRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedElementRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const isLightboxOpenRef = useRef(isLightboxOpen);
  const requestGateRef = useRef(new LatestRequestGate());
  const submissionGuardRef = useRef(new SubmissionGuard());
  const feedbackTimerRef = useRef<number | null>(null);
  const galleryImages = useMemo(() => product ? buildProductGallery(product) : [], [product]);
  const galleryImageCountRef = useRef(galleryImages.length);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    isLightboxOpenRef.current = isLightboxOpen;
  }, [isLightboxOpen]);

  useEffect(() => {
    galleryImageCountRef.current = galleryImages.length;
  }, [galleryImages.length]);

  useEffect(() => {
    if (!isOpen) return;

    previouslyFocusedElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    const handleDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (getDialogEscapeAction(isLightboxOpenRef.current) === 'close-lightbox') {
          setIsLightboxOpen(false);
          setLightboxZoom(1);
          setLightboxPan({ x: 0, y: 0 });
          window.requestAnimationFrame(() => galleryButtonRef.current?.focus());
        } else {
          onCloseRef.current();
        }
        return;
      }

      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      const galleryImageCount = galleryImageCountRef.current;
      if (!isTyping && galleryImageCount > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        setActiveImageIndex((current) => nextGalleryIndexForKey(event.key, current, galleryImageCount));
      }

      const activeFocusRoot = isLightboxOpenRef.current ? lightboxRef.current : modalRef.current;
      if (event.key === 'Tab' && activeFocusRoot) {
        const focusable = (Array.from(activeFocusRoot.querySelectorAll(
          'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )) as HTMLElement[]).filter((element) => element.offsetParent !== null);
        if (focusable.length === 0) return;
        const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
        const wrapIndex = getFocusWrapIndex(event.shiftKey, activeIndex, focusable.length);
        if (wrapIndex !== null) {
          event.preventDefault();
          focusable[wrapIndex].focus();
        }
      }
    };

    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleDialogKeyDown);
      previouslyFocusedElementRef.current?.focus();
    };
  }, [isOpen]);

  useEffect(() => {
    if (isLightboxOpen) window.requestAnimationFrame(() => lightboxCloseButtonRef.current?.focus());
  }, [isLightboxOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousOverflow; };
  }, [isOpen]);

  useEffect(() => () => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
  }, []);

  // Listen to Auth State
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      if (user) {
        setNewCustomerName(user.displayName || user.email?.split('@')[0] || "");
      } else {
        setNewCustomerName("");
      }
    });
    return () => unsubscribe();
  }, []);

  // Fetch product reviews from Firestore
  const fetchReviews = async () => {
    if (!product) return;
    const requestId = requestGateRef.current.begin();
    setLoadingReviews(true);
    setReviewError('');
    try {
      const q = query(collection(db, "reviews"), where("productId", "==", product.id));
      const snap = await getDocs(q);
      const list: ProductReviewView[] = [];
      snap.forEach(d => {
        const data = d.data();
        if (data.approved !== false) {
          const review = projectProductReview(d.id, data);
          if (review) list.push(review);
        }
      });
      list.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeB - timeA;
      });
      if (requestGateRef.current.isLatest(requestId)) setReviews(list);
      
    } catch (err) {
      console.error("Error loading reviews:", err);
      if (requestGateRef.current.isLatest(requestId)) setReviewError('Reviews could not be loaded. Please try again.');
    } finally {
      if (requestGateRef.current.isLatest(requestId)) setLoadingReviews(false);
    }
  };

  // Reset page states when switching active products
  useEffect(() => {
    if (product) {
      setActiveImageIndex(0);
      setQuantity(1);
      setAddedMessage(false);
      setNewComment("");
      setNewRating(5);
      setShowStickyBar(false);
      setVisibleReviewCount(4);
      setReviewError('');
      
      setIsTransitioning(!prefersReducedMotion);
      const timer = window.setTimeout(() => setIsTransitioning(false), prefersReducedMotion ? 0 : 220);
      
      if (isReviewsEnabled) fetchReviews();
      else setReviews([]);
      return () => clearTimeout(timer);
    }
  }, [product, prefersReducedMotion, isReviewsEnabled]);

  useEffect(() => {
    setActiveImageIndex((current) => clampGalleryIndex(current, galleryImages.length));
  }, [galleryImages.length]);

  useEffect(() => {
    if (!isOpen || !stickySentinelRef.current || !scrollContainerRef.current) return;
    const observer = new IntersectionObserver(([entry]) => setShowStickyBar(!entry.isIntersecting), {
      root: scrollContainerRef.current,
      threshold: 0,
    });
    observer.observe(stickySentinelRef.current);
    return () => observer.disconnect();
  }, [isOpen, product?.id]);

  useEffect(() => {
    if (!product) return;
    const maxQuantity = Math.max(1, Math.trunc(product.stock));
    setQuantity((current) => Math.min(Math.max(1, current), maxQuantity));
  }, [product?.id, product?.stock]);

  const reviewSummary = useMemo(() => calculateReviewSummary(reviews, product?.rating || 0), [reviews, product?.rating]);
  const relatedItems = useMemo(() => product ? selectRelatedProducts(product, allProducts) : [], [product, allProducts]);
  const specificationGroups = useMemo(() => groupProductSpecifications(product?.specs), [product?.specs]);

  if (!isOpen || !product) return null;

  // LKR formatting
  const formatPrice = (amount: number) => {
    return new Intl.NumberFormat('en-LK', {
      style: 'currency',
      currency: 'LKR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0
    }).format(amount);
  };

  // Swipe gesture handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    const startX = e.targetTouches[0].clientX;
    setTouchStartX(startX);
    setTouchEndX(startX);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    setTouchEndX(e.targetTouches[0].clientX);
  };

  const handleTouchEnd = () => {
    if (galleryImages.length <= 1) return;
    const swipeDistance = touchStartX - touchEndX;
    if (swipeDistance > 60) {
      // Swipe left -> Next image
      setActiveImageIndex((prev) => (prev + 1) % galleryImages.length);
    } else if (swipeDistance < -60) {
      // Swipe right -> Prev image
      setActiveImageIndex((prev) => (prev - 1 + galleryImages.length) % galleryImages.length);
    }
  };

  const handleAddToCart = () => {
    if (product.isActive === false || product.stock <= 0) return;
    onAddToCart(product, quantity);
    setAddedMessage(true);
    setAnnouncement(`${quantity} ${product.name} added to cart.`);
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    feedbackTimerRef.current = window.setTimeout(() => setAddedMessage(false), 2000);
  };

  const handleWhatsAppCheckout = () => {
    // TODO(security): add noopener/noreferrer when WhatsApp window handling is updated consistently.
    const totalPrice = formatPrice(product.price * quantity);
    const skuLine = product.sku ? `\n*SKU:* ${product.sku}` : "";
    const message = encodeURIComponent(
      `Hello Zyro.lk! I want to order the following genuine device:\n\n*Product:* ${product.name}${skuLine}\n*Quantity:* ${quantity}\n*Unit Price:* ${formatPrice(product.price)}\n*Total Price:* ${totalPrice}\n\nPlease proceed with my COD islandwide delivery confirmation details.`
    );
    const whatsappNum = settings?.whatsappNumber 
      ? settings.whatsappNumber.replace(/[^0-9+]/g, "") 
      : "";
    if (!whatsappNum) {
      alert("WhatsApp checkout is currently being configured by the store administrator. Please try again soon or contact support!");
      return;
    }
    window.open(`https://wa.me/${whatsappNum.replace("+", "")}?text=${message}`, '_blank');
  };

  const handleWhatsAppEnquiry = () => {
    const skuLine = product.sku ? `\n*SKU:* ${product.sku}` : "";
    const message = encodeURIComponent(
      `Hello Zyro.lk! I am interested in this product but it is currently out of stock:\n\n*Product:* ${product.name}${skuLine}\n*Price:* ${formatPrice(product.price)}\n\nPlease notify me when it is back in stock or suggest an alternative!`
    );
    const whatsappNum = settings?.whatsappNumber 
      ? settings.whatsappNumber.replace(/[^0-9+]/g, "") 
      : "";
    if (!whatsappNum) {
      alert("WhatsApp support is currently being configured by the store administrator. Please try again soon!");
      return;
    }
    window.open(`https://wa.me/${whatsappNum.replace("+", "")}?text=${message}`, '_blank');
  };

  const handleSubmitReview = async (e: React.FormEvent) => {
    // TODO(security): review moderation belongs in a trusted backend workflow.
    // TODO(security): purchase verification must be implemented server-side before reviews are labelled as verified purchases.
    e.preventDefault();
    if (!product) return;
    if (!submissionGuardRef.current.begin()) return;

    const trimmedComment = newComment.trim();
    const trimmedName = newCustomerName.trim() || currentUser?.displayName || currentUser?.email?.split('@')[0] || "Authenticated Customer";

    if (!currentUser) {
      alert("Please log in before submitting a review.");
      submissionGuardRef.current.end();
      return;
    }

    if (!trimmedComment) {
      alert("Please write a comment for your review.");
      submissionGuardRef.current.end();
      return;
    }

    if (!trimmedName) {
      alert("Please provide your name.");
      submissionGuardRef.current.end();
      return;
    }

    setIsSubmitting(true);
    setReviewSuccess(false);
    setReviewError('');
    try {
      const payload = {
        productId: product.id,
        userId: currentUser.uid,
        customerName: trimmedName,
        userName: trimmedName, // backwards compatibility
        rating: newRating,
        comment: trimmedComment,
        createdAt: new Date().toISOString()
      };

      // 1. Save review to Firestore in collection "reviews"
      await addDoc(collection(db, "reviews"), payload);

      // 2. Fetch all reviews for this product to compute updated stats
      const q = query(collection(db, "reviews"), where("productId", "==", product.id));
      const snap = await getDocs(q);
      const list: ProductReviewView[] = [];
      snap.forEach(d => {
        const data = d.data();
        if (data.approved !== false) {
          const review = projectProductReview(d.id, data);
          if (review) list.push(review);
        }
      });

      // Clear the form
      setNewComment("");
      setNewRating(5);
      setReviewSuccess(true);
      setAnnouncement('Review submitted successfully.');

      // Fetch reviews again locally
      setReviews(list.sort((a, b) => {
        const timeA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const timeB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return timeB - timeA;
      }));

      // Hide success message after 4 seconds
      setTimeout(() => setReviewSuccess(false), 4000);
    } catch (err) {
      console.error("Error saving review:", err);
      setReviewError('Your review could not be submitted. Please try again.');
    } finally {
      setIsSubmitting(false);
      submissionGuardRef.current.end();
    }
  };

  // Hover zoom handler (Desktop)
  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const { left, top, width, height } = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - left) / width) * 100;
    const y = ((e.clientY - top) / height) * 100;
    setZoomPos({ x, y });
  };

  // Lightbox navigation
  const nextLightboxImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveImageIndex((prev) => (prev + 1) % galleryImages.length);
    setLightboxZoom(1);
    setLightboxPan({ x: 0, y: 0 });
  };

  const prevLightboxImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    setActiveImageIndex((prev) => (prev - 1 + galleryImages.length) % galleryImages.length);
    setLightboxZoom(1);
    setLightboxPan({ x: 0, y: 0 });
  };

  // Lightbox Pan / Drag logic
  const handleLightboxMouseDown = (e: React.MouseEvent) => {
    if (lightboxZoom > 1) {
      setIsDragging(true);
      setDragStart({ x: e.clientX - lightboxPan.x, y: e.clientY - lightboxPan.y });
    }
  };

  const handleLightboxMouseMove = (e: React.MouseEvent) => {
    if (isDragging && lightboxZoom > 1) {
      setLightboxPan({
        x: e.clientX - dragStart.x,
        y: e.clientY - dragStart.y
      });
    }
  };

  const handleLightboxMouseUp = () => {
    setIsDragging(false);
  };

  const handleLightboxClose = () => {
    setIsLightboxOpen(false);
    setLightboxZoom(1);
    setLightboxPan({ x: 0, y: 0 });
    window.requestAnimationFrame(() => galleryButtonRef.current?.focus());
  };

  const handleZoomIn = () => {
    setLightboxZoom(prev => Math.min(prev + 0.5, 4));
  };

  const handleZoomOut = () => {
    setLightboxZoom(prev => {
      const next = Math.max(prev - 0.5, 1);
      if (next === 1) setLightboxPan({ x: 0, y: 0 });
      return next;
    });
  };

  // Related products scroll
  const scrollRelated = (direction: 'left' | 'right') => {
    if (relatedScrollRef.current) {
      const { scrollLeft, clientWidth } = relatedScrollRef.current;
      const scrollAmount = clientWidth * 0.8;
      relatedScrollRef.current.scrollTo({
        left: direction === 'left' ? scrollLeft - scrollAmount : scrollLeft + scrollAmount,
        behavior: prefersReducedMotion ? 'auto' : 'smooth'
      });
    }
  };

  // Reviews visual statistics helper
  const totalReviews = reviewSummary.count;
  const averageRating = reviewSummary.average.toFixed(1);
  const ratingDistribution = reviewSummary.distribution;

  // Specifications list construction
  const brandName = product.specs?.Brand || product.specs?.brand || "Authorized Import";
  const activeImageUrl = galleryImages[activeImageIndex] || product.imageUrl;

  // Filter out current product for related items

  // Delivery Threshold values
  const freeDeliveryThreshold = settings?.freeDeliveryMin || 5000;
  const isEligibleForFreeDelivery = product.price >= freeDeliveryThreshold;

  // Smooth scroll to reviews panel
  const scrollToReviews = () => {
    const reviewsElement = document.getElementById('customer-reviews-section');
    if (reviewsElement && scrollContainerRef.current) {
      reviewsElement.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'start' });
    }
  };

  return (
    <div
      ref={modalRef}
      className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/70 backdrop-blur-xl flex items-center justify-center p-0 sm:p-4 md:p-6 animate-fadeIn"
      role="dialog"
      aria-modal="true"
      aria-labelledby="product-detail-title"
    >
      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      
      {/* Immersive Apple/Samsung-style Premium Modal Layout */}
      <div className="relative w-full max-w-6xl bg-white sm:rounded-[2.5rem] overflow-hidden shadow-[0_25px_60px_-15px_rgba(0,0,0,0.25)] border border-slate-100 flex flex-col min-h-screen sm:min-h-0 sm:h-[94vh]">
        
        {/* Top Header Sticky Rail */}
        <div className="absolute top-0 left-0 right-0 z-40 p-4 sm:p-6 flex justify-between items-center bg-gradient-to-b from-white/95 via-white/80 to-transparent pointer-events-none">
          <div className="pointer-events-auto bg-white/90 backdrop-blur-md border border-slate-100 px-4 py-2 rounded-full shadow-xs flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-brand-blue animate-pulse" />
            <span className="text-[10px] font-black text-slate-800 uppercase tracking-widest">
              Live Showcase
            </span>
          </div>
          
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="pointer-events-auto p-3 text-slate-600 hover:text-slate-950 bg-white/95 hover:bg-slate-100 border border-slate-200 rounded-full transition-all cursor-pointer shadow-md active:scale-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
            id="product-modal-close-btn"
            aria-label={`Close details for ${product.name}`}
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Container with Observer */}
        <div 
          id="modal-scrollable-container" 
          ref={scrollContainerRef}
          className="flex-1 overflow-y-auto pt-24 p-5 sm:p-8 md:p-12 space-y-16 scroll-smooth"
        >
          <div ref={stickySentinelRef} className="h-px w-full" aria-hidden="true" />
          {isTransitioning ? (
            /* Premium Micro Loading Skeleton Screen */
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 animate-pulse pt-4">
              <div className="lg:col-span-6 space-y-6">
                <div className="aspect-square w-full rounded-3xl bg-slate-100" />
                <div className="flex space-x-3">
                  <div className="w-20 h-20 bg-slate-100 rounded-2xl" />
                  <div className="w-20 h-20 bg-slate-100 rounded-2xl" />
                  <div className="w-20 h-20 bg-slate-100 rounded-2xl" />
                </div>
              </div>
              <div className="lg:col-span-6 space-y-6 text-left">
                <div className="h-4 bg-slate-100 rounded-md w-1/4" />
                <div className="h-10 bg-slate-100 rounded-xl w-3/4" />
                <div className="h-6 bg-slate-100 rounded-md w-1/3" />
                <div className="h-28 bg-slate-100 rounded-3xl w-full" />
                <div className="h-14 bg-slate-100 rounded-2xl w-full" />
                <div className="h-14 bg-slate-100 rounded-2xl w-full" />
              </div>
            </div>
          ) : (
            <>
              {/* UPPER MAIN LAYOUT SECTION */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 lg:gap-14 items-start">
                
                {/* LEFT SIDE: MULTI-IMAGE CAROUSEL, THUMBNAILS, SPECIFICATIONS & TRUST RAILS */}
                <div className="lg:col-span-6 space-y-8">
                  
                  {/* Premium Slider Container */}
                  <div className="space-y-4">
                    <div 
                      ref={galleryButtonRef}
                      className="relative aspect-square w-full rounded-3xl bg-gradient-to-br from-slate-50 via-white to-blue-50/40 border border-slate-200/80 overflow-hidden select-none group/zoom shadow-sm cursor-zoom-in focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                      onTouchStart={handleTouchStart}
                      onTouchMove={handleTouchMove}
                      onTouchEnd={handleTouchEnd}
                      onClick={() => setIsLightboxOpen(true)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setIsLightboxOpen(true);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                      aria-label={`Open image viewer for ${product.name}. Image ${activeImageIndex + 1} of ${galleryImages.length}.`}
                    >
                      {/* Swipe instructions helper */}
                      {galleryImages.length > 1 && (
                        <div className="absolute top-4 right-4 z-10 bg-slate-900/60 backdrop-blur-md text-white text-[9px] font-extrabold uppercase tracking-widest px-3 py-1.5 rounded-full pointer-events-none">
                          Swipe to view {activeImageIndex + 1}/{galleryImages.length}
                        </div>
                      )}
                      <div className="absolute left-4 top-4 z-10 rounded-full bg-white/90 px-3 py-1.5 text-[10px] font-black text-slate-700 shadow-sm" aria-live="polite">
                        Image {activeImageIndex + 1} of {galleryImages.length}
                      </div>

                      {/* Frame Zoom on Hover (Desktop) */}
                      <div 
                        className="w-full h-full flex items-center justify-center p-6 sm:p-10"
                        onMouseEnter={() => setIsZooming(true)}
                        onMouseLeave={() => setIsZooming(false)}
                        onMouseMove={handleMouseMove}
                      >
                        <motion.img
                          key={activeImageIndex}
                          initial={{ opacity: 0.6, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          transition={{ duration: 0.3 }}
                          src={activeImageUrl}
                          alt={product.name}
                          referrerPolicy="no-referrer"
                          loading="eager"
                          decoding="async"
                          onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = PRODUCT_IMAGE_FALLBACK; }}
                          className="max-h-full max-w-full object-contain transition-transform duration-75 ease-out"
                          style={
                            isZooming 
                              ? {
                                  transform: 'scale(2.4)',
                                  transformOrigin: `${zoomPos.x}% ${zoomPos.y}%`
                                }
                              : undefined
                          }
                        />
                      </div>

                      {/* Direct Save Discount Float */}
                      {product.discount && product.discount > 0 && (
                        <div className="absolute bottom-4 left-4 z-10 bg-brand-blue text-white text-[10px] font-black uppercase tracking-widest px-3.5 py-2 rounded-xl shadow-lg shadow-brand-blue/20">
                          -{product.discount}% INTRODUCTORY OFFER
                        </div>
                      )}

                      {/* Left and Right Nav Chevrons */}
                      {galleryImages.length > 1 && (
                        <>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveImageIndex((prev) => (prev - 1 + galleryImages.length) % galleryImages.length);
                            }}
                            className="absolute left-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/95 text-slate-800 hover:bg-white border border-slate-200 shadow-md transition-all opacity-100 sm:opacity-0 sm:group-hover/zoom:opacity-100 cursor-pointer hover:scale-105 active:scale-95 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                            aria-label="Show previous product image"
                          >
                            <ChevronLeft className="h-5 w-5" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveImageIndex((prev) => (prev + 1) % galleryImages.length);
                            }}
                            className="absolute right-4 top-1/2 -translate-y-1/2 p-3 rounded-full bg-white/95 text-slate-800 hover:bg-white border border-slate-200 shadow-md transition-all opacity-100 sm:opacity-0 sm:group-hover/zoom:opacity-100 cursor-pointer hover:scale-105 active:scale-95 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                            aria-label="Show next product image"
                          >
                            <ChevronRight className="h-5 w-5" />
                          </button>
                        </>
                      )}

                      {/* Magnifier Tip overlay */}
                      <div className="absolute bottom-4 right-4 bg-slate-950/70 backdrop-blur-md text-white text-[10px] font-bold px-3 py-1.5 rounded-full opacity-100 sm:opacity-0 group-hover/zoom:opacity-100 transition-opacity flex items-center gap-1.5 shadow-md">
                        <Maximize2 className="h-3 w-3" />
                        <span>Tap to zoom</span>
                      </div>
                    </div>

                    {/* Thumbnails visual row indicator */}
                    {galleryImages.length > 1 && (
                      <div className="flex items-center space-x-2.5 overflow-x-auto py-1 scrollbar-none justify-start">
                        {galleryImages.map((url, idx) => (
                          <button
                            type="button"
                            key={idx}
                            onClick={() => setActiveImageIndex(idx)}
                            className={`w-[4.5rem] h-[4.5rem] sm:w-20 sm:h-20 rounded-2xl border bg-slate-50 p-1.5 flex-shrink-0 cursor-pointer transition-all focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 ${
                              activeImageIndex === idx 
                                ? 'border-brand-blue ring-4 ring-brand-blue/5 scale-102 bg-white shadow-xs' 
                                : 'border-slate-100 hover:border-slate-300'
                            }`}
                            aria-label={`Show product image ${idx + 1} of ${galleryImages.length}`}
                            aria-pressed={activeImageIndex === idx}
                          >
                            <img src={url} alt={`${product.name} thumbnail ${idx + 1}`} loading="lazy" decoding="async" onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = PRODUCT_IMAGE_FALLBACK; }} className="w-full h-full object-contain rounded-xl" referrerPolicy="no-referrer" />
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Trust badge strip row */}
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 bg-slate-50/70 p-4 sm:p-5 rounded-3xl border border-slate-200/80 text-left">
                    <div className="rounded-2xl bg-white p-3.5 border border-slate-100 space-y-1.5">
                      <div className="p-2 bg-blue-50/80 text-brand-blue rounded-xl w-fit">
                        <Banknote className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <span className="text-xs font-bold text-slate-900 block">Cash on Delivery</span>
                      <span className="text-[10px] text-slate-500 block leading-tight">Pay when your order arrives</span>
                    </div>
                    <div className="rounded-2xl bg-white p-3.5 border border-slate-100 space-y-1.5">
                      <div className="p-2 bg-blue-50/80 text-brand-blue rounded-xl w-fit">
                        <Truck className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <span className="text-xs font-bold text-slate-900 block">Island-wide Delivery</span>
                      <span className="text-[10px] text-slate-500 block leading-tight">Courier delivery across Sri Lanka</span>
                    </div>
                    <div className="rounded-2xl bg-white p-3.5 border border-slate-100 space-y-1.5">
                      <div className="p-2 bg-blue-50/80 text-brand-blue rounded-xl w-fit">
                        <LockKeyhole className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <span className="text-xs font-bold text-slate-900 block">Secure Checkout</span>
                      <span className="text-[10px] text-slate-500 block leading-tight">Protected order processing</span>
                    </div>
                    <div className="rounded-2xl bg-white p-3.5 border border-slate-100 space-y-1.5">
                      <div className="p-2 bg-blue-50/80 text-brand-blue rounded-xl w-fit">
                        <Headphones className="h-5 w-5" aria-hidden="true" />
                      </div>
                      <span className="text-xs font-bold text-slate-900 block">Customer Support</span>
                      <span className="text-[10px] text-slate-500 block leading-tight">Help before and after ordering</span>
                    </div>
                  </div>

                  <ProductSpecificationsPanel groups={specificationGroups} />

                </div>

                {/* RIGHT SIDE: CORE CONVERSIONS ENGINE (TITLES, PRICES, BADGES, AND ACTION CTAs) */}
                <div className="lg:col-span-6 space-y-8 text-left lg:sticky lg:top-2">
                  
                  {/* Category Pill + Stock Status Row */}
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span className="text-[10px] font-extrabold uppercase tracking-widest text-brand-blue bg-blue-50 border border-blue-100/50 px-3.5 py-1.5 rounded-full flex items-center gap-1.5">
                      <Sparkles className="h-3 w-3" />
                      {product.category.replace('-', ' ')}
                    </span>
                    
                    {product.stock > 0 ? (
                      <span className={`text-[10px] font-extrabold uppercase tracking-widest px-3.5 py-1.5 rounded-full flex items-center gap-2 border ${
                        product.stock <= 5 
                          ? 'text-amber-700 bg-amber-50 border-amber-100' 
                          : 'text-emerald-700 bg-emerald-50 border-emerald-100'
                      }`}>
                        <span className={`w-2 h-2 rounded-full ${product.stock <= 5 ? 'bg-amber-500' : 'bg-emerald-500'}`} aria-hidden="true" />
                        {product.stock <= 5 ? `Limited Stock: Only ${product.stock} left` : 'In Stock & Ready'}
                      </span>
                    ) : (
                      <span className="text-[10px] font-extrabold uppercase tracking-widest text-red-700 bg-red-50 border border-red-100 px-3.5 py-1.5 rounded-full flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-500" />
                        Out of Stock
                      </span>
                    )}
                  </div>

                  {/* Title & Brand Badging block */}
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-widest text-slate-400 bg-slate-100 px-2.5 py-1 rounded-md">
                        Brand: {brandName}
                      </span>
                      <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-widest text-emerald-600 bg-emerald-50 px-2.5 py-1 rounded-md gap-1">
                        <CheckCircle2 className="h-3 w-3" />
                        Genuine Product
                      </span>
                    </div>

                    <h1 id="product-detail-title" className="text-3xl sm:text-4.5xl font-black text-slate-950 tracking-tight leading-none font-display">
                      {product.name}
                    </h1>

                    {/* Star Rating summary click list */}
                    {totalReviews > 0 && (
                      <button 
                        onClick={scrollToReviews}
                        className="flex items-center space-x-3 mt-1.5 group cursor-pointer text-left rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                        aria-label={`Read ${totalReviews} customer reviews for ${product.name}`}
                      >
                        <div className="flex text-amber-400">
                          {[...Array(5)].map((_, i) => (
                            <Star 
                              key={i} 
                              className={`h-4 w-4 ${i < Math.round(product.rating) ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} 
                            />
                          ))}
                        </div>
                        <span className="text-sm font-black text-slate-800">{averageRating}</span>
                        <span className="text-slate-300">|</span>
                        <span className="text-xs font-bold text-slate-500 underline group-hover:text-brand-blue transition-colors">
                          {totalReviews > 0 ? `${totalReviews} Customer Review${totalReviews > 1 ? 's' : ''}` : `${product.reviewsCount} verified reviews`}
                        </span>
                      </button>
                    )}
                  </div>

                  {/* Price Conversions Box (Strikethrough, absolute savings, free delivery) */}
                  <div className="bg-slate-50 p-6 rounded-3xl border border-slate-100/80 text-left space-y-4">
                    <div className="space-y-1">
                      <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">
                        Marketplace Price
                      </span>
                      <div className="flex items-baseline gap-3.5">
                        <span className="text-4xl font-black text-slate-950 tracking-tight font-display">
                          {formatPrice(product.price)}
                        </span>
                        {product.originalPrice && product.originalPrice > product.price && (
                          <span className="text-lg text-slate-400 line-through font-light">
                            {formatPrice(product.originalPrice)}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Absolute and percentage savings calculation */}
                    {product.originalPrice && product.originalPrice > product.price && (
                      <div className="text-xs font-bold text-white bg-brand-blue/90 w-fit px-3 py-1.5 rounded-xl flex items-center gap-1 shadow-md shadow-brand-blue/10 animate-pulse">
                        <span>Save {formatPrice(product.originalPrice - product.price)} ({product.discount}% OFF)</span>
                      </div>
                    )}

                    {/* Real-time Free Delivery Eligibility Indicator */}
                    <div className="border-t border-slate-200/50 pt-4 flex items-center space-x-3 text-slate-700">
                      <div className="p-2 bg-emerald-500/10 text-emerald-600 rounded-xl">
                        <Truck className="h-5 w-5" />
                      </div>
                      <div>
                        {isEligibleForFreeDelivery ? (
                          <>
                            <span className="text-xs font-black text-emerald-600 block">Eligible for FREE Shipping</span>
                            <span className="text-[10px] text-slate-400 block font-light">Direct prompt dispatch from center</span>
                          </>
                        ) : (
                          <>
                            <span className="text-xs font-bold text-slate-800 block">Standard Courier Delivery</span>
                            <span className="text-[10px] text-slate-400 block font-light">Add {formatPrice(freeDeliveryThreshold - product.price)} more for islandwide Free Delivery</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Core Description */}
                  <div className="space-y-2.5">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">
                      Product Overview
                    </h4>
                    <p className="text-sm text-slate-600 leading-relaxed font-light whitespace-pre-line border-l-3 border-brand-blue/35 pl-4">
                      {product.description}
                    </p>
                  </div>

                  {/* Quantity selector input element */}
                  <div className="flex items-center justify-between gap-4 bg-slate-50 p-4 rounded-2xl border border-slate-200/80 sm:p-4.5">
                    <div>
                      <span className="text-xs font-black text-slate-800 block">Quantity Selection</span>
                      <span className="text-[10px] text-slate-400 font-light block mt-0.5">Adjust units for dispatch</span>
                    </div>
                    <div className="flex items-center space-x-1 bg-white border border-slate-200/80 p-1.5 rounded-xl shadow-3xs" role="group" aria-label="Product quantity">
                      <button
                        type="button"
                        onClick={() => setQuantity(Math.max(1, quantity - 1))}
                        className="w-11 h-11 rounded-lg text-slate-800 hover:bg-slate-100 flex items-center justify-center font-black cursor-pointer transition-all active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                        disabled={product.isActive === false || product.stock <= 0 || quantity <= 1}
                        aria-label="Decrease quantity"
                      >
                        <Minus className="h-4 w-4" aria-hidden="true" />
                      </button>
                      <span className="w-9 text-center text-base font-black text-slate-950" aria-live="polite" aria-label={`Quantity ${quantity}`}>{quantity}</span>
                      <button
                        type="button"
                        onClick={() => setQuantity(Math.min(product.stock, quantity + 1))}
                        className="w-11 h-11 rounded-lg text-slate-800 hover:bg-slate-100 flex items-center justify-center font-black cursor-pointer transition-all active:scale-90 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                        disabled={product.isActive === false || product.stock <= 0 || quantity >= product.stock}
                        aria-label="Increase quantity"
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>

                  {/* Action CTAs Cluster */}
                  <div className="space-y-4 pt-2">
                    
                    {product.stock > 0 && product.isActive !== false ? (
                      <>
                        {/* Buy Now remains the primary conversion action; cart behavior is unchanged. */}
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1.15fr_0.85fr]">
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.97 }}
                            onClick={() => onBuyNow(product, quantity)}
                            className="order-1 flex min-h-14 items-center justify-center rounded-2xl bg-brand-blue px-6 py-4 text-sm font-black text-white shadow-lg shadow-brand-blue/20 transition-all hover:bg-blue-700 hover:shadow-xl hover:shadow-brand-blue/25 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                            aria-label={`Buy ${quantity} ${product.name} now`}
                          >
                            <ShoppingBag className="h-5 w-5 mr-2" aria-hidden="true" />
                            Buy Now
                          </motion.button>

                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.96 }}
                            onClick={handleAddToCart}
                            className="order-2 flex min-h-14 items-center justify-center rounded-2xl border border-slate-300 bg-white px-6 py-4 text-xs font-black text-slate-900 shadow-sm transition-all hover:border-brand-blue/40 hover:bg-blue-50/50 hover:text-brand-blue focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20 sm:text-sm"
                            aria-label={`Add ${quantity} ${product.name} to cart`}
                          >
                            {addedMessage ? (
                              <>
                                <Check className="h-4.5 w-4.5 mr-2 text-emerald-300" />
                                Added to Cart
                              </>
                            ) : (
                              <>
                                <ShoppingCart className="h-4.5 w-4.5 mr-2" />
                                Add to Cart
                              </>
                            )}
                          </motion.button>

                        </div>

                        {/* WhatsApp Quick Checkout Order Action */}
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.97 }}
                          onClick={handleWhatsAppCheckout}
                          className="w-full flex min-h-12 items-center justify-center py-3.5 px-6 bg-emerald-50 hover:bg-emerald-100 text-emerald-800 border border-emerald-200 rounded-2xl text-sm font-black cursor-pointer transition-all gap-2.5 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-emerald-500/20"
                          aria-label={`Order ${product.name} through WhatsApp`}
                        >
                          <Phone className="h-4 w-4" aria-hidden="true" />
                          Prefer assistance? Order on WhatsApp
                        </motion.button>
                      </>
                    ) : (
                      /* Out of stock WhatsApp Enquiry Button */
                      <motion.button
                        type="button"
                        whileTap={{ scale: 0.97 }}
                        onClick={handleWhatsAppEnquiry}
                        className="w-full flex items-center justify-center py-4 px-6 bg-brand-blue hover:bg-blue-700 text-white rounded-2xl text-sm font-black cursor-pointer transition-all shadow-md shadow-brand-blue/15 gap-2.5"
                        aria-label={`Ask about availability for ${product.name} on WhatsApp`}
                      >
                        <Phone className="h-4 w-4 fill-white text-white" />
                        Enquire Stock on WhatsApp
                      </motion.button>
                    )}

                    {/* Trust assurances check labels row */}
                    <div className="flex flex-wrap justify-center items-center gap-3 text-[10px] text-slate-600 font-bold uppercase tracking-wider px-3 py-2.5 bg-slate-50 rounded-xl border border-slate-100 sm:gap-6">
                      <span className="flex items-center gap-1.5">
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                        Cash on Delivery Eligible
                      </span>
                      <span className="w-1.5 h-1.5 rounded-full bg-slate-200" />
                      <span className="flex items-center gap-1.5">
                        <Check className="h-3.5 w-3.5 text-emerald-500" />
                        WhatsApp Purchase Support
                      </span>
                    </div>

                    {/* Wishlist Heart action button */}
                    {isWishlistEnabled && (
                      <button
                        type="button"
                        onClick={() => onToggleWishlist(product)}
                        className="flex items-center justify-center text-xs font-bold text-slate-600 hover:text-red-600 mx-auto transition-colors cursor-pointer py-2 px-3 gap-2 rounded-xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-red-500/15"
                        aria-label={isWishlisted ? `Remove ${product.name} from wishlist` : `Add ${product.name} to wishlist`}
                        aria-pressed={isWishlisted}
                      >
                        <Heart className={`h-4.5 w-4.5 transition-colors ${isWishlisted ? 'fill-red-500 text-red-500 animate-pulse' : 'text-slate-400'}`} />
                        <span>{isWishlisted ? 'Saved in Wishlist' : 'Add to Wishlist'}</span>
                      </button>
                    )}
                  </div>

                </div>

              </div>

              {/* SECTION: PREMIUM CUSTOMER REVIEWS & FEEDBACK ENGINE */}
              {isReviewsEnabled && (
                <div id="customer-reviews-section" className="border-t border-slate-100 pt-14 text-left space-y-8">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div>
                    <h3 className="text-xl font-black text-slate-900 font-display flex items-center gap-2.5">
                      <MessageSquare className="h-5 w-5 text-brand-blue" />
                      Customer Feedback ({reviews.length})
                    </h3>
                    <p className="text-xs text-slate-500 mt-1">Customer comments and ratings posted from authenticated accounts.</p>
                  </div>
                </div>

                {/* Review Overview Rating Bento Panel */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-8 items-start">
                  
                  {/* Rating stats visual breakdown */}
                  <div className="md:col-span-4 bg-slate-50/70 border border-slate-100 p-6 rounded-3xl space-y-5 text-left">
                    <span className="block text-[10px] font-black text-slate-400 uppercase tracking-widest">
                      Feedback Summary
                    </span>
                    <div className="flex items-center gap-4">
                      <span className="text-5xl font-black text-slate-900 font-display">
                        {averageRating}
                      </span>
                      <div>
                        <div className="flex text-amber-400">
                          {[...Array(5)].map((_, i) => (
                            <Star 
                              key={i} 
                              className={`h-4 w-4 ${i < Math.round(Number(averageRating)) ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} 
                            />
                          ))}
                        </div>
                        <span className="text-[10px] text-slate-400 font-bold block mt-1 uppercase tracking-wider">
                          {totalReviews} Customer reviews
                        </span>
                      </div>
                    </div>

                    {/* Progress rating ratio distribution lines */}
                    <div className="space-y-2 pt-2">
                      {[5, 4, 3, 2, 1].map((stars) => {
                        const count = ratingDistribution[stars - 1] || 0;
                        const percentage = totalReviews > 0 ? (count / totalReviews) * 100 : 0;
                        return (
                          <div key={stars} className="flex items-center text-xs text-slate-500 gap-3">
                            <span className="w-3 text-right font-bold text-slate-700">{stars}</span>
                            <Star className="h-3 w-3 fill-amber-400 text-amber-400 flex-shrink-0" />
                            <div className="flex-1 h-2 bg-slate-200/60 rounded-full overflow-hidden">
                              <div 
                                className="h-full bg-brand-blue/90 rounded-full" 
                                style={{ width: `${percentage}%` }} 
                              />
                            </div>
                            <span className="w-8 text-right text-[10px] font-bold text-slate-400">
                              {percentage.toFixed(0)}%
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Submission review Form input panel */}
                  <div className="md:col-span-8 bg-slate-50/50 border border-slate-100 p-6 rounded-3xl space-y-5">
                    {currentUser ? (
                      <form onSubmit={handleSubmitReview} className="space-y-4">
                        <span className="block text-xs font-black text-slate-800 uppercase tracking-widest">
                          Leave Your Store Review
                        </span>
                        
                        {reviewSuccess && (
                          <div role="status" aria-live="polite" className="p-4 bg-emerald-50 border border-emerald-100 rounded-2xl flex items-center gap-3 text-emerald-800 text-xs font-medium animate-fadeIn">
                            <CheckCircle2 className="h-5 w-5 text-emerald-500 flex-shrink-0" />
                            <div>
                              <p className="font-bold">Review Published Successfully!</p>
                              <p className="text-[11px] text-emerald-600/90 font-normal">Your ratings have been synchronized and updated on the product detail showcase.</p>
                            </div>
                          </div>
                        )}

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <label htmlFor="product-review-name" className="block text-[10px] font-black text-slate-500 uppercase tracking-wider">Your Name</label>
                            <input
                              id="product-review-name"
                              type="text"
                              required
                              placeholder="e.g. John Doe"
                              value={newCustomerName}
                              maxLength={80}
                              onChange={(e) => setNewCustomerName(e.target.value)}
                              className="w-full text-xs px-4 py-3 bg-white border border-slate-300 rounded-2xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15 focus-visible:border-brand-blue transition-all text-slate-800"
                            />
                          </div>

                          <div className="space-y-1.5">
                            <span className="block text-[10px] font-black text-slate-500 uppercase tracking-wider" id="product-review-rating-label">Select Star Rating</span>
                            <div className="flex space-x-1 py-1">
                              {[1, 2, 3, 4, 5].map((val) => (
                                <button
                                  key={val}
                                  type="button"
                                  onClick={() => setNewRating(val)}
                                  className="p-2 hover:scale-110 transition-transform cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-amber-400/25"
                                  aria-label={`${val} star rating`}
                                  aria-pressed={newRating === val}
                                >
                                  <Star className={`h-6 w-6 ${val <= newRating ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} />
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-1.5">
                          <label htmlFor="product-review-comment" className="block text-[10px] font-black text-slate-500 uppercase tracking-wider">Write Review Comments</label>
                          <textarea
                            id="product-review-comment"
                            required
                            rows={3}
                            placeholder="Share details regarding product quality, performance, packaging, after-sales support, or delivery dispatch time..."
                            value={newComment}
                            maxLength={1500}
                            onChange={(e) => setNewComment(e.target.value)}
                            className="w-full text-xs px-4 py-3 bg-white border border-slate-300 rounded-2xl focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/15 focus-visible:border-brand-blue transition-all text-slate-800"
                          />
                        </div>

                        <button
                          type="submit"
                          disabled={isSubmitting}
                          className="w-full sm:w-fit px-8 py-3 bg-slate-950 hover:bg-slate-800 text-white font-black rounded-xl text-[10px] uppercase tracking-widest transition-all cursor-pointer disabled:opacity-50 shadow-md shadow-slate-950/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                        >
                          {isSubmitting ? 'Submitting Details...' : 'Submit Review'}
                        </button>
                      </form>
                    ) : (
                      <div className="text-center py-8 px-4 border border-dashed border-slate-200 rounded-3xl bg-white/70 space-y-3">
                        <div className="p-3 bg-slate-100 text-slate-400 rounded-2xl w-fit mx-auto">
                          <HelpCircle className="h-6 w-6" />
                        </div>
                        <p className="text-xs text-slate-500 font-bold">Authorized Account Required</p>
                        <p className="text-[11px] text-slate-400 font-light max-w-sm mx-auto">
                          Please log in or register with your email in the store navbar to write and publish verified reviews for products.
                        </p>
                      </div>
                    )}
                  </div>

                </div>

                {/* Submited Reviews list cards container */}
                <div className="space-y-4 pt-4">
                  {reviewError && <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4 text-xs font-semibold text-red-700">{reviewError}</div>}
                  {loadingReviews ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {[...Array(2)].map((_, idx) => (
                        <div key={idx} className="bg-white border border-slate-100/60 p-5 rounded-2xl flex items-start gap-4 animate-pulse">
                          <div className="w-10 h-10 rounded-full bg-slate-100 flex-shrink-0" />
                          <div className="flex-1 space-y-3">
                            <div className="flex justify-between items-center">
                              <div className="space-y-1.5 flex-1">
                                <div className="h-3 bg-slate-100 rounded-md w-1/3" />
                                <div className="h-2 bg-slate-100 rounded-md w-1/4" />
                              </div>
                              <div className="h-2 bg-slate-100 rounded-md w-1/5" />
                            </div>
                            <div className="flex space-x-1">
                              {[...Array(5)].map((_, s) => (
                                <div key={s} className="h-3 w-3 bg-slate-100 rounded-full" />
                              ))}
                            </div>
                            <div className="space-y-1.5">
                              <div className="h-3 bg-slate-100 rounded-md w-full" />
                              <div className="h-3 bg-slate-100 rounded-md w-5/6" />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : reviews.length > 0 ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {reviews.slice(0, visibleReviewCount).map((rev, idx) => {
                        const nameToUse = rev.customerName || 'Authenticated Customer';
                        const initials = nameToUse.substring(0, 2).toUpperCase() || 'VB';
                        return (
                          <div key={rev.id || idx} className="bg-white border border-slate-100/80 p-5 rounded-2xl flex items-start gap-4 shadow-3xs transition-all hover:border-slate-200 hover:shadow-2xs">
                            <div className="w-10 h-10 rounded-full bg-blue-50 text-brand-blue font-black text-xs flex items-center justify-center flex-shrink-0 border border-blue-100/50">
                              {initials}
                            </div>
                            <div className="flex-1 space-y-2 text-left">
                              <div className="flex items-center justify-between">
                                <div>
                                  <span className="text-xs font-black text-slate-800 block">{nameToUse}</span>
                                  <span className="text-[9px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-sm font-bold uppercase tracking-wider inline-block mt-0.5">Authenticated Customer</span>
                                </div>
                                <span className="text-[10px] text-slate-400 font-light">
                                  {rev.createdAt && !isNaN(new Date(rev.createdAt).getTime()) 
                                    ? new Date(rev.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) 
                                    : 'Just now'}
                                </span>
                              </div>
                              <div className="flex text-amber-400">
                                {[...Array(5)].map((_, s) => (
                                  <Star key={s} className={`h-3 w-3 ${s < rev.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-200'}`} />
                                ))}
                              </div>
                              <p className="text-xs text-slate-500 font-light leading-relaxed whitespace-pre-line">{rev.comment}</p>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-center py-12 text-xs text-slate-400 font-light bg-slate-50/50 rounded-3xl border border-dashed border-slate-200 flex flex-col items-center justify-center gap-1">
                      <span className="font-bold text-slate-700">No active reviews published</span>
                      <span>Certified buyers haven't posted comments on this device yet. Be the first!</span>
                    </div>
                  )}
                  {reviews.length > visibleReviewCount && (
                    <button type="button" onClick={() => setVisibleReviewCount((count) => count + 4)} className="mx-auto block min-h-11 rounded-xl border border-slate-300 bg-white px-5 py-2.5 text-xs font-black text-slate-800 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20">
                      Show more reviews
                    </button>
                  )}
                </div>
              </div>
              )}

              {/* SECTION: CAROUSEL SLIDER OF RELATED PRODUCTS */}
              <RelatedProductsRail
                products={relatedItems}
                scrollRef={relatedScrollRef}
                onScroll={scrollRelated}
                onSelect={(item) => {
                  onSelectProduct(item);
                  scrollContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
                }}
                formatPrice={formatPrice}
              />
              {false && <div className="border-t border-slate-100 pt-14 text-left space-y-6">
                <div className="flex justify-between items-center">
                  <div>
                    <h3 className="text-xl font-black text-slate-900 font-display">
                      Related Products
                    </h3>
                    <p className="text-xs text-slate-400 mt-1">Explore more carefully selected products from this category.</p>
                  </div>
                  
                  {/* Slider controls arrow buttons */}
                  {relatedItems.length > 4 && (
                    <div className="flex space-x-2">
                      <button
                        type="button"
                        onClick={() => scrollRelated('left')}
                        className="p-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full cursor-pointer transition-all active:scale-90 border border-slate-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                        aria-label="Scroll related products left"
                      >
                        <ChevronLeft className="h-4.5 w-4.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => scrollRelated('right')}
                        className="p-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-full cursor-pointer transition-all active:scale-90 border border-slate-200 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                        aria-label="Scroll related products right"
                      >
                        <ChevronRight className="h-4.5 w-4.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Horizontal slider container */}
                <div 
                  ref={relatedScrollRef}
                  className="flex overflow-x-auto gap-4 py-3 scrollbar-none snap-x snap-mandatory"
                >
                  {relatedItems.map((item) => (
                    <motion.button
                      type="button"
                      key={item.id}
                      whileHover={{ y: -5 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => {
                        onSelectProduct(item);
                        // Reset modal scroll container back to top
                        if (scrollContainerRef.current) {
                          scrollContainerRef.current.scrollTo({ top: 0, behavior: 'smooth' });
                        }
                      }}
                      className="w-[185px] sm:w-[230px] flex-shrink-0 snap-start group cursor-pointer bg-white border border-slate-200 rounded-2xl p-4 flex flex-col h-full hover:shadow-lg hover:border-brand-blue/25 transition-all duration-300 text-left focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                      aria-label={`View related product ${item.name}`}
                    >
                      <div className="aspect-square w-full rounded-xl overflow-hidden bg-slate-50 relative mb-4 p-3 flex items-center justify-center select-none">
                        <img 
                          src={item.imageUrl} 
                          alt={item.name} 
                          loading="lazy"
                          decoding="async"
                          onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = PRODUCT_IMAGE_FALLBACK; }}
                          className="max-h-full max-w-full object-contain group-hover:scale-106 transition-transform duration-500 ease-out"
                          referrerPolicy="no-referrer"
                        />
                        {item.discount && item.discount > 0 && (
                          <div className="absolute top-2.5 left-2.5 bg-brand-blue text-white font-black text-[9px] px-2.5 py-1 rounded-lg uppercase tracking-wider shadow-sm">
                            -{item.discount}%
                          </div>
                        )}
                      </div>
                      
                      <div className="flex-grow flex flex-col justify-between space-y-2">
                        <div>
                          <span className="text-[9px] text-slate-400 font-black uppercase tracking-widest block mb-0.5">
                            {item.category}
                          </span>
                          <h5 className="text-xs sm:text-sm font-bold text-slate-800 line-clamp-2 font-display group-hover:text-brand-blue transition-colors leading-tight">
                            {item.name}
                          </h5>
                        </div>
                        <div className="flex items-center justify-between pt-1">
                          <span className="text-sm font-black text-slate-900">
                            {formatPrice(item.price)}
                          </span>
                          <span className="text-[10px] font-bold text-brand-blue opacity-0 group-hover:opacity-100 translate-x-1.5 group-hover:translate-x-0 transition-all flex items-center gap-0.5">
                            Details <ArrowRight className="h-3 w-3" />
                          </span>
                        </div>
                      </div>
                    </motion.button>
                  ))}
                </div>
              </div>}
            </>
          )}

        </div>

      </div>

      {/* DETAILED ACCESSIBLE LIGHTBOX ZOOM OVERLAY (Tap/Click to zoom image) */}
      <AnimatePresence>
        {isLightboxOpen && (
          <motion.div
            ref={lightboxRef}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleLightboxClose}
            className="fixed inset-0 z-50 bg-black/95 backdrop-blur-2xl flex flex-col justify-between p-4 cursor-zoom-out select-none"
            role="dialog"
            aria-modal="true"
            aria-label={`Expanded image viewer for ${product.name}`}
          >
            {/* Top Close Control rail */}
            <div className="flex justify-between items-center w-full max-w-6xl mx-auto py-2">
              <div className="text-white/60 text-xs font-bold uppercase tracking-wider flex items-center gap-2">
                <Maximize2 className="h-4 w-4" />
                <span>Device Inspector Mode</span>
              </div>
              <button
                ref={lightboxCloseButtonRef}
                type="button"
                onClick={handleLightboxClose}
                className="p-3 bg-white/10 hover:bg-white/20 text-white rounded-full transition-colors cursor-pointer border border-white/10 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30"
                aria-label="Close expanded image viewer"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Main Interactive Zoom Box Area */}
            <div 
              className="relative flex-1 w-full max-w-5xl mx-auto flex items-center justify-center overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Image pan scale holder */}
              <div
                className="w-full h-full flex items-center justify-center overflow-hidden relative cursor-grab active:cursor-grabbing"
                onMouseDown={handleLightboxMouseDown}
                onMouseMove={handleLightboxMouseMove}
                onMouseUp={handleLightboxMouseUp}
                onMouseLeave={handleLightboxMouseUp}
              >
                <motion.img
                  animate={{ 
                    scale: lightboxZoom,
                    x: lightboxPan.x,
                    y: lightboxPan.y
                  }}
                  transition={isDragging ? { type: 'tween', duration: 0 } : { type: 'spring', damping: 25 }}
                  src={activeImageUrl}
                  alt={`${product.name}, image ${activeImageIndex + 1} of ${galleryImages.length}`}
                  referrerPolicy="no-referrer"
                  decoding="async"
                  onError={(event) => { event.currentTarget.onerror = null; event.currentTarget.src = PRODUCT_IMAGE_FALLBACK; }}
                  className="max-h-[80vh] max-w-full object-contain pointer-events-none"
                />
              </div>

              {/* Lightbox Side Arrows */}
              {galleryImages.length > 1 && (
                <>
                  <button
                    type="button"
                    onClick={prevLightboxImage}
                    className="absolute left-2 p-3 bg-white/10 hover:bg-white/20 border border-white/10 text-white rounded-full transition-colors cursor-pointer active:scale-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30"
                    aria-label="Show previous expanded product image"
                  >
                    <ChevronLeft className="h-6 w-6" />
                  </button>
                  <button
                    type="button"
                    onClick={nextLightboxImage}
                    className="absolute right-2 p-3 bg-white/10 hover:bg-white/20 border border-white/10 text-white rounded-full transition-colors cursor-pointer active:scale-90 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30"
                    aria-label="Show next expanded product image"
                  >
                    <ChevronRight className="h-6 w-6" />
                  </button>
                </>
              )}
            </div>

            {/* Bottom Controls / Zoom levels indicator */}
            <div className="w-full max-w-xl mx-auto bg-white/5 border border-white/10 backdrop-blur-md p-4 rounded-3xl flex items-center justify-between gap-4 mb-2" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleZoomOut}
                  disabled={lightboxZoom <= 1}
                  className="p-2 text-white/80 hover:text-white disabled:opacity-30 transition-colors cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30"
                  aria-label="Zoom out product image"
                >
                  <ZoomOut className="h-5 w-5" />
                </button>
                
                <span className="text-xs font-black text-white px-3 min-w-[50px] text-center bg-white/10 py-1 rounded-lg">
                  {lightboxZoom.toFixed(1)}x
                </span>

                <button
                  type="button"
                  onClick={handleZoomIn}
                  disabled={lightboxZoom >= 4}
                  className="p-2 text-white/80 hover:text-white disabled:opacity-30 transition-colors cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/30"
                  aria-label="Zoom in product image"
                >
                  <ZoomIn className="h-5 w-5" />
                </button>
              </div>

              <span className="text-[10px] text-white/40 uppercase tracking-widest font-bold">
                {lightboxZoom > 1 ? 'Drag to pan around' : 'Use zoom controls to inspect'}
              </span>

              {/* Pagination Dots */}
              {galleryImages.length > 1 && (
                <div className="flex items-center space-x-1.5" aria-label={`Image ${activeImageIndex + 1} of ${galleryImages.length}`} role="status">
                  {galleryImages.map((_, i) => (
                    <div 
                      key={i} 
                      className={`h-1.5 rounded-full transition-all ${
                        activeImageIndex === i ? 'w-4 bg-brand-blue' : 'w-1.5 bg-white/40'
                      }`} 
                    />
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Mobile sticky purchase bar; uses the same cart and checkout handlers as the main CTA section. */}
      <AnimatePresence>
        {showStickyBar && !isLightboxOpen && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed bottom-0 left-0 right-0 z-[60] bg-white/97 border-t border-slate-200 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] shadow-[0_-15px_40px_rgba(0,0,0,0.14)] md:hidden backdrop-blur-xl"
            aria-label="Mobile purchase actions"
          >
            <div className="mx-auto max-w-xl space-y-2.5">
              <div className="flex items-center justify-between gap-3 text-left">
                <div className="min-w-0">
                  <span className="block truncate text-[11px] font-extrabold text-slate-900">{product.name}</span>
                  <span className="block text-base font-black text-brand-blue">{formatPrice(product.price)}</span>
                </div>
                <span className={`flex-none rounded-full border px-2.5 py-1 text-[9px] font-extrabold uppercase tracking-wide ${product.stock <= 0 ? 'border-red-100 bg-red-50 text-red-700' : product.stock <= 5 ? 'border-amber-100 bg-amber-50 text-amber-700' : 'border-emerald-100 bg-emerald-50 text-emerald-700'}`}>
                  {product.stock <= 0 ? 'Out of stock' : product.stock <= 5 ? `Only ${product.stock} left` : 'In stock'}
                </span>
              </div>

              {product.stock > 0 && product.isActive !== false ? (
                <div className="grid grid-cols-[0.9fr_1.1fr] gap-2.5">
                  <button
                    type="button"
                    onClick={handleAddToCart}
                    className="flex min-h-12 items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-3 text-xs font-black text-slate-900 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/20"
                    aria-label={`Add ${quantity} ${product.name} to cart`}
                  >
                    {addedMessage ? <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" /> : <ShoppingCart className="h-4 w-4" aria-hidden="true" />}
                    <span>{addedMessage ? 'Added' : 'Add to Cart'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onBuyNow(product, quantity)}
                    className="flex min-h-12 items-center justify-center gap-1.5 rounded-xl bg-brand-blue px-3 py-3 text-xs font-black text-white shadow-md shadow-brand-blue/20 transition-all active:scale-[0.98] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                    aria-label={`Buy ${quantity} ${product.name} now`}
                  >
                    <ShoppingBag className="h-4 w-4" aria-hidden="true" />
                    Buy Now
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={handleWhatsAppEnquiry}
                  className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-blue px-4 py-3 text-xs font-black text-white shadow-md shadow-brand-blue/20 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-blue/25"
                  aria-label={`Ask about availability for ${product.name} on WhatsApp`}
                >
                  <Phone className="h-4 w-4" aria-hidden="true" />
                  Enquire About Stock
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}
