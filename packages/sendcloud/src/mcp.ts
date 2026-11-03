import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SendcloudParcel } from "./client";
import { type ParcelState, parcelState, parseSendcloudDate } from "./status";
import type { ShippingService } from "./service";

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

/** A parcel trimmed to what an agent needs to answer "where is my order?". */
function compact(p: SendcloudParcel & { account?: string }) {
  return {
    id: p.id,
    account: p.account ?? null,
    state: parcelState(p),
    status: p.status?.message ?? null,
    order_number: p.order_number ?? null,
    recipient: p.company_name || p.name || null,
    city: p.city ?? null,
    country: p.country?.iso_2 ?? null,
    carrier: p.carrier?.code ?? null,
    shipping_method: p.shipment?.name ?? null,
    tracking_number: p.tracking_number ?? null,
    tracking_url: p.tracking_url ?? null,
    created: parseSendcloudDate(p.date_created)?.toISOString() ?? null,
    updated: parseSendcloudDate(p.date_updated)?.toISOString() ?? null,
    is_return: p.is_return ?? false,
  };
}

const STATES = ["label", "in_transit", "pickup_point", "delivered", "problem", "cancelled"] as const satisfies readonly ParcelState[];

/**
 * Read-only Sendcloud tools at /mcp/sendcloud: recent parcels and a lookup by order or
 * tracking number. `vertical` limits a run to its own business's accounts (null: all).
 */
export function createSendcloudMcpServer(shipping: ShippingService, vertical: string | null = null): McpServer {
  const server = new McpServer({ name: "sendcloud", version: "0.1.0" });
  const clients = () => shipping.clients.filter((c) => !vertical || c.account.vertical === vertical);

  server.registerTool(
    "recent_parcels",
    {
      description:
        "Parcels shipped with Sendcloud whose status changed in the last `days` days (default 7), newest first. state: label (not yet with the carrier), in_transit, pickup_point (waiting for the customer), delivered, problem (delayed, failed, returned...), cancelled.",
      inputSchema: { days: z.number().int().min(1).max(90).optional(), state: z.enum(STATES).optional(), limit: z.number().int().min(1).max(200).optional() },
    },
    async ({ days, state, limit }) => {
      const since = new Date(Date.now() - (days ?? 7) * 86_400_000);
      const { parcels, errors } = await shipping.recentParcels(vertical, since);
      if (errors.length && !parcels.length) return fail(errors.join("; "));
      const rows = parcels
        .map(compact)
        .filter((p) => !state || p.state === state)
        .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""))
        .slice(0, limit ?? 50);
      return ok({ parcels: rows, ...(errors.length ? { errors } : {}) });
    },
  );

  server.registerTool(
    "find_parcel",
    {
      description: "Finds Sendcloud parcels by order number (e.g. S00042) or tracking number, with their current status and tracking link.",
      inputSchema: { order_number: z.string().min(1).optional(), tracking_number: z.string().min(1).optional() },
    },
    async ({ order_number, tracking_number }) => {
      if (!order_number && !tracking_number) return fail("Give an order_number or a tracking_number");
      const found: ReturnType<typeof compact>[] = [];
      const errors: string[] = [];
      for (const { account, client } of clients()) {
        try {
          const parcels = await client.listParcels({ orderNumber: order_number, trackingNumber: tracking_number, maxPages: 2 });
          found.push(...parcels.map((p) => compact({ ...p, account: account.id })));
        } catch (err) {
          errors.push(`${account.id}: ${(err as Error).message}`);
        }
      }
      if (!found.length && errors.length) return fail(errors.join("; "));
      return ok({ parcels: found, ...(errors.length ? { errors } : {}) });
    },
  );

  return server;
}
