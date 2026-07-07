import { doc, getDoc, getDocs, collection, updateDoc } from 'firebase/firestore';
import { db, OperationType, handleFirestoreError } from '../../firebase';
import { SupplierSource } from './types';

export class SourceRegistry {
  private static readonly COLLECTION_NAME = 'supplierHub';

  /**
   * Fetches all registered supplier sources from Firestore.
   */
  public static async getSources(): Promise<SupplierSource[]> {
    try {
      const snap = await getDocs(collection(db, this.COLLECTION_NAME));
      const list: SupplierSource[] = [];
      snap.forEach(d => {
        list.push({ id: d.id, ...d.data() } as SupplierSource);
      });
      return list;
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, this.COLLECTION_NAME);
      throw error;
    }
  }

  /**
   * Retrieves a single supplier source by its identifier.
   */
  public static async getSourceById(id: string): Promise<SupplierSource | null> {
    try {
      const docSnap = await getDoc(doc(db, this.COLLECTION_NAME, id));
      if (!docSnap.exists()) {
        return null;
      }
      return { id: docSnap.id, ...docSnap.data() } as SupplierSource;
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `${this.COLLECTION_NAME}/${id}`);
      throw error;
    }
  }

  /**
   * Updates sync metrics, timestamps, and connection status for a specific supplier source.
   */
  public static async updateSyncStatus(
    id: string,
    updates: Partial<Omit<SupplierSource, 'id'>>
  ): Promise<void> {
    try {
      await updateDoc(doc(db, this.COLLECTION_NAME, id), updates);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `${this.COLLECTION_NAME}/${id}`);
    }
  }
}
