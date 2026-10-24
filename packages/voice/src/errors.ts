/** A provider call failed. The message never contains the API key. */
export class VoiceProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}

/** Replaces every secret (and common key shapes) in `text`, so errors are safe to log and return. */
export function redact(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join("[redacted]");
  return out
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(xi-api-key|authorization|api[_-]?key)(["':=\s]+)(Bearer\s+)?[^\s"',}]+/gi, "$1$2[redacted]");
}

/** Builds a redacted error from a non-2xx response, keeping the provider's own message short. */
export async function errorFromResponse(provider: string, res: Response, secrets: (string | undefined)[]): Promise<VoiceProviderError> {
  const raw = await res.text().catch(() => "");
  let detail = raw;
  try {
    const body = JSON.parse(raw) as { error?: { message?: string } | string; detail?: { message?: string } | string; message?: string };
    const pick = (v: unknown) => (typeof v === "string" ? v : typeof (v as { message?: unknown })?.message === "string" ? (v as { message: string }).message : null);
    detail = pick(body.error) ?? pick(body.detail) ?? pick(body.message) ?? raw;
  } catch {
    // not JSON
  }
  const message = `${provider} ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`;
  return new VoiceProviderError(provider, res.status, redact(message, secrets));
}

/** Wraps network failures (DNS, reset) so the key can't leak through an error message. */
export async function call(provider: string, secrets: (string | undefined)[], run: () => Promise<Response>): Promise<Response> {
  let res: Response;
  try {
    res = await run();
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new VoiceProviderError(provider, null, redact(`${provider} request failed: ${(err as Error).message}`, secrets));
  }
  if (!res.ok) throw await errorFromResponse(provider, res, secrets);
  return res;
}
