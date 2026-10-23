import { expect, vi } from "vitest";
import type { AdapterContext } from "../src";

/** One expected request and its canned response, in order. */
export interface Expected {
  method: "GET" | "POST";
  /** Origin + path, no query string. */
  url: string;
  /** Exact query parameters (GET) */
  query?: Record<string, string>;
  /** Exact form body (form POST) */
  form?: Record<string, string>;
  /** Exact JSON body (JSON POST); the token is then expected in the query. */
  json?: unknown;
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

/**
 * A `ctx.fetch` that asserts each request against the next expectation,
 * exactly (path, query and body), and fails on anything unexpected.
 */
export function mockMeta(expected: Expected[], opts: { now?: Date } = {}) {
  const queue = [...expected];
  const logs: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const e = queue.shift();
    const url = new URL(String(input));
    if (!e) throw new Error(`unexpected request ${init?.method} ${url.origin}${url.pathname}`);
    expect(init?.method).toBe(e.method);
    expect(`${url.origin}${url.pathname}`).toBe(e.url);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    if (e.method === "GET") {
      expect(Object.fromEntries(url.searchParams)).toEqual(e.query ?? {});
    } else if (e.json !== undefined) {
      expect(JSON.parse(String(init?.body))).toEqual(e.json);
      expect(Object.fromEntries(url.searchParams)).toEqual(e.query ?? {});
    } else {
      expect(url.search).toBe("");
      expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual(e.form ?? {});
    }
    return new Response(JSON.stringify(e.body), {
      status: e.status ?? 200,
      headers: { "content-type": "application/json", ...e.headers },
    });
  });
  const ctx: AdapterContext = {
    fetch: fetch as unknown as typeof globalThis.fetch,
    log: { info: (m) => logs.push(`info: ${m}`), error: (m) => logs.push(`error: ${m}`) },
    now: () => opts.now ?? new Date("2026-10-23T12:00:00Z"),
  };
  return {
    ctx,
    fetch,
    logs,
    /** Assert every expected request was made. */
    done: () => expect(queue.map((q) => `${q.method} ${q.url}`)).toEqual([]),
  };
}

/** Run `fn` and return the error it throws (fails if it doesn't). */
export async function caught(fn: () => Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await fn();
  } catch (e) {
    return e as Error & Record<string, unknown>;
  }
  throw new Error("expected an error");
}
