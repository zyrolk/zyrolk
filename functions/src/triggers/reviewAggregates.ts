import { logger } from "firebase-functions";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { adminDb } from "../api/firebase";
import { calculateReviewAggregate } from "../api/reviews/reviewAggregates";

function getProductId(data: FirebaseFirestore.DocumentData | undefined): string | null {
  const productId = data?.productId;

  if (typeof productId !== "string") {
    return null;
  }

  const trimmedProductId = productId.trim();
  return trimmedProductId.length > 0 ? trimmedProductId : null;
}

async function syncProductReviewAggregate(productId: string): Promise<void> {
  const reviewsSnapshot = await adminDb
    .collection("reviews")
    .where("productId", "==", productId)
    .get();

  const aggregate = calculateReviewAggregate(
    reviewsSnapshot.docs.map((reviewDoc) => reviewDoc.data())
  );

  const productRef = adminDb.collection("products").doc(productId);
  const productSnapshot = await productRef.get();

  if (!productSnapshot.exists) {
    logger.warn("Skipping review aggregate sync because product does not exist.", {
      productId,
    });
    return;
  }

  await productRef.update({
    rating: aggregate.rating,
    reviewsCount: aggregate.reviewsCount,
  });

  logger.info("Synced product review aggregate.", {
    productId,
    rating: aggregate.rating,
    reviewsCount: aggregate.reviewsCount,
  });
}

export const syncReviewAggregates = onDocumentWritten("reviews/{reviewId}", async (event) => {
  const productIds = new Set<string>();
  const beforeProductId = getProductId(event.data?.before.data());
  const afterProductId = getProductId(event.data?.after.data());

  if (beforeProductId) {
    productIds.add(beforeProductId);
  }

  if (afterProductId) {
    productIds.add(afterProductId);
  }

  await Promise.all(
    Array.from(productIds).map((productId) => syncProductReviewAggregate(productId))
  );
});
