export interface Product {
  id: string;
  name: string;
  description: string;
  price: number; // in LKR (this is the sale price if discount is present, or the default price)
  originalPrice?: number; // in LKR (this is the regular/original price)
  discount?: number; // percentage
  imageUrl: string;
  imageUrls?: string[];
  category: string; // e.g. 'electronics'
  rating: number; // 1-5
  reviewsCount: number;
  isNew?: boolean;
  isFeatured?: boolean;
  isBestSeller?: boolean;
  isActive?: boolean; // active/inactive
  sku?: string;
  stock: number;
  specs: Record<string, string>;
  createdAt?: string;
  supplierItemCode?: string;
  costPrice?: number;
  marketPrice?: number;
}

/** Customer-search-safe view of a product. Keep this explicit and allowlisted. */
export interface CustomerProduct {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly sellingPrice: number;
  readonly salePrice?: number;
  readonly category: string;
  readonly brand: string;
  readonly model: string;
  readonly stock: number;
  readonly rating: number;
  readonly reviewCount: number;
  readonly isNew: boolean;
  readonly isFeatured: boolean;
  readonly isBestSeller: boolean;
}

export interface Category {
  id: string; // e.g., 'electronics'
  name: string;
  icon: string; // lucide icon name
  imageUrl?: string;
  isActive?: boolean;
  count?: number;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface Order {
  id: string;
  orderNumber?: string; // ZY100001, ZY100002...
  customerUid: string; // 'guest' or uid
  customerName: string;
  customerPhone: string;
  customerPhone2?: string;
  customerEmail: string;
  customerAddress: string;
  district: string;
  city?: string;
  items: {
    productId: string;
    name: string;
    price: number;
    quantity: number;
    imageUrl: string;
  }[];
  totalPrice: number;
  status: 'pending' | 'confirmed' | 'cancelled';
  paymentMethod: 'cod' | 'whatsapp_confirm';
  createdAt: string;
}

export interface HeroBannerSettings {
  id: string;
  badge: string;
  title: string;
  subtitle: string;
  description: string;
  image: string;
  bgGradient?: string;
  buttonText?: string;
  buttonUrl?: string;
  enabled?: boolean;
}

export interface WebsiteSettings {
  storeName: string;
  storeTagline?: string;
  logoUrl?: string;
  faviconUrl?: string;
  contactPhone?: string; // Contact Number 1
  contactPhone2?: string; // Contact Number 2
  whatsappNumber: string;
  contactEmail?: string;
  contactAddress?: string;

  // Homepage / Slider
  heroBanners: HeroBannerSettings[];
  autoSlideSpeed?: number; // Seconds
  enableSlider?: boolean;

  // Branding
  primaryColor?: string;
  secondaryColor?: string;
  footerLogoUrl?: string;

  // Footer
  aboutText?: string;
  copyrightText?: string;

  // Social Media
  facebookUrl?: string;
  instagramUrl?: string;
  tiktokUrl?: string;
  youtubeUrl?: string;

  // SEO
  seoTitle?: string;
  seoDescription?: string;
  seoKeywords?: string;
  ogImageUrl?: string;

  // Shipping
  deliveryCharge: number;
  freeDeliveryMin: number;

  // Store Options
  enableCOD?: boolean;
  enableWishlist?: boolean;
  enableReviews?: boolean;
  enableFeaturedProducts?: boolean;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  role: 'customer' | 'admin';
  createdAt: string;
}

export interface Review {
  id: string;
  productId: string;
  userName: string;
  rating: number;
  comment: string;
  createdAt: string;
}

export interface SupplierReviewQueueItem {
  id: string;
  supplierCode: string;
  supplierName: string;
  productName: string;
  source: 'Website' | 'WhatsApp';
  changeType: 'NEW_PRODUCT' | 'PRICE_CHANGED' | 'STOCK_CHANGED' | 'IMAGE_CHANGED' | 'DESCRIPTION_CHANGED';
  oldValue: string;
  newValue: string;
  status: 'Pending' | 'Approved' | 'Rejected';
  createdAt: string; // or any string-based timestamp/ISO string
  reviewedAt?: string;
  reviewedBy?: string;
  productPayload?: Product & Record<string, unknown>;
  matchedProductId?: string | null;
  reviewQueueItemId?: string;
  sourceId?: string;
  batchId?: string;
}
