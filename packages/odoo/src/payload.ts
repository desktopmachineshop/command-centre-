import type { z } from "zod";
import { OdooError } from "./client";

/** A proposal payload checked against its schema; the issues as one OdooError otherwise. */
export function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const r = schema.safeParse(payload);
  if (!r.success) throw new OdooError(`Invalid payload: ${r.error.issues.map((i) => `${i.path.join(".") || "payload"} ${i.message}`).join("; ")}`);
  return r.data;
}

/** The entries that aren't undefined (Odoo values to send). */
export const defined = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/** `[[6, 0, ids]]`: set a many2many to exactly these ids. */
export const setMany = (ids: number[] | undefined) => (ids?.length ? [[6, 0, ids]] : undefined);
