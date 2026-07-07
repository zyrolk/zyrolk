import { SandboxSession } from './SandboxSession';

export class SandboxManager {
  private static sessions = new Map<string, SandboxSession>();

  /**
   * Initializes a fresh, in-memory Sandbox Session.
   */
  public static async createSession(
    supplierId: string,
    supplierName: string,
    config: any = {}
  ): Promise<SandboxSession> {
    const sessionId = `sb-sess-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const session = new SandboxSession(sessionId, supplierId, supplierName, config);
    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Retrieves an active Sandbox Session wrapper.
   */
  public static async getSession(sessionId: string): Promise<SandboxSession | undefined> {
    return this.sessions.get(sessionId);
  }

  /**
   * Lists all active Sandbox Sessions currently running in-memory.
   */
  public static async listActiveSessions(): Promise<SandboxSession[]> {
    return Array.from(this.sessions.values());
  }

  /**
   * Removes or expires a Sandbox Session from the cache.
   */
  public static async removeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.expireSession();
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Clears all cached Sandbox Sessions.
   */
  public static async clearAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.expireSession();
    }
    this.sessions.clear();
  }
}
export { SandboxManager as SandboxManagerService };
