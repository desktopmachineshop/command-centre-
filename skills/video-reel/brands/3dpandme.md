# 3dpandme video guidelines

`product: "3dpandme"`. Read with the master `video-reel` skill and the `social-voice-3dpandme`
skill (the voice, facts and disclosure rules apply to video exactly as to posts).

## What 3dpandme is

Dave's 3D-printing blog, YouTube channel and Instagram. Viewers are makers who print at home,
tinker with their machines and want things that work.

## What this pipeline makes for 3dpandme

Dave films and edits the main YouTube videos himself; this pipeline doesn't. Use it for the
reels and shorts **around** them, built from what's already published:
- a 9:16 teaser for a new video or blog post (title hook → 2–3 photos or settings → "full
  video on the channel");
- a quick tip reel (one setting, one fix, one print), with the settings on a slide;
- a capture of the blog post itself scrolling to the key photo or table.

## Where facts come from

- Blog posts: `odoo` `search_blog_posts`, then the post's page. Settings, temperatures,
  materials and results come from the post or the video description, never from memory.
- Video titles and links: from the task or the post.
- A Desktop Machine Shop product: check it with `odoo` `search_products` / `get_product` and
  disclose the connection on screen and in narration ("from my shop, Desktop Machine Shop").
- Sponsored or gifted items: disclose with "#ad" or "Sent to me by…" on screen in the first
  scene, as UK advertising rules require. Check the brain or ask Dave if unsure.
- Source refs look like `odoo:blog/<post slug>`.

## What may be shown

Public blog pages and photos from the post (image scenes) or that Dave supplied. Never
someone else's model, photo or print without credit and permission noted in the brain.

## Voice

First person, a maker talking to makers: enthusiastic but earned, practical, honest about
failures ("third attempt, 0.35 mm clearance fixed it"). UK English, °C and mm. Narration is in
Dave's voice, so write it the way he'd say it.

## Brand kit

Placeholder colours and fonts until Dave confirms the real ones (docs/VIDEO.md, open questions).
Copy this into the spec's `brand` unchanged:

```json
{ "name": "3dpandme", "colours": { "primary": "#cf4f8f", "background": "#1b1420", "text": "#ffffff", "accent": "#7ee0c3" }, "fonts": { "heading": "Inter", "body": "Inter" } }
```

## Call to action

One action: watch the full video on the 3dpandme YouTube channel, or read the post (its link
from `search_blog_posts`).
