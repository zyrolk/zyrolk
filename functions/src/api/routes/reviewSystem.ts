import * as express from "express";
import { DecodedIdToken } from "firebase-admin/auth";
import { FieldValue, Firestore } from "firebase-admin/firestore";
import {
  ReviewSystemError,
  calculateVoteDeltas,
  cleanProductId,
  cleanReviewText,
  deterministicCustomerDocumentId,
  normalizeRating,
  normalizeVote,
  selectVerifiedPurchaseOrder,
} from "../reviews/reviewSystemLogic";

interface ReviewSystemDependencies {
  db: Firestore;
  verifyIdToken: (token: string) => Promise<DecodedIdToken>;
  isAdminEmail: (email: string | undefined) => boolean;
}

const rateBuckets = new Map<string, number[]>();
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 15;

function enforceRateLimit(userId: string): void {
  const now = Date.now();
  const recent = (rateBuckets.get(userId) || []).filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  if (recent.length >= RATE_MAX) throw new ReviewSystemError("Too many requests. Please wait and try again.", 429);
  recent.push(now);
  rateBuckets.set(userId, recent);
}

function readBearerToken(req: express.Request): string {
  const match = (req.header("Authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!match) throw new ReviewSystemError("Authentication required", 401);
  return match[1];
}

function sendError(res: express.Response, error: unknown): void {
  const statusCode = error instanceof ReviewSystemError ? error.statusCode : 500;
  const message = error instanceof ReviewSystemError ? error.message : "The review service could not complete this request";
  res.status(statusCode).json({ error: message });
}

async function getCustomerOrders(db: Firestore, userId: string) {
  const snapshot = await db.collection("orders").where("customerUid", "==", userId).get();
  return snapshot.docs.map((document) => ({ id: document.id, data: document.data() }));
}

function safeDisplayName(token: DecodedIdToken): string {
  const name = typeof token.name === "string" ? token.name.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 120) : "";
  return name;
}

async function applyVote(
  db: Firestore,
  collectionName: "reviews" | "productQuestions",
  documentId: string,
  userId: string,
  value: unknown,
): Promise<void> {
  const vote = normalizeVote(value);
  const parentRef = db.collection(collectionName).doc(documentId);
  const voteRef = parentRef.collection("votes").doc(userId);
  await db.runTransaction(async (transaction) => {
    const [parentSnapshot, voteSnapshot] = await Promise.all([
      transaction.get(parentRef),
      transaction.get(voteRef),
    ]);
    if (!parentSnapshot.exists) throw new ReviewSystemError("Item not found", 404);
    const previous = voteSnapshot.exists ? voteSnapshot.data()?.value : undefined;
    const deltas = calculateVoteDeltas(previous, vote);
    const data = parentSnapshot.data() || {};
    transaction.update(parentRef, {
      helpfulCount: Math.max(0, Number(data.helpfulCount || 0) + deltas.helpful),
      notHelpfulCount: Math.max(0, Number(data.notHelpfulCount || 0) + deltas.notHelpful),
    });
    if (deltas.removeVote) transaction.delete(voteRef);
    else transaction.set(voteRef, { value: vote, updatedAt: FieldValue.serverTimestamp() });
  });
}

export function registerReviewSystemRoutes(app: express.Express, dependencies: ReviewSystemDependencies): void {
  const authenticate: express.RequestHandler = async (req, res, next) => {
    try {
      const token = await dependencies.verifyIdToken(readBearerToken(req));
      enforceRateLimit(token.uid);
      res.locals.reviewUser = token;
      next();
    } catch (error) {
      sendError(res, error instanceof ReviewSystemError ? error : new ReviewSystemError("Invalid or expired authentication token", 401));
    }
  };

  app.post("/api/review-system/eligibility", authenticate, async (req, res) => {
    try {
      const user = res.locals.reviewUser as DecodedIdToken;
      const productId = cleanProductId(req.body?.productId);
      const reviewId = deterministicCustomerDocumentId(user.uid, productId);
      const [orders, existingReview] = await Promise.all([
        getCustomerOrders(dependencies.db, user.uid),
        dependencies.db.collection("reviews").doc(reviewId).get(),
      ]);
      res.json({
        eligible: Boolean(selectVerifiedPurchaseOrder(orders, productId)),
        existingReviewId: existingReview.exists ? reviewId : null,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/review-system/reviews", authenticate, async (req, res) => {
    try {
      const user = res.locals.reviewUser as DecodedIdToken;
      const action = String(req.body?.action || "");
      const productId = cleanProductId(req.body?.productId);
      const requestedReviewId = typeof req.body?.reviewId === "string" ? req.body.reviewId.trim() : "";
      const reviewId = action === "create"
        ? deterministicCustomerDocumentId(user.uid, productId)
        : requestedReviewId || deterministicCustomerDocumentId(user.uid, productId);
      const reviewRef = dependencies.db.collection("reviews").doc(reviewId);

      if (action === "create") {
        const [orders, product] = await Promise.all([
          getCustomerOrders(dependencies.db, user.uid),
          dependencies.db.collection("products").doc(productId).get(),
        ]);
        if (!product.exists) throw new ReviewSystemError("Product not found", 404);
        const orderId = selectVerifiedPurchaseOrder(orders, productId);
        if (!orderId) throw new ReviewSystemError("Only customers with a confirmed purchase may review this product", 403);
        const rating = normalizeRating(req.body?.rating);
        const title = cleanReviewText(req.body?.title, "Review title", 3, 120);
        const body = cleanReviewText(req.body?.body, "Review body", 10, 3000);
        await dependencies.db.runTransaction(async (transaction) => {
          const existing = await transaction.get(reviewRef);
          if (existing.exists) throw new ReviewSystemError("You have already reviewed this product", 409);
          const customerName = safeDisplayName(user);
          transaction.create(reviewRef, {
            schemaVersion: 2,
            productId,
            userId: user.uid,
            customerName,
            title,
            body,
            comment: body,
            rating,
            verifiedPurchase: true,
            orderId,
            imageUrls: [],
            helpfulCount: 0,
            notHelpfulCount: 0,
            reportCount: 0,
            approved: true,
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
        res.status(201).json({ success: true, reviewId });
        return;
      }

      if (action === "update" || action === "delete") {
        await dependencies.db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(reviewRef);
          if (!snapshot.exists) throw new ReviewSystemError("Review not found", 404);
          if (snapshot.data()?.userId !== user.uid) throw new ReviewSystemError("You can only manage your own review", 403);
          if (snapshot.data()?.productId !== productId) throw new ReviewSystemError("Review product mismatch", 400);
          if (action === "delete") transaction.delete(reviewRef);
          else {
            const rating = normalizeRating(req.body?.rating);
            const title = cleanReviewText(req.body?.title, "Review title", 3, 120);
            const body = cleanReviewText(req.body?.body, "Review body", 10, 3000);
            transaction.update(reviewRef, { rating, title, body, comment: body, updatedAt: FieldValue.serverTimestamp() });
          }
        });
        res.json({ success: true, reviewId });
        return;
      }

      if (action === "vote") {
        await applyVote(dependencies.db, "reviews", reviewId, user.uid, req.body?.vote);
        res.json({ success: true });
        return;
      }

      if (action === "report") {
        const reason = cleanReviewText(req.body?.reason, "Report reason", 3, 240);
        const reportRef = reviewRef.collection("reports").doc(user.uid);
        await dependencies.db.runTransaction(async (transaction) => {
          const [review, report] = await Promise.all([transaction.get(reviewRef), transaction.get(reportRef)]);
          if (!review.exists) throw new ReviewSystemError("Review not found", 404);
          if (report.exists) throw new ReviewSystemError("You have already reported this review", 409);
          transaction.create(reportRef, { reason, userId: user.uid, createdAt: FieldValue.serverTimestamp() });
          transaction.update(reviewRef, { reportCount: FieldValue.increment(1) });
        });
        res.json({ success: true });
        return;
      }

      if (action === "reply") {
        if (!dependencies.isAdminEmail(user.email)) throw new ReviewSystemError("Seller access required", 403);
        const reply = cleanReviewText(req.body?.reply, "Seller reply", 2, 2000);
        const review = await reviewRef.get();
        if (!review.exists) throw new ReviewSystemError("Review not found", 404);
        if (review.data()?.productId !== productId) throw new ReviewSystemError("Review product mismatch", 400);
        await reviewRef.update({
          sellerReply: reply,
          sellerReplyAt: FieldValue.serverTimestamp(),
          sellerReplyBy: "Zyro.lk Seller",
        });
        res.json({ success: true });
        return;
      }

      throw new ReviewSystemError("Unsupported review action");
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post("/api/review-system/questions", authenticate, async (req, res) => {
    try {
      const user = res.locals.reviewUser as DecodedIdToken;
      const action = String(req.body?.action || "");
      const productId = cleanProductId(req.body?.productId);
      const questionId = typeof req.body?.questionId === "string" ? req.body.questionId.trim() : "";
      const questionRef = questionId
        ? dependencies.db.collection("productQuestions").doc(questionId)
        : dependencies.db.collection("productQuestions").doc();

      if (action === "create") {
        const question = cleanReviewText(req.body?.question, "Question", 8, 1000);
        const product = await dependencies.db.collection("products").doc(productId).get();
        if (!product.exists) throw new ReviewSystemError("Product not found", 404);
        await questionRef.create({
          schemaVersion: 1,
          productId,
          userId: user.uid,
          customerName: safeDisplayName(user),
          question,
          answered: false,
          helpfulCount: 0,
          notHelpfulCount: 0,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        res.status(201).json({ success: true, questionId: questionRef.id });
        return;
      }

      if (!questionId) throw new ReviewSystemError("Question ID is required");

      if (action === "update" || action === "delete") {
        await dependencies.db.runTransaction(async (transaction) => {
          const snapshot = await transaction.get(questionRef);
          if (!snapshot.exists) throw new ReviewSystemError("Question not found", 404);
          if (snapshot.data()?.userId !== user.uid) throw new ReviewSystemError("You can only manage your own question", 403);
          if (snapshot.data()?.productId !== productId) throw new ReviewSystemError("Question product mismatch", 400);
          if (action === "delete") transaction.delete(questionRef);
          else transaction.update(questionRef, {
            question: cleanReviewText(req.body?.question, "Question", 8, 1000),
            updatedAt: FieldValue.serverTimestamp(),
          });
        });
        res.json({ success: true });
        return;
      }

      if (action === "vote") {
        await applyVote(dependencies.db, "productQuestions", questionId, user.uid, req.body?.vote);
        res.json({ success: true });
        return;
      }

      if (action === "reply") {
        if (!dependencies.isAdminEmail(user.email)) throw new ReviewSystemError("Seller access required", 403);
        const answer = cleanReviewText(req.body?.answer, "Answer", 2, 2000);
        const question = await questionRef.get();
        if (!question.exists) throw new ReviewSystemError("Question not found", 404);
        if (question.data()?.productId !== productId) throw new ReviewSystemError("Question product mismatch", 400);
        await questionRef.update({
          answer,
          answered: true,
          answeredAt: FieldValue.serverTimestamp(),
          answeredBy: "Zyro.lk Seller",
        });
        res.json({ success: true });
        return;
      }

      throw new ReviewSystemError("Unsupported question action");
    } catch (error) {
      sendError(res, error);
    }
  });
}
