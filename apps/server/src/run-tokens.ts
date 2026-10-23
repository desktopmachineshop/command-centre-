import { randomBytes } from "node:crypto";

export interface RunScope {
  taskId: string;
  runId: string;
  vertical: string;
}

/**
 * Short-lived bearer tokens handed to agent runs so their MCP calls back into
 * the server are tied to the task (and vertical) they belong to.
 */
export class RunTokens {
  private readonly scopes = new Map<string, RunScope>();

  issue(scope: RunScope): string {
    const token = `run_${randomBytes(24).toString("base64url")}`;
    this.scopes.set(token, scope);
    return token;
  }

  lookup(token: string): RunScope | undefined {
    return this.scopes.get(token);
  }

  revoke(token: string): void {
    this.scopes.delete(token);
  }
}
