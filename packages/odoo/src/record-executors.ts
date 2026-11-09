import { z } from "zod";
import { type OdooFieldDef, type OdooFieldDefs, OdooError, type OdooRecord, OdooRpcError } from "./client";
import type { OdooActionExecutor, OdooWriter } from "./executors";
import { parse } from "./payload";
import { denial, deniedField, deniedMethod, deniedModel, DRAFT_INVOICE_FIELDS } from "./write-policy";

/**
 * The generic Odoo writes: create, update, archive/unarchive and press a workflow button on any
 * model, for everything the specific actions don't cover. Like every `odoo.*` action they always
 * wait for Dave's approval. The values are checked against the model's own field definitions
 * when proposed and again when run, the approval carries a server-made preview (`recordPreview`:
 * names, before → after, possible duplicates), and the models in GENERIC_WRITE_DENYLIST are
 * refused outright. There is no delete: that is done in Odoo.
 */

const Id = z.number().int().positive();
const Model = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, "an Odoo model name, e.g. res.partner");
/** Most records one proposal may change. */
export const MAX_RECORD_IDS = 200;
const Ids = z
  .array(Id)
  .min(1)
  .max(MAX_RECORD_IDS)
  .transform((ids) => [...new Set(ids)]);
const Values = z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/, "a field name"), z.unknown()).refine((v) => Object.keys(v).length > 0, "has no fields");

const RecordCreate = z.object({ model: Model, values: Values });
const RecordUpdate = z.object({ model: Model, ids: Ids, values: Values });
const RecordIds = z.object({ model: Model, ids: Ids });
const RecordAction = z.object({ model: Model, ids: Ids, method: z.string().min(1) });

type Op = "create" | "update" | "archive" | "action";

const TEXT = new Set(["char", "text", "html"]);
const NUMBER = new Set(["float", "monetary"]);
const X2MANY = new Set(["one2many", "many2many"]);
const isId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
const realDay = (s: string) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

/**
 * One value checked against its field: the value to send to Odoo (x2many id lists become
 * `[[6, 0, ids]]`, null becomes false), or what is wrong with it. Pure, so the rules are testable
 * without an Odoo.
 */
export function checkValue(field: string, def: OdooFieldDef, raw: unknown): { value: unknown } | { error: string } {
  const bad = (expected: string) => ({ error: `${field} (${def.type}) takes ${expected}, got ${JSON.stringify(raw)?.slice(0, 60)}` });
  if (def.readonly) return { error: `${field} is read-only (computed or set by Odoo)` };
  const v = raw === null ? false : raw;
  if (v === false && def.type !== "boolean") {
    return def.required ? { error: `${field} is required and can't be emptied` } : { value: X2MANY.has(def.type) ? [[6, 0, []]] : false };
  }
  if (TEXT.has(def.type)) {
    if (typeof v !== "string") return bad("text");
    return def.required && !v.trim() ? { error: `${field} is required and can't be empty` } : { value: v };
  }
  if (def.type === "integer" || def.type === "many2one_reference") return typeof v === "number" && Number.isInteger(v) ? { value: v } : bad("a whole number");
  if (NUMBER.has(def.type)) return typeof v === "number" && Number.isFinite(v) ? { value: v } : bad("a number");
  if (def.type === "boolean") return typeof v === "boolean" ? { value: v } : bad("true or false");
  if (def.type === "many2one") return isId(v) ? { value: v } : bad(`the id of a ${def.relation ?? "record"} (a number), or false to clear it`);
  if (def.type === "date") return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && realDay(v) ? { value: v } : bad("a date, YYYY-MM-DD");
  if (def.type === "datetime") {
    const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?Z?$/.exec(v) : null;
    return m && realDay(m[1]!) ? { value: `${m[1]} ${m[2]}` } : bad("a UTC date and time, YYYY-MM-DD HH:MM:SS");
  }
  if (def.type === "selection") {
    const choices = def.selection ?? [];
    if (!choices.length) return typeof v === "string" || typeof v === "number" ? { value: v } : bad("one of its choices");
    return choices.some(([c]) => c === v) ? { value: v } : bad(`one of ${choices.map(([c, label]) => `${JSON.stringify(c)} (${label})`).join(", ")}`);
  }
  if (X2MANY.has(def.type)) {
    if (!Array.isArray(v)) return bad(`a list of ${def.relation ?? "record"} ids`);
    if (v.every(isId)) return { value: [[6, 0, [...new Set(v as number[])]]] };
    // Explicit commands pass through, except the ones that delete records.
    if (v.every((c) => Array.isArray(c) && typeof c[0] === "number" && c[0] >= 0 && c[0] <= 6)) {
      if ((v as unknown[][]).some((c) => c[0] === 2 || c[0] === 5)) return { error: `${field}: commands 2 (delete) and 5 (clear) are not allowed; deleting is done in Odoo` };
      return { value: v };
    }
    return bad("a list of ids, or a list of x2many commands like [[4, id], [0, 0, {…}]]");
  }
  if (def.type === "binary" || def.type === "image") return typeof v === "string" ? { value: v } : bad("base64 text");
  if (def.type === "reference") return typeof v === "string" && /^[a-z0-9_.]+,\d+$/.test(v) ? { value: v } : bad('"model,id"');
  return { value: v }; // json, properties and whatever a newer Odoo adds: Odoo checks those itself
}

/** Field names close to an unknown one: contains/contained, a small typo, or the same label. */
export function closeFields(defs: OdooFieldDefs, wanted: string, max = 5): string[] {
  const w = wanted.toLowerCase();
  const scored: [number, string][] = [];
  for (const [name, def] of Object.entries(defs)) {
    const label = (def.string ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const d = distance(w, name);
    const score = label === w ? 0 : d <= 2 ? d : name.includes(w) || (name.length > 3 && w.includes(name)) ? 3 : label.includes(w) && w.length > 3 ? 4 : -1;
    if (score >= 0) scored.push([score, name]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, max).map(([, n]) => n);
}

function distance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** Approval notes end the summary in one [bracketed] part, which an edit strips by its brackets: keep them out of the text. */
const unbracket = (s: string) => s.replace(/\[/g, "(").replace(/\]/g, ")");

/** A stored value as Dave reads it: many2one by name, selection by label, long text cut. */
function show(def: OdooFieldDef | undefined, v: unknown, names?: Map<number, string>): string {
  if (v === false || v === null || v === undefined || v === "") return def?.type === "boolean" ? "no" : "empty";
  if (v === true) return "yes";
  if (Array.isArray(v)) {
    if (v.length === 2 && typeof v[0] === "number" && typeof v[1] === "string") return clip(v[1]);
    if (v.every((x) => typeof x === "number")) return v.length ? `${v.length} linked (${v.slice(0, 5).map((id) => names?.get(id as number) ?? `#${id}`).join(", ")}${v.length > 5 ? ", …" : ""})` : "none";
    return `${v.length} change${v.length === 1 ? "" : "s"}`;
  }
  if (def?.type === "many2one" && typeof v === "number") return names?.get(v) ? clip(names.get(v)!) : `#${v}`;
  if (def?.type === "selection") return String(def.selection?.find(([c]) => c === v)?.[1] ?? v);
  if (def?.type === "binary" || def?.type === "image") return "(file)";
  if (typeof v === "string") return clip(def?.type === "html" ? plain(v) : v);
  return String(v);
}

/** Whether a record's stored value already equals the value to write. */
function same(def: OdooFieldDef, before: unknown, to: unknown): boolean {
  if (def.type === "many2one") return (Array.isArray(before) ? before[0] : before || false) === to;
  if (X2MANY.has(def.type)) {
    const set = Array.isArray(to) && to.length === 1 && Array.isArray(to[0]) && to[0][0] === 6 ? (to[0][2] as number[]) : null;
    return !!set && Array.isArray(before) && before.length === set.length && set.every((id) => (before as number[]).includes(id));
  }
  return (before ?? false) === to || ((before === false || before === undefined) && to === "");
}

export interface RecordChange {
  field: string;
  label: string;
  /** The current value(s): one string when every record has the same, else the commonest few with counts. */
  from: string | { value: string; records: number }[];
  to: string;
  /** How many of the records this actually changes. */
  changes: number;
}

/** What the server found in Odoo for an `odoo.record.*` approval. Stored as `recordPreview`, replacing anything the agent sent. */
export interface RecordPreview {
  model: string;
  label: string;
  count?: number;
  /** The records (the first ten when there are more). */
  records?: { id: number; name: string; state?: string }[];
  changes?: RecordChange[];
  /** The new record's values as Odoo will show them (create). */
  values?: Record<string, string>;
  duplicates?: { id: number; name: string; same: string; archived?: boolean }[] | string;
  method?: string;
}

const SAMPLE = 10;
/** Fields whose match on an existing record suggests the new one is a duplicate. */
const DUPLICATE_KEYS = ["name", "default_code", "email", "barcode", "vat", "ref"];

export function createRecordExecutors(client: OdooWriter): Record<string, OdooActionExecutor> {
  /** The model's definitions and label, after the denylist; refuses wizards and missing models. */
  async function modelFor(model: string, op: Op): Promise<{ defs: OdooFieldDefs; label: string }> {
    const rule = deniedModel(model);
    // The one exception inside a denied model: a draft invoice's simple fields (checked against the records in `guardInvoices`).
    if (rule && !(model === "account.move" && op === "update")) throw new OdooError(denial(model, rule));
    const defs = await client.fieldDefs(model);
    if (!defs) throw new OdooRpcError(`Odoo has no ${model} model (is its app installed? list_models finds models by name)`, "missing_model", "KeyError");
    // The label and the wizard check are best effort: an API user who can't read ir.model still gets the action.
    const row = await (async () => {
      const irFields = await client.fields("ir.model");
      if (!irFields) return undefined;
      return (await client.searchRead("ir.model", [["model", "=", model]], ["name", "transient"].filter((f) => irFields.has(f)), { limit: 1 }))[0];
    })().catch((err) => {
      if (err instanceof OdooError) return undefined;
      throw err;
    });
    if (row?.transient) throw new OdooError(`${model} is a wizard (a temporary form), not data: use the specific action for what it does, or do it in Odoo`);
    return { defs, label: typeof row?.name === "string" && row.name ? row.name : model };
  }

  /** Values checked field by field; every problem in one error. Returns what to send to Odoo. */
  async function checkValues(model: string, defs: OdooFieldDefs, values: Record<string, unknown>): Promise<{ send: Record<string, unknown>; names: Map<string, Map<number, string>> }> {
    const problems: string[] = [];
    const send: Record<string, unknown> = {};
    const names = new Map<string, Map<number, string>>();
    for (const [field, raw] of Object.entries(values)) {
      const def = defs[field];
      if (!def) {
        const close = closeFields(defs, field);
        problems.push(`${model} has no field "${field}"${close.length ? ` (did you mean ${close.join(", ")}?)` : ""}`);
        continue;
      }
      const secret = deniedField(field, def.relation);
      if (secret) {
        problems.push(denial(`${model}.${field}`, secret));
        continue;
      }
      if (model === "account.move" && !DRAFT_INVOICE_FIELDS.includes(field)) {
        problems.push(`${field} of an invoice can't be changed here: only ${DRAFT_INVOICE_FIELDS.join(", ")} of a draft invoice (rule "accounting-entries"). Use the odoo.invoice.* actions or Odoo`);
        continue;
      }
      if (X2MANY.has(def.type) && def.relation && deniedModel(def.relation)) {
        problems.push(denial(`${model}.${field} (a list of ${def.relation})`, deniedModel(def.relation)!));
        continue;
      }
      const checked = checkValue(field, def, raw);
      if ("error" in checked) {
        problems.push(checked.error);
        continue;
      }
      // Lines created or edited inside an x2many aren't checked field by field, but never carry a protected field.
      const nested = X2MANY.has(def.type) && Array.isArray(checked.value) ? (checked.value as unknown[][]).flatMap((c) => (c[2] && typeof c[2] === "object" && !Array.isArray(c[2]) ? Object.keys(c[2]) : [])) : [];
      const nestedSecret = nested.map((k) => deniedField(k)).find((r) => r);
      if (nestedSecret) {
        problems.push(denial(`A field inside ${model}.${field}`, nestedSecret));
        continue;
      }
      send[field] = checked.value;
      // Linked records must exist; their names go in the preview.
      const linked = def.type === "many2one" && isId(checked.value) ? [checked.value] : X2MANY.has(def.type) && Array.isArray(checked.value) ? linkedIds(checked.value as unknown[][]) : [];
      if (linked.length && def.relation) {
        const found = await namesOf(def.relation, linked);
        if (found) {
          names.set(field, found);
          const missing = linked.filter((id) => !found.has(id));
          if (missing.length) problems.push(`${field}: no ${def.relation} with id ${missing.join(", ")}`);
        }
      }
    }
    if (problems.length) throw new OdooError(problems.length === 1 ? problems[0]! : `${problems.length} problems: ${problems.join("; ")}. Check the fields with describe_model.`);
    return { send, names };
  }

  /** Display names by id, archived ones included; null when the model can't be read (then the check is Odoo's). */
  async function namesOf(model: string, ids: number[]): Promise<Map<number, string> | null> {
    try {
      const rows = await client.searchRead(model, [["id", "in", ids]], ["display_name"], { context: { active_test: false } });
      return new Map(rows.map((r) => [r.id, String(r.display_name || `#${r.id}`)]));
    } catch (err) {
      if (err instanceof OdooRpcError) return null;
      throw err;
    }
  }

  /** The records by id, in the order asked; an id that doesn't exist refuses the proposal. */
  async function recordsOf(model: string, ids: number[], fields: string[], defs: OdooFieldDefs): Promise<OdooRecord[]> {
    // A search, not a read: reading an id that is gone raises in Odoo, and archived records must still be found.
    const rows = await client.searchRead(model, [["id", "in", ids]], ["display_name", ...new Set(fields.filter((f) => f !== "display_name" && defs[f]))], { context: { active_test: false } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) throw new OdooError(`No ${model} with id ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` (and ${missing.length - 10} more)` : ""}`);
    return ids.map((id) => byId.get(id)!);
  }

  /** account.move is only editable as a draft customer invoice or vendor bill. */
  function guardInvoices(model: string, rows: OdooRecord[]) {
    if (model !== "account.move") return;
    const other = rows.find((r) => typeof r.move_type === "string" && !/^(out|in)_(invoice|refund)$/.test(r.move_type));
    if (other) throw new OdooError(`${String(other.display_name || `Entry ${other.id}`)} is a journal entry, not an invoice or bill (rule "accounting-entries"): change it in Odoo.`);
    const locked = rows.filter((r) => r.state !== "draft");
    if (locked.length) throw new OdooError(`${String(locked[0]!.display_name || `Invoice ${locked[0]!.id}`)} is ${String(locked[0]!.state || "not a draft")}: only a draft invoice can be edited (rule "accounting-entries"). A posted one is corrected in Odoo (reset to draft or a credit note).`);
  }

  const nameOf = (r: OdooRecord) => String(r.display_name || `#${r.id}`);
  const sample = (rows: OdooRecord[], state?: string) => rows.slice(0, SAMPLE).map((r) => ({ id: r.id, name: nameOf(r), ...(state && r[state] ? { state: show(undefined, r[state]) } : {}) }));
  const listed = (rows: OdooRecord[]) => `${rows.slice(0, 3).map(nameOf).join(", ")}${rows.length > 3 ? ` and ${rows.length - 3} more` : ""}`;
  const stateField = (defs: OdooFieldDefs) => (defs.state ? "state" : defs.stage_id ? "stage_id" : undefined);

  /** Stores the server's preview (replacing any the agent sent) and its one-line note. */
  const withPreview = (payload: Record<string, unknown>, preview: RecordPreview, note: string) => {
    const { recordPreview: _agent, ...rest } = payload;
    return { payload: { ...rest, recordPreview: preview }, note: `[${unbracket(note)}]` };
  };

  async function updatePlan(payload: Record<string, unknown>) {
    const p = parse(RecordUpdate, payload);
    const { defs, label } = await modelFor(p.model, "update");
    const { send, names } = await checkValues(p.model, defs, p.values);
    const rows = await recordsOf(p.model, p.ids, [...Object.keys(send), ...(p.model === "account.move" ? ["state", "move_type"] : [])], defs);
    guardInvoices(p.model, rows);
    const changes: RecordChange[] = Object.entries(send).map(([field, to]) => {
      const def = defs[field]!;
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(show(def, r[field]), (counts.get(show(def, r[field])) ?? 0) + 1);
      const from = [...counts].sort((a, b) => b[1] - a[1]);
      return {
        field,
        label: def.string || field,
        from: from.length === 1 ? from[0]![0] : from.slice(0, 3).map(([value, records]) => ({ value, records })),
        to: show(def, Array.isArray(to) && Array.isArray(to[0]) && to[0][0] === 6 ? to[0][2] : to, names.get(field)),
        changes: rows.filter((r) => !same(def, r[field], to)).length,
      };
    });
    return { p, defs, label, send, rows, changes };
  }

  return {
    "odoo.record.create": {
      description:
        "Create a record on any Odoo model the specific actions don't cover (a pricelist rule, a reordering rule, a product category, a helpdesk ticket…). payload: { model, values: { field: value } }. describe_model first: values are checked against the model's fields (many2one = the record's id, x2many = a list of ids, dates YYYY-MM-DD, selection = one of its values). The approval shows the values by name and any existing record with the same name, reference or email. Protected models (users, access, settings, payments, accounting entries, emails) are refused.",
      async prepare(payload) {
        const p = parse(RecordCreate, payload);
        const { defs, label } = await modelFor(p.model, "create");
        const { send, names } = await checkValues(p.model, defs, p.values);
        const values = Object.fromEntries(Object.entries(send).map(([f, v]) => [defs[f]!.string || f, show(defs[f], Array.isArray(v) && Array.isArray(v[0]) && v[0][0] === 6 ? v[0][2] : v, names.get(f))]));
        let duplicates: RecordPreview["duplicates"] = [];
        try {
          const seen = new Map<number, { id: number; name: string; same: string; archived?: boolean }>();
          for (const key of DUPLICATE_KEYS) {
            const v = send[key];
            if (typeof v !== "string" || !v.trim() || defs[key]?.store === false) continue;
            const rows = await client.searchRead(p.model, [[key, "=ilike", v.trim().replace(/[\\%_]/g, "\\$&")]], ["display_name", ...(defs.active ? ["active"] : [])], { limit: 3, context: { active_test: false } });
            for (const r of rows) {
              const hit = seen.get(r.id);
              if (hit) hit.same += `, ${defs[key]!.string || key}`;
              else seen.set(r.id, { id: r.id, name: nameOf(r), same: defs[key]!.string || key, ...(r.active === false ? { archived: true } : {}) });
            }
          }
          duplicates = [...seen.values()];
        } catch (err) {
          if (!(err instanceof OdooError)) throw err;
          duplicates = `Could not check Odoo: ${err.message}`;
        }
        const main = typeof send.name === "string" ? ` "${clip(send.name)}"` : "";
        const dupNote = typeof duplicates === "string" ? " Could not check for duplicates." : duplicates.length ? ` Already in Odoo: ${duplicates.map((d) => `${d.name} #${d.id}${d.archived ? " (archived)" : ""}, same ${d.same}`).join("; ")}.` : "";
        const fieldsNote = Object.entries(values).filter(([k]) => k !== (defs.name?.string || "name")).slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(", ");
        return withPreview(payload, { model: p.model, label, values, duplicates: typeof duplicates === "string" || duplicates.length ? duplicates : "None found" }, `New ${label}${main}${fieldsNote ? ` (${fieldsNote})` : ""}.${dupNote}`);
      },
      async execute(payload) {
        const p = parse(RecordCreate, payload);
        const { defs } = await modelFor(p.model, "create");
        const { send } = await checkValues(p.model, defs, p.values);
        const id = await client.create(p.model, send);
        const name = (await namesOf(p.model, [id]))?.get(id) ?? null;
        return { model: p.model, id, name };
      },
    },

    "odoo.record.update": {
      description: `Change fields of one or many records (up to ${MAX_RECORD_IDS}) of any Odoo model the specific actions don't cover. payload: { model, ids: [..], values: { field: value } } (the same values go on every id; false clears a field). describe_model and get_record first. The approval shows each record's name and, per field, what it is now → what it becomes. Read-only fields, unknown fields, wrong types and protected models or fields are refused. An invoice only while it is a draft, and only its reference, dates, terms and notes.`,
      async prepare(payload) {
        const { p, label, rows, changes } = await updatePlan(payload);
        const changing = changes.filter((c) => c.changes > 0);
        const what = rows.length === 1 ? `${label} ${nameOf(rows[0]!)}` : `${rows.length} ${label} records (${listed(rows)})`;
        const text = changing.length
          ? changing.map((c) => `${c.label}: ${typeof c.from === "string" ? c.from : `${c.from.length === 3 ? "3+" : c.from.length} different values`} → ${c.to}`).join("; ")
          : "no change, already set";
        return withPreview(payload, { model: p.model, label, count: rows.length, records: sample(rows), changes }, `${what}: ${text}.`);
      },
      async execute(payload) {
        const { p, send, rows } = await updatePlan(payload);
        await client.write(p.model, p.ids, send);
        const before = rows.map((r) => ({ id: r.id, name: nameOf(r), from: Object.fromEntries(Object.keys(send).map((f) => [f, r[f] ?? false])) }));
        if (before.length === 1) return { model: p.model, id: before[0]!.id, name: before[0]!.name, from: before[0]!.from, to: send };
        return { model: p.model, ids: p.ids, count: p.ids.length, to: send, records: before.slice(0, 50) };
      },
    },

    "odoo.record.archive": archiver(false),
    "odoo.record.unarchive": archiver(true),

    "odoo.record.action": {
      description: `Press a workflow button on records of any model, as its form button does: a method named action_… or button_… taking no arguments (e.g. stock.picking action_cancel, mrp.production button_mark_done, crm.lead action_set_won). payload: { model, ids, method }. Prefer the specific action when one exists. If Odoo answers with a wizard (it wants more input), nothing is done and the error names the wizard. Protected models are refused.`,
      async prepare(payload) {
        const p = parse(RecordAction, payload);
        const refused = deniedMethod(p.method);
        if (refused) throw new OdooError(refused);
        const { defs, label } = await modelFor(p.model, "action");
        const state = stateField(defs);
        const rows = await recordsOf(p.model, p.ids, state ? [state] : [], defs);
        const now = state ? [...new Set(rows.map((r) => show(defs[state], r[state])))].slice(0, 3).join(", ") : "";
        return withPreview(payload, { model: p.model, label, count: rows.length, records: sample(rows, state), method: p.method }, `${p.method} on ${rows.length === 1 ? `${label} ${nameOf(rows[0]!)}` : `${rows.length} ${label} records (${listed(rows)})`}${now ? `, now ${now}` : ""}.`);
      },
      async execute(payload) {
        const p = parse(RecordAction, payload);
        const refused = deniedMethod(p.method);
        if (refused) throw new OdooError(refused);
        const { defs } = await modelFor(p.model, "action");
        const state = stateField(defs);
        const rows = await recordsOf(p.model, p.ids, state ? [state] : [], defs);
        const answer = (await client.call(p.model, p.method, [p.ids])) as { type?: string; res_model?: string; target?: string; name?: string } | boolean | null;
        // A dialog means Odoo wants more input before doing anything: don't guess it.
        if (answer && typeof answer === "object" && answer.type === "ir.actions.act_window" && answer.target === "new") {
          throw new OdooError(`Odoo did not finish ${p.method}: it opened the wizard ${answer.res_model ?? "?"}${typeof answer.name === "string" ? ` ("${answer.name}")` : ""}, which wants more input. Nothing was changed. Use the specific action for this step if there is one, or do it in Odoo.`);
        }
        const after = state ? await client.read(p.model, p.ids, [state]) : [];
        return {
          model: p.model,
          method: p.method,
          ids: p.ids,
          records: rows.slice(0, 50).map((r) => ({ id: r.id, name: nameOf(r), ...(state ? { from: show(defs[state], r[state]), to: show(defs[state], after.find((a) => a.id === r.id)?.[state]) } : {}) })),
        };
      },
    },
  };

  function archiver(active: boolean): OdooActionExecutor {
    const verb = active ? "Restore" : "Archive";
    const look = async (payload: Record<string, unknown>) => {
      const p = parse(RecordIds, payload);
      const { defs, label } = await modelFor(p.model, "archive");
      if (!defs.active) throw new OdooError(`${p.model} records can't be archived: the model has no "active" field. Close or cancel it through its own workflow (odoo.record.action), or delete it in Odoo.`);
      if (defs.active.readonly) throw new OdooError(`${p.model}.active is read-only: this model is archived through its parent record`);
      const rows = await recordsOf(p.model, p.ids, ["active"], defs);
      const todo = rows.filter((r) => (r.active !== false) !== active);
      return { p, label, rows, todo };
    };
    return {
      description: active
        ? "Restore archived records of any model (sets them active again). payload: { model, ids }. Find archived records with search_records include_archived."
        : `Archive records of any model that has an "active" field (customers, products, pricelists, reordering rules…): they disappear from lists and searches but nothing is deleted, and odoo.record.unarchive restores them. payload: { model, ids } (up to ${MAX_RECORD_IDS}). The approval lists the records by name. A product: archive the product.template to hide every variant.`,
      async prepare(payload) {
        const { p, label, rows, todo } = await look(payload);
        const skipped = rows.length - todo.length;
        return withPreview(payload, { model: p.model, label, count: rows.length, records: sample(rows) }, `${verb} ${rows.length === 1 ? `${label} ${nameOf(rows[0]!)}` : `${rows.length} ${label} records (${listed(rows)})`}${skipped ? `; ${skipped === rows.length ? "all" : skipped} already ${active ? "active" : "archived"}` : ""}.`);
      },
      async execute(payload) {
        const { p, rows, todo } = await look(payload);
        if (todo.length) await client.write(p.model, todo.map((r) => r.id), { active });
        return { model: p.model, ids: p.ids, [active ? "restored" : "archived"]: todo.length, already: rows.length - todo.length, records: rows.slice(0, 50).map((r) => ({ id: r.id, name: nameOf(r) })) };
      },
    };
  }
}

/** The ids an x2many value links (commands 4 and 6), for the existence check. */
function linkedIds(commands: unknown[][]): number[] {
  const ids: number[] = [];
  for (const c of commands) {
    if (c[0] === 6 && Array.isArray(c[2])) ids.push(...(c[2] as number[]));
    else if ((c[0] === 4 || c[0] === 1 || c[0] === 3) && isId(c[1])) ids.push(c[1]);
  }
  return [...new Set(ids)];
}
