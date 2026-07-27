import { useEffect, useState } from 'react';
import { collection, limit, onSnapshot, orderBy, query } from 'firebase/firestore';
import { onIdTokenChanged } from 'firebase/auth';
import { auth, db } from '../../../firebase';
import { getSupplierApi } from '../../../services/supplierHubApi';
import type {
  AIManagerSupplierPendingChangeInput,
  AIManagerSupplierSourceInput,
  AIManagerSupplierSyncInput,
} from '../types/snapshot';
import type { SupplierReviewQueueItem } from '../../../types';

const AI_MANAGER_SUPPLIER_LIMIT = 100;

export interface AIManagerSupplierData {
  supplierSources: AIManagerSupplierSourceInput[];
  supplierReviewQueue: SupplierReviewQueueItem[];
  supplierPendingChanges: AIManagerSupplierPendingChangeInput[];
  supplierSyncHistory: AIManagerSupplierSyncInput[];
}

const EMPTY_SUPPLIER_DATA: AIManagerSupplierData = {
  supplierSources: [],
  supplierReviewQueue: [],
  supplierPendingChanges: [],
  supplierSyncHistory: [],
};

export function useAIManagerSupplierData(): AIManagerSupplierData {
  const [supplierData, setSupplierData] = useState<AIManagerSupplierData>(EMPTY_SUPPLIER_DATA);

  useEffect(() => onIdTokenChanged(auth, (currentUser) => {
    if (!currentUser) {
      setSupplierData(EMPTY_SUPPLIER_DATA);
      return;
    }
    void getSupplierApi('/api/supplier-sources')
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as { success?: boolean; sources?: AIManagerSupplierSourceInput[] };
        if (response.ok && result.success === true && Array.isArray(result.sources)) {
          setSupplierData((current) => ({ ...current, supplierSources: result.sources || [] }));
        }
      })
      .catch(() => undefined);
  }), []);

  useEffect(() => {
    const unsubscribeReviewQueue = onSnapshot(
      query(collection(db, 'supplier_review_queue'), orderBy('createdAt', 'desc'), limit(AI_MANAGER_SUPPLIER_LIMIT)),
      (snapshot) => setSupplierData((current) => ({
        ...current,
        supplierReviewQueue: snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() } as SupplierReviewQueueItem & { queueState?: string }))
          .filter((item) => !item.queueState || ['review_pending', 'conflict'].includes(item.queueState)),
      })),
    );
    const unsubscribePendingChanges = onSnapshot(
      query(collection(db, 'supplier_pending_changes'), orderBy('detectedAt', 'desc'), limit(AI_MANAGER_SUPPLIER_LIMIT)),
      (snapshot) => setSupplierData((current) => ({
        ...current,
        supplierPendingChanges: snapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
      })),
    );
    const unsubscribeSyncHistory = onSnapshot(
      query(collection(db, 'supplier_sync_history'), orderBy('createdAt', 'desc'), limit(AI_MANAGER_SUPPLIER_LIMIT)),
      (snapshot) => setSupplierData((current) => ({
        ...current,
        supplierSyncHistory: snapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
      })),
    );

    return () => {
      unsubscribeReviewQueue();
      unsubscribePendingChanges();
      unsubscribeSyncHistory();
    };
  }, []);

  return supplierData;
}
