import { Product } from '../../types';
import { InboundProduct, SyncConfig } from '../sync-engine/types';
import { SandboxSessionState, SandboxPreviewReport, SandboxApprovalPayload, SandboxRollbackPayload } from './SandboxTypes';
import { SandboxComparator } from './SandboxComparator';
import { SandboxReporter } from './SandboxReporter';
import { SandboxImporter } from './SandboxImporter';

export class SandboxSession {
  private state: SandboxSessionState;

  constructor(id: string, supplierId: string, supplierName: string, config: any) {
    this.state = {
      id,
      supplierId,
      supplierName,
      status: 'initialized',
      config,
      createdAt: new Date().toISOString()
    };
  }

  public getState(): SandboxSessionState {
    return { ...this.state };
  }

  /**
   * Analyzes an inbound batch within the context of this sandbox session.
   * Runs validation, detects changes, filters duplicates, and creates report structures.
   */
  public async analyzeInboundBatch(
    inboundItems: InboundProduct[],
    existingProducts: Product[],
    config: SyncConfig,
    triggeredBy?: string
  ): Promise<SandboxPreviewReport> {
    if (this.state.status !== 'initialized' && this.state.status !== 'analyzed') {
      throw new Error(`Cannot analyze batch: Sandbox session is currently in '${this.state.status}' status.`);
    }

    const analysis = await SandboxComparator.analyzeSandboxBatch(
      inboundItems,
      existingProducts,
      config
    );

    const report = SandboxReporter.generateReport({
      sessionId: this.state.id,
      supplierId: this.state.supplierId,
      supplierName: this.state.supplierName,
      previews: analysis.previews,
      duplicateSkuCodes: analysis.duplicateSkuCodes,
      missingRequiredFieldsSkuCodes: analysis.missingRequiredFieldsSkuCodes,
      invalidImagesSkuCodes: analysis.invalidImagesSkuCodes,
    });

    const payloads = await SandboxImporter.prepareImportPayloads({
      sessionId: this.state.id,
      supplierId: this.state.supplierId,
      supplierName: this.state.supplierName,
      previews: analysis.previews,
      existingProducts,
      triggeredBy
    });

    this.state.status = 'analyzed';
    this.state.analyzedAt = new Date().toISOString();
    this.state.report = report;
    this.state.approvalPayload = payloads.approvalPayload;
    this.state.rollbackPayload = payloads.rollbackPayload;

    return report;
  }

  /**
   * Simulates/Prepares approval completion.
   * Transitions status and returns the final approval structures.
   */
  public async approveSession(): Promise<SandboxApprovalPayload> {
    if (this.state.status !== 'analyzed') {
      throw new Error('Cannot approve session: Sandbox has not been analyzed or is already finalized.');
    }

    if (!this.state.approvalPayload) {
      throw new Error('Approval payload is missing from session state.');
    }

    this.state.status = 'approved';
    return this.state.approvalPayload;
  }

  /**
   * Simulates/Prepares rollback processing.
   * Transitions status and returns original structures to restore.
   */
  public async rollbackSession(): Promise<SandboxRollbackPayload> {
    if (this.state.status !== 'approved') {
      throw new Error('Cannot rollback session: Only approved sessions can be rolled back.');
    }

    if (!this.state.rollbackPayload) {
      throw new Error('Rollback payload is missing from session state.');
    }

    this.state.status = 'rolled_back';
    return this.state.rollbackPayload;
  }

  /**
   * Terminates or expires the session.
   */
  public async expireSession(): Promise<void> {
    this.state.status = 'expired';
  }
}
