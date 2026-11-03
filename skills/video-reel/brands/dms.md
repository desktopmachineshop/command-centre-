# Desktop Machine Shop video guidelines

`product: "dms"`. Read with the master `video-reel` skill and the `social-voice-dms` skill
(the shop's voice, promotion cadence and Odoo fact rules apply to video exactly as to posts).

## What DMS is

desktopmachineshop.com sells CNC accessories and kits: spindles, collets, end mills,
workholding and machine kits. Viewers are hobbyist machinists and small workshops, and many
know their machines well.

## Where facts come from

Every product fact in a video, in narration or on screen, is checked in Odoo in this task:

| Find | Read |
| --- | --- |
| `odoo` `search_products` | `odoo` `get_product` |

- **Prices**: exactly as Odoo shows, in £, "inc. VAT" only if you checked the tax. Otherwise leave
  the price out. A price on screen goes stale: prefer "see the link" unless Dave asked for it.
- **Stock**: "in stock" / "back in stock" only, never counts, never arrival dates.
- **Specs and compatibility**: only from the product description or the brain's
  `dms/products` notes. If you're not sure it fits a machine, don't claim it.
- **Offers**: only ones Dave set up and mentioned, with their real end date.
- Source refs look like `odoo:product/<SKU>`.
- Don't make a video for an unpublished, archived or out-of-stock product with nothing incoming.

## What may be shown

- Public pages of desktopmachineshop.com (capture scenes; no sign-in needed). Never the Odoo
  back office, orders, customers or supplier prices.
- Product photos (image scenes) only from the product's own page or that Dave supplied.
- Customer builds only with the customer's permission noted in the brain.

## Reel ideas that suit the shop

Helpful first, at most about one in four videos promotional (same cadence as posts):
setup tips (choosing a collet size, tramming, a feeds and speeds starting point as a slide),
"what's in the kit", and one restock or launch reel per product when something changes.

## Voice

Expert, helpful, never pushy, calm. Use the right terms (ER11, runout, chip load) and explain
them briefly. UK English: aluminium, metre, dispatch. No "BUY NOW", no false urgency.

## Brand kit

Placeholder colours and fonts until Dave confirms the real ones (docs/VIDEO.md, open questions).
Copy this into the spec's `brand` unchanged:

```json
{ "name": "Desktop Machine Shop", "colours": { "primary": "#d9822b", "background": "#1c1f24", "text": "#ffffff", "accent": "#f2c14e" }, "fonts": { "heading": "Inter", "body": "Inter" } }
```

## Call to action

One action: the product page (`website_url` from `get_product`) or desktopmachineshop.com.
Say it as "desktop machine shop dot com".
