import {
  collection,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  writeBatch,
  doc,
} from 'firebase/firestore';
import type { Firestore, QueryDocumentSnapshot } from 'firebase/firestore';
import type { Brand, Product } from '../../types';
import { productReferencesBrand } from '../brands/brandUtils';
import { categoryMatches } from '../categories/categoryUtils';

export const ADMIN_REFERENCE_SCAN_PAGE_SIZE = 200;

type ProductReferencePredicate = (product: Product) => boolean;

const readProductReferencePage = async (
  firestore: Firestore,
  cursor: QueryDocumentSnapshot | null,
): Promise<QueryDocumentSnapshot[]> => {
  const constraints = [
    orderBy(documentId()),
    ...(cursor ? [startAfter(cursor)] : []),
    limit(ADMIN_REFERENCE_SCAN_PAGE_SIZE),
  ];
  return (await getDocs(query(collection(firestore, 'products'), ...constraints))).docs;
};

/**
 * Destructive registry checks must include legacy products, but they must not
 * load an unbounded catalogue into browser memory. This traversal exits on the
 * first reference and keeps each Firestore response bounded.
 */
export async function hasProductReference(
  firestore: Firestore,
  predicate: ProductReferencePredicate,
): Promise<boolean> {
  let cursor: QueryDocumentSnapshot | null = null;
  do {
    const page = await readProductReferencePage(firestore, cursor);
    if (page.some((snapshot) => predicate({ id: snapshot.id, ...snapshot.data() } as Product))) return true;
    if (page.length < ADMIN_REFERENCE_SCAN_PAGE_SIZE) return false;
    cursor = page.at(-1) || null;
  } while (cursor);
  return false;
}

export const hasCategoryProductReference = (firestore: Firestore, categoryId: string): Promise<boolean> => (
  hasProductReference(firestore, (product) => categoryMatches(product.category, categoryId))
);

export const hasBrandProductReference = (firestore: Firestore, brand: Brand): Promise<boolean> => (
  hasProductReference(firestore, (product) => productReferencesBrand(product, brand))
);

/**
 * Brand renames are exceptional operations. References are updated one bounded
 * page and one sub-500-write batch at a time so large catalogues do not exhaust
 * browser memory or exceed Firestore batch limits.
 */
export async function updateBrandProductReferences(
  firestore: Firestore,
  brand: Brand,
  nextName: string,
  updatedAt: string,
): Promise<number> {
  let cursor: QueryDocumentSnapshot | null = null;
  let updated = 0;
  do {
    const page = await readProductReferencePage(firestore, cursor);
    const referenced = page.filter((snapshot) => productReferencesBrand(
      { id: snapshot.id, ...snapshot.data() } as Product,
      brand,
    ));
    if (referenced.length > 0) {
      const batch = writeBatch(firestore);
      referenced.forEach((snapshot) => batch.update(doc(firestore, 'products', snapshot.id), {
        'specs.Brand': nextName,
        updatedAt,
      }));
      await batch.commit();
      updated += referenced.length;
    }
    if (page.length < ADMIN_REFERENCE_SCAN_PAGE_SIZE) return updated;
    cursor = page.at(-1) || null;
  } while (cursor);
  return updated;
}
