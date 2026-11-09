---
name: dms-catalogue-pricing
description: Review Desktop Machine Shop product data and prices in Odoo (SKU, cost, list price, VAT, stock, weight, category), propose price changes with odoo.product.update_price, and set up or end discounts, promo codes and loyalty deals with odoo.loyalty.create and odoo.loyalty.archive, always showing net and VAT-inclusive figures, the margin and the reason. Use for "what should we charge", "are we too expensive", price reviews, sales and promo codes, loyalty schemes, catalogue gaps or checking a product's facts.
---

# DMS catalogue and pricing

You look after the facts and prices of the Desktop Machine Shop catalogue in Odoo. You never edit
products directly: a price change is an `odoo.product.update_price` proposal that Dave approves.

## 1. Get the facts from Odoo

- `odoo` `search_products` by name, SKU or barcode, then `get_product` (by id or SKU) for taxes,
  stock moves, the sale description and the website URL.
- `list_price` is the sale price before tax. `standard_price` is the cost. Check the product's
  taxes in `get_product`: UK VAT is normally 20%, so gross = net × 1.2. Use the tax Odoo shows if
  it differs.
- `low_stock` lists sellable products at or below a threshold, with incoming quantities.
- Search the brain (`dms/products/`, `dms/decisions/`) for earlier price decisions, competitor
  notes and supplier costs before you suggest anything.

## 2. Compare and decide

- Competitors: use the competitor registry and reports in the brain (`dms/competitors.md`,
  `dms/competitors/reports/`), and for current prices the `competitor-analysis` skill (the
  research tools read a competitor's catalogue and say when each price was read). If there are
  none, say so and base the suggestion on cost and margin only. Never invent a competitor price.
- Compare like for like: same pack size, same spec (e.g. ER11 vs ER16, collet accuracy), and
  include shipping if the competitor charges it separately.
- Show every price both ways, for example `£24.17 net / £29.00 inc VAT`.
- Give the margin on cost for the current and the proposed price. Flag anything below 30%.
- Prefer price points customers expect (`£29.00` inc VAT, not `£28.63`).

## 3. Propose

One `propose_action` per product:

```json
{ "actionType": "odoo.product.update_price",
  "summary": "ER11 collet set: £24.17 → £22.50 net (£27.00 inc VAT), match ToolCo",
  "payload": { "id": 123, "list_price": 22.5 } }
```

- `list_price` is net (before VAT) and applies to all variants of the template: say so in the
  summary if the product has variants.
- In the summary, give the before and after (net and gross) and the reason in a few words.
- Record the reasoning in the brain (`dms/decisions/pricing-<sku>.md`) so the next review can
  see why the price is what it is.

## Discounts and loyalty deals

Odoo runs these from Sales > Discount & Loyalty. You can list them, create one and archive one.
Every create and archive is a proposal Dave approves.

- `odoo` `search_loyalty_programs` lists the live programs (`include_archived: true` for old
  ones), with their rules and rewards. Check it first, so you don't stack a new discount on one
  that's already running.
- **Create** with `odoo.loyalty.create`. A program has one rule (who qualifies) and one reward
  (what they get):

  | Deal | `program_type` | Rule | Reward |
  | --- | --- | --- | --- |
  | 10% off orders over £50, automatic | `promotion` | `{ "minimum_amount": 50 }` | `{ "type": "discount", "discount": 10 }` |
  | £5 off with code `WELCOME5` | `promo_code`, `code` | `{}` | `{ "type": "discount", "discount": 5, "discount_mode": "per_order" }` |
  | 15% off spindles only | `promotion` | `{ "product_ids": [2] }` | `{ "type": "discount", "discount": 15, "applies_to": "specific", "discount_product_ids": [2] }` |
  | Buy a spindle, get the ER11 set free | `buy_x_get_y` | `{ "product_ids": [2], "points": 1, "points_mode": "unit" }` | `{ "type": "product", "product_id": 1, "required_points": 1 }` |
  | Free shipping over £100 | `promotion` | `{ "minimum_amount": 100 }` | `{ "type": "shipping" }` |
  | Loyalty card: 1 point per £1, 100 points = £5 off | `loyalty` | `{ "points": 1, "points_mode": "money" }` | `{ "type": "discount", "discount": 5, "discount_mode": "per_order", "required_points": 100 }` |

  Add `date_from` / `date_to` (YYYY-MM-DD) for a sale with an end, `website_id` (from
  `list_websites`) to keep it to the DMS shop, and `max_usage` to cap how many orders can use it.
  `minimum_amount` is in GBP. Program, product and website ids come from the odoo tools: never
  guess one.

  ```json
  { "actionType": "odoo.loyalty.create",
    "summary": "Black Friday: 15% off orders over £40 with BF15, 27–30 Nov, DMS site. Lowest margin after discount: 34% (ER11 set)",
    "payload": { "name": "Black Friday 15%", "program_type": "promo_code", "code": "BF15",
      "date_from": "2026-11-27", "date_to": "2026-11-30", "website_id": 1,
      "rule": { "minimum_amount": 40 }, "reward": { "type": "discount", "discount": 15 } } }
  ```

  The deal is live as soon as Dave approves it (from `date_from` if you set one). In the summary,
  give what the customer gets, who qualifies, the dates and the worst-case margin after the
  discount. Flag anything that takes a product below 30%.
- **End** a deal with `odoo.loyalty.archive` `{ id }`. Archived programs stop applying at once and
  can be restored in Odoo. Use it when a sale is over, or a code has leaked or been misused.
- Note every deal you propose in the brain (`dms/decisions/promo-<name>.md`), with the reason and
  the dates, so later price reviews know what was running.

## Catalogue gaps

When a product lacks a SKU, weight, HS code, category or description, list the gaps in a brain
note (`dms/catalogue/gaps.md`) rather than proposing edits: there is no product-edit action yet.
