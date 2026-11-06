import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Codex's ChatGPT sign-in is a file, CODEX_HOME/auth.json, which Codex itself rewrites when it
 * refreshes its tokens (the old refresh token then stops working). So the server keeps one
 * CODEX_HOME on the volume and treats the saved sign-in (Accounts page, or CODEX_AUTH_JSON) as
 * the seed:
 *
 * - before a run, auth.json is written from the saved sign-in only when that sign-in changed
 *   (a new Connect), so tokens Codex refreshed since are never overwritten by older ones;
 * - after a run, a refreshed auth.json is saved back over the stored sign-in (`onRotate`), so it
 *   survives a lost volume and a later reseed starts from the newest tokens.
 *
 * Nothing here logs or returns the file's contents.
 */
export class CodexHome {
  private lastSaved: string | undefined;

  constructor(
    readonly dir: string,
    private readonly onRotate: (authJson: string) => Promise<void> = async () => {},
  ) {}

  private get authFile() {
    return join(this.dir, "auth.json");
  }

  private get seedFile() {
    return join(this.dir, "seeded-from.sha256");
  }

  /** Makes auth.json match `stored` if it changed; returns why a run can't start, or null. */
  async prepare(stored: string | undefined): Promise<string | null> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    if (!stored) {
      // Disconnected: don't keep running on a sign-in the Accounts page no longer has.
      await rm(this.authFile, { force: true });
      await rm(this.seedFile, { force: true });
      return "ChatGPT (Codex) isn't connected. Connect it on the Accounts page (AI → ChatGPT (Codex)).";
    }
    const problem = codexAuthProblem(stored);
    if (problem) return `The saved ChatGPT (Codex) sign-in can't be used: ${problem}. Connect it again on the Accounts page.`;
    const hash = sha256(stored);
    const seeded = await readFile(this.seedFile, "utf8").catch(() => null);
    const present = await readFile(this.authFile, "utf8").then(() => true, () => false);
    if (seeded?.trim() !== hash || !present) {
      await writeFile(this.authFile, stored, { mode: 0o600 });
      await chmod(this.authFile, 0o600);
      await writeFile(this.seedFile, hash);
    }
    return null;
  }

  /** Saves auth.json back if Codex refreshed it during the run. */
  async afterRun(stored: string | undefined): Promise<void> {
    if (!stored) return;
    const current = await readFile(this.authFile, "utf8").catch(() => null);
    if (!current || current === stored || current === this.lastSaved || codexAuthProblem(current)) return;
    await this.onRotate(current);
    this.lastSaved = current;
  }
}

export interface CodexAuthInfo {
  email?: string;
  plan?: string;
}

/**
 * Why a pasted or saved auth.json can't run agents on a ChatGPT plan, or null if it can. An
 * API-key-only file is refused: it would bill API credits, which is what this route avoids.
 */
export function codexAuthProblem(json: string): string | null {
  let auth: any;
  try {
    auth = JSON.parse(json);
  } catch {
    return "it isn't the JSON from ~/.codex/auth.json";
  }
  if (!auth || typeof auth !== "object") return "it isn't the JSON from ~/.codex/auth.json";
  const tokens = auth.tokens;
  if (!tokens || typeof tokens.refresh_token !== "string" || !tokens.refresh_token) {
    return auth.OPENAI_API_KEY ? "it holds an API key, not a ChatGPT sign-in (run `codex login` and choose Sign in with ChatGPT)" : "it has no ChatGPT sign-in tokens";
  }
  return null;
}

/** The account and plan named in the sign-in's id token (for the Accounts page; never verified). */
export function codexAuthInfo(json: string): CodexAuthInfo {
  try {
    const idToken = JSON.parse(json)?.tokens?.id_token;
    if (typeof idToken !== "string") return {};
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8"));
    const auth = payload?.["https://api.openai.com/auth"] ?? {};
    return {
      email: typeof payload?.email === "string" ? payload.email : undefined,
      plan: typeof auth.chatgpt_plan_type === "string" ? auth.chatgpt_plan_type : undefined,
    };
  } catch {
    return {};
  }
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
