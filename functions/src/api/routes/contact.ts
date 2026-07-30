import * as express from "express";
import { FieldValue, Firestore } from "firebase-admin/firestore";
import {
  CONTACT_RATE_LIMIT_COLLECTION,
  CONTACT_RATE_LIMIT_WINDOW_MS,
  ContactInquiryError,
  contactRateLimitDocumentId,
  nextContactRateLimitState,
  validateContactInquiry,
} from "../contact/contactInquiries";
import { appLogger } from "../logging";

interface ContactRouteDependencies {
  db: Firestore;
  now?: () => number;
}

const networkIdentity = (req: express.Request): string => {
  const forwarded = (req.header("x-forwarded-for") || "").split(",")[0].trim();
  return (forwarded || req.ip || "unknown").slice(0, 180);
};

export function registerContactRoutes(app: express.Express, dependencies: ContactRouteDependencies): void {
  app.post("/api/contact-inquiries", async (req, res) => {
    try {
      const inquiry = validateContactInquiry(req.body);
      const now = (dependencies.now || Date.now)();
      const networkLimitReference = dependencies.db.collection(CONTACT_RATE_LIMIT_COLLECTION)
        .doc(contactRateLimitDocumentId("network", networkIdentity(req)));
      const phoneLimitReference = dependencies.db.collection(CONTACT_RATE_LIMIT_COLLECTION)
        .doc(contactRateLimitDocumentId("phone", inquiry.phone.replace(/\D/gu, "")));
      const inquiryReference = dependencies.db.collection("contact_inquiries").doc();

      await dependencies.db.runTransaction(async (transaction) => {
        const [networkLimit, phoneLimit] = await Promise.all([
          transaction.get(networkLimitReference),
          transaction.get(phoneLimitReference),
        ]);
        const networkState = nextContactRateLimitState(networkLimit.exists ? networkLimit.data() || null : null, now);
        const phoneState = nextContactRateLimitState(phoneLimit.exists ? phoneLimit.data() || null : null, now);
        const limitMetadata = {
          updatedAt: FieldValue.serverTimestamp(),
          expiresAt: new Date(now + (CONTACT_RATE_LIMIT_WINDOW_MS * 2)),
        };
        transaction.set(networkLimitReference, { ...networkState, ...limitMetadata }, { merge: true });
        transaction.set(phoneLimitReference, { ...phoneState, ...limitMetadata }, { merge: true });
        transaction.create(inquiryReference, {
          ...inquiry,
          status: "new",
          createdAt: FieldValue.serverTimestamp(),
        });
      });

      res.status(201).json({ success: true, inquiryId: inquiryReference.id });
    } catch (error) {
      const statusCode = error instanceof ContactInquiryError ? error.statusCode : 500;
      if (!(error instanceof ContactInquiryError)) {
        appLogger.error("Contact enquiry submission failed.", {
          route: "/api/contact-inquiries",
          error,
        });
      }
      res.status(statusCode).json({
        error: error instanceof ContactInquiryError
          ? error.message
          : "Your enquiry could not be sent. Please try again.",
      });
    }
  });
}
