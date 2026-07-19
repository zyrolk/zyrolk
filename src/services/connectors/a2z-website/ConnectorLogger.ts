import { doc, setDoc } from 'firebase/firestore';
import { db, OperationType, handleFirestoreError } from '../../../firebase';
import { ConnectorLogEntry } from './types';

export class ConnectorLogger {
  private static readonly LOGS_COLLECTION = 'supplierSyncLogs';
  private static readonly CONSOLE_ENABLED = typeof window !== 'undefined'
    && ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);

  /**
   * Logs an operational event from the connector modules.
   * Prints structured console output and records the telemetry in the database logs when appropriate.
   */
  public static async log(
    level: ConnectorLogEntry['level'],
    module: string,
    message: string,
    details?: Record<string, any>
  ): Promise<ConnectorLogEntry> {
    const id = `clog-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const timestamp = new Date().toISOString();

    const entry: ConnectorLogEntry = {
      id,
      timestamp,
      level,
      module,
      message,
      details
    };

    if (this.CONSOLE_ENABLED) {
      const formattedConsoleMsg = `[A2Z-Website-Connector][${level.toUpperCase()}][${module}] ${message}`;
      if (level === 'error') {
        console.error(formattedConsoleMsg, details || '');
      } else if (level === 'warn') {
        console.warn(formattedConsoleMsg, details || '');
      } else {
        console.info(formattedConsoleMsg, details || '');
      }
    }

    try {
      // In future stages, this telemetry can be written to firestore for administrative dashboards.
      // We leverage setDoc on a generic log document to persist sync telemetry history.
      const logDocRef = doc(db, this.LOGS_COLLECTION, id);
      await setDoc(logDocRef, {
        id,
        supplierName: 'A2Z Smart Tech',
        timestamp: new Date().toLocaleString(),
        status: level === 'error' ? 'failed' : 'success',
        error: level === 'error' ? message : 'None',
        triggeredBy: 'A2Z_Connector_Service',
        module,
        ...details
      });
    } catch (e) {
      if (this.CONSOLE_ENABLED) console.warn('Logging telemetry write skipped or failed:', e);
    }

    return entry;
  }
}
