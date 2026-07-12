import type { CustomerProduct, Product } from '../../types';
import { getProductBrand, getProductModel } from './productSearchMetadata';

// TODO: Replace client-side projection with a backend DTO/customer-safe API when backend architecture permits it.
// TODO: A dedicated migration sprint should sanitize legacy persisted cart and wishlist product payloads.
export const projectCustomerProduct = (product: Readonly<Product>): CustomerProduct => Object.freeze({
  id: product.id,
  name: product.name,
  image: product.imageUrl,
  sellingPrice: product.price,
  salePrice: typeof product.originalPrice === 'number' && product.originalPrice > product.price
    ? product.price
    : undefined,
  category: product.category,
  brand: getProductBrand(product),
  model: getProductModel(product),
  stock: product.stock,
  rating: product.rating,
  reviewCount: product.reviewsCount,
  isNew: product.isNew === true,
  isFeatured: product.isFeatured === true,
  isBestSeller: product.isBestSeller === true,
});

export const projectCustomerProducts = (
  products: readonly Readonly<Product>[],
): readonly CustomerProduct[] => Object.freeze(products.map(projectCustomerProduct));
