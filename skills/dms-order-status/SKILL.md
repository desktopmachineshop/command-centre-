---
name: dms-order-status
description: Work out where a Desktop Machine Shop order is (confirmed, picked, shipped, tracking, invoiced, paid) from Odoo, and draft a status update for the customer. Use for "where is my order", delivery, tracking or invoice-status questions, and for Dave's own order look-ups.
---

# DMS order status

## 1. Find the order

- The customer gave an order number (`S00042`): `odoo` `get_order` with `name`.
- No number: `odoo` `search_customers` by their email, then `search_orders` with `partner` (their
  id) or `get_customer_history`. If several orders could match, pick the one whose products or
  dates fit the question. If it's still ambiguous, ask them which order they mean rather than
  guessing.
- Their own reference (a PO number): `search_orders` with `query`.

## 2. Read the status

`get_order` returns the order with `lines`, `deliveries`, `invoices` and recent `messages`.

| Field | Meaning |
| --- | --- |
| `state` | `draft`/`sent`: a quotation, not confirmed yet. `sale`: confirmed. `cancel`: cancelled. |
| `delivery_status` (Odoo 17+) | `pending` (nothing shipped), `started`, `partial` (some shipped), `full` (all shipped) |
| `deliveries[]` | One per picking. Outgoing ones (`type: outgoing`) are shipments. `state`: `waiting`/`confirmed` (waiting for stock), `assigned` (ready to pack), `done` (shipped on `done`), `cancel` |
| `deliveries[].tracking_ref`, `carrier` | The tracking number and carrier, once dispatched |
| `lines[].delivered` vs `qty` | Which items have actually gone, on a partial shipment |
| `invoice_status` / `invoices[].payment_state` | `to invoice` / `invoiced`; `paid`, `not_paid`, `partial`, `in_payment` |
| `promised_date` | A commitment date entered on the order. It's only a promise if it's set |

If a line is waiting on stock, check the product with `get_product`. `incoming_qty` and
`virtual_available` show whether more is on order, but not when it arrives. Look in the brain
(`search` the product or supplier) for any expected restock date Dave has recorded.

If the order has shipped and the `sendcloud` tools are available, call `find_parcel` with the
order number (or the `tracking_ref`) for the carrier's latest status and tracking link. Its
`state` is `label` (not yet collected by the carrier), `in_transit`, `pickup_point` (waiting at a
service point for the customer), `delivered` or `problem` (delayed, failed attempt, returning).
Prefer it over Odoo's picking state for "where is it now?", and quote the tracking link.

Check the order's `messages` and the brain for anything already said to the customer, so you
don't contradict it.

## 3. Reply

Follow the `dms-customer-reply` skill for tone (UK English, friendly, concise), and propose the
reply through `propose_action`:

- `email.reply` if they emailed;
- `odoo.message.post` on the `sale.order` (`{ model: "sale.order", id, body }`) if they asked
  through the website or chatter.

What to say:

- **Shipped:** the dispatch date, the carrier, and the tracking reference (and URL if there is
  one). Don't predict the delivery day beyond the carrier's normal service, unless the brain has
  a shipping playbook that says otherwise.
- **Ready or packing:** "being packed" or "ready to go out". No date, unless `scheduled` is today
  and the brain's dispatch cut-off supports it.
- **Waiting on stock:** be honest that it's waiting on stock. Give a date only if Dave recorded
  one. Otherwise say you'll update them, and put "needs restock date" in the proposal summary so
  Dave sees it.
- **Partial:** list what has gone and what is still to come.
- **Not paid or a quotation:** say so politely, and say what's needed to proceed.

Never invent tracking numbers, dates or stock figures.

## New orders from the Odoo poller

Each new confirmed order arrives as an `order.created` event. It's normally only filed (a journal
line plus the daily digest, with no agent). An agent gets one only when the poller flagged it, for
example over the `bigOrderThreshold` in `ODOO_EVENTS`. In that case, check it rather than answer
anyone:

- every line is in stock (`get_product`);
- the delivery method suits the weight and destination;
- a first-time customer is placing a large order (`get_customer_history`).

Raise anything odd with an internal note on the order and a `notify`. Don't contact the customer
unless something needs fixing. Late deliveries (`delivery.late`) follow the `dms-ops` skill.

## 4. Flag problems to Dave

If the order looks stuck, propose an internal note on the order so it shows in Odoo:
`odoo.message.post` with `internal: true`. Stuck means confirmed several days ago with nothing
shipped, a cancelled delivery, paid but not invoiced, and so on. Mention it in the summary.

Add a one-line journal entry to the brain, e.g. "Order S00042 status sent to Jane Doe (partial:
spindle still to ship)".
