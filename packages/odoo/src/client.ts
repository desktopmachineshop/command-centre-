/**
 * Odoo external API client. Odoo Online allows no custom modules, so everything
 * goes through the external API with an API key in place of the password.
 *
 * - `jsonrpc` (default): `POST /jsonrpc` with the `common` and `object` services.
 *   Works on Odoo 14+, deprecated from 19 (removal planned for Odoo 22 / Online 21.1).
 * - `json2`: Odoo 19+ `POST /json/2/<model>/<method>` with a bearer API key and named args.
 */

export type OdooApi = "jsonrpc" | "json2";
export type Domain = unknown[];
export type OdooRecord = Record<string, unknown> & { id: number };
export type OdooContext = Record<string, unknown>;

export interface OdooClientOptions {
  /** Instance URL, e.g. https://mycompany.odoo.com (no trailing slash needed). */
  url: string;
  db: string;
  username: string;
  apiKey: string;
  api?: OdooApi;
  /** Per-request timeout. Default 30s. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export interface SearchReadOptions {
  limit?: number;
  offset?: number;
  order?: string;
  context?: OdooContext;
}

/** What read-only consumers (the MCP server) may use. Writes go through executors. */
export type OdooReader = Pick<OdooClient, "searchRead" | "read" | "searchCount" | "fields" | "fieldDefs">;

/** What `fields_get` says about one field (the attributes the generic tools and actions use). */
export interface OdooFieldDef {
  type: string;
  /** The label Odoo shows. */
  string?: string;
  required?: boolean;
  /** True for computed fields without an inverse and for fields Odoo sets itself. */
  readonly?: boolean;
  /** The other model of a many2one, one2many or many2many. */
  relation?: string;
  /** `[value, label]` pairs of a selection field. */
  selection?: [string | number, string][];
  /** False for fields that aren't columns (computed on read). */
  store?: boolean;
}
export type OdooFieldDefs = Record<string, OdooFieldDef>;
const FIELD_ATTRIBUTES = ["type", "string", "required", "readonly", "relation", "selection", "store"];

export class OdooError extends Error {
  override name = "OdooError";
}
/** Network failure, non-2xx without an Odoo error body, or an unparseable response. */
export class OdooHttpError extends OdooError {
  override name = "OdooHttpError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}
export class OdooTimeoutError extends OdooError {
  override name = "OdooTimeoutError";
}
/** Wrong database, login or API key. */
export class OdooAuthError extends OdooError {
  override name = "OdooAuthError";
}

export type OdooRpcErrorKind = "missing_field" | "missing_model" | "access" | "user" | "server";

/** An exception raised inside Odoo, classified so callers can degrade instead of failing. */
export class OdooRpcError extends OdooError {
  override name = "OdooRpcError";
  constructor(
    message: string,
    readonly kind: OdooRpcErrorKind,
    /** Odoo's exception class, e.g. "odoo.exceptions.AccessError". */
    readonly odooName: string,
    readonly debug?: string,
  ) {
    super(message);
  }
}

function classify(odooName: string, message: string): OdooRpcErrorKind | "auth" {
  if (/AccessDenied|Unauthorized/.test(odooName) || /invalid api ?key/i.test(message)) return "auth";
  if (/AccessError/.test(odooName)) return "access";
  if (/Invalid field|Unknown field|has no attribute|no field/i.test(message)) return "missing_field";
  if (/KeyError/.test(odooName) || /doesn't exist|does not exist|Unknown model|model not found/i.test(message)) return "missing_model";
  if (/UserError|ValidationError|MissingError/.test(odooName)) return "user";
  return "server";
}

function rpcError(odooName: string, message: string, debug?: string): OdooError {
  const kind = classify(odooName, message);
  if (kind === "auth") return new OdooAuthError(message || "Odoo rejected the credentials");
  return new OdooRpcError(message || odooName, kind, odooName, debug);
}

/** Odoo's 'False' for an empty value is noise for agents: make it null. */
export function clean<T>(value: T): T | null {
  return value === false ? null : value;
}

export class OdooClient {
  readonly api: OdooApi;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private uid?: Promise<number>;
  private readonly fieldCache = new Map<string, Promise<Set<string> | null>>();
  private readonly defCache = new Map<string, Promise<OdooFieldDefs | null>>();
  private nextId = 1;

  constructor(private readonly options: OdooClientOptions) {
    this.api = options.api ?? "jsonrpc";
    this.url = options.url.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchFn = options.fetch ?? fetch;
  }

  /** The user id for the API key. Cached; concurrent callers share one request. */
  authenticate(): Promise<number> {
    this.uid ??= this.login().catch((err) => {
      this.uid = undefined;
      throw err;
    });
    return this.uid;
  }

  async searchRead(model: string, domain: Domain, fields: string[], options: SearchReadOptions = {}): Promise<OdooRecord[]> {
    const kwargs = { fields, ...stripUndefined(options) };
    if (this.api === "json2") return (await this.json2(model, "search_read", { domain, ...kwargs })) as OdooRecord[];
    return (await this.executeKw(model, "search_read", [domain], kwargs)) as OdooRecord[];
  }

  async searchCount(model: string, domain: Domain, context?: OdooContext): Promise<number> {
    return (await this.call(model, "search_count", [], { domain, ...stripUndefined({ context }) })) as number;
  }

  async read(model: string, ids: number[], fields: string[], context?: OdooContext): Promise<OdooRecord[]> {
    return (await this.call(model, "read", [ids], { fields, ...stripUndefined({ context }) })) as OdooRecord[];
  }

  async create(model: string, values: Record<string, unknown>, context?: OdooContext): Promise<number> {
    if (this.api === "json2") {
      const ids = (await this.json2(model, "create", { vals_list: [values], ...stripUndefined({ context }) })) as number[] | number;
      return Array.isArray(ids) ? ids[0]! : ids;
    }
    return (await this.executeKw(model, "create", [values], stripUndefined({ context }))) as number;
  }

  async write(model: string, ids: number[], values: Record<string, unknown>, context?: OdooContext): Promise<boolean> {
    return (await this.call(model, "write", [ids], { vals: values, ...stripUndefined({ context }) })) as boolean;
  }

  /**
   * Any model method. `args[0]` may be the record ids; everything else should
   * be named in `kwargs` so the call works on both APIs.
   */
  async call(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    if (this.api === "json2") {
      if (args.length > 1) throw new OdooError(`json2 calls take ids plus named arguments; pass ${method}'s arguments in kwargs`);
      return this.json2(model, method, args.length ? { ids: args[0], ...kwargs } : kwargs);
    }
    return this.executeKw(model, method, args, kwargs);
  }

  /**
   * The model's field names, cached, or null when the model isn't installed.
   * Tools use it to ask only for fields this Odoo version and its modules have.
   */
  fields(model: string): Promise<Set<string> | null> {
    let cached = this.fieldCache.get(model);
    if (!cached) {
      cached = (this.call(model, "fields_get", [], { attributes: ["type"] }) as Promise<Record<string, unknown>>).then(
        (defs) => new Set(Object.keys(defs)),
        (err) => {
          this.fieldCache.delete(model);
          if (err instanceof OdooRpcError && err.kind === "missing_model") return null;
          throw err;
        },
      );
      this.fieldCache.set(model, cached);
    }
    return cached;
  }

  /**
   * The model's fields with their type, label, required/readonly flags, relation and selection
   * choices (cached), or null when the model isn't installed. Heavier than `fields`: only the
   * generic tools and actions (describe_model, odoo.record.*) ask for it.
   */
  fieldDefs(model: string): Promise<OdooFieldDefs | null> {
    let cached = this.defCache.get(model);
    if (!cached) {
      cached = (this.call(model, "fields_get", [], { attributes: FIELD_ATTRIBUTES }) as Promise<OdooFieldDefs>).then(
        (defs) => defs,
        (err) => {
          this.defCache.delete(model);
          if (err instanceof OdooRpcError && err.kind === "missing_model") return null;
          throw err;
        },
      );
      this.defCache.set(model, cached);
    }
    return cached;
  }

  private async login(): Promise<number> {
    const { db, username, apiKey } = this.options;
    if (this.api === "json2") {
      const ids = (await this.json2("res.users", "search", { domain: [["login", "=", username]], limit: 1 })) as number[];
      if (!ids[0]) throw new OdooAuthError(`No Odoo user with login ${username}`);
      return ids[0];
    }
    const uid = await this.jsonrpc("common", "authenticate", [db, username, apiKey, {}]);
    if (typeof uid !== "number" || !uid) throw new OdooAuthError(`Odoo rejected login ${username} on database ${db}`);
    return uid;
  }

  private async executeKw(model: string, method: string, args: unknown[], kwargs: Record<string, unknown>): Promise<unknown> {
    const uid = await this.authenticate();
    try {
      return await this.jsonrpc("object", "execute_kw", [this.options.db, uid, this.options.apiKey, model, method, args, kwargs]);
    } catch (err) {
      if (err instanceof OdooAuthError) this.uid = undefined; // key revoked or rotated
      throw err;
    }
  }

  private async jsonrpc(service: string, method: string, args: unknown[]): Promise<unknown> {
    const body = { jsonrpc: "2.0", method: "call", params: { service, method, args }, id: this.nextId++ };
    const { status, json } = await this.post(`${this.url}/jsonrpc`, body, {});
    if (!json || typeof json !== "object") throw new OdooHttpError(`Odoo returned HTTP ${status} without JSON`, status);
    const res = json as { result?: unknown; error?: { message?: string; data?: { name?: string; message?: string; debug?: string } } };
    if (res.error) {
      const data = res.error.data ?? {};
      throw rpcError(data.name ?? "", data.message ?? res.error.message ?? "Odoo error", data.debug);
    }
    if (status >= 400) throw new OdooHttpError(`Odoo returned HTTP ${status}`, status);
    return res.result;
  }

  private async json2(model: string, method: string, body: Record<string, unknown>): Promise<unknown> {
    const headers = { Authorization: `bearer ${this.options.apiKey}`, "X-Odoo-Database": this.options.db };
    const { status, json } = await this.post(`${this.url}/json/2/${model}/${method}`, body, headers);
    if (status >= 400) {
      const err = (json ?? {}) as { name?: string; message?: string; debug?: string };
      if (status === 401) throw new OdooAuthError(err.message || "Odoo rejected the API key");
      if (err.name || err.message) throw rpcError(err.name ?? "", err.message ?? "", err.debug);
      if (status === 404) throw new OdooRpcError(`Unknown model or method ${model}.${method}`, "missing_model", "NotFound");
      throw new OdooHttpError(`Odoo returned HTTP ${status}`, status);
    }
    return json;
  }

  private async post(url: string, body: unknown, headers: Record<string, string>): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "user-agent": "command-centre", ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        if (res.ok) throw new OdooHttpError(`Odoo returned invalid JSON (HTTP ${res.status})`, res.status);
      }
      return { status: res.status, json };
    } catch (err) {
      if (err instanceof OdooError) throw err;
      if (controller.signal.aborted) throw new OdooTimeoutError(`Odoo did not answer within ${this.timeoutMs}ms`);
      throw new OdooHttpError(`Could not reach Odoo: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
