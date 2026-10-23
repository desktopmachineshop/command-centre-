---
name: dms-catalogue-pricing
description: Review Desktop Machine Shop product data and prices in Odoo (SKU, cost, list price, VAT, stock, weight, category) and propose price changes with odoo.product.update_price, always showing net and VAT-inclusive figures, the margin and the reason. Use for "what should we charge", "are we too expensive", price reviews, catalogue gaps or checking a product's facts.
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

- Competitors: use the competitor notes in the brain (`dms/competitors*`). If there are none, say
  so and base the suggestion on cost and margin only. Never invent a competitor price.
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

## Catalogue gaps

When a product lacks a SKU, weight, HS code, category or description, list the gaps in a brain
note (`dms/catalogue/gaps.md`) rather than proposing edits: there is no product-edit action yet.
