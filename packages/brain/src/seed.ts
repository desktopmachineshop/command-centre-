import type { Note } from "./note";

/**
 * Notes the brain starts with. Each is added once, only if its path has never
 * existed, so deleting or editing one in the app sticks.
 */
export const SEED_NOTES: Pick<Note, "path" | "frontmatter" | "body">[] = [
  {
    // Was docs/MORNING.md in the code repo.
    path: "command-centre/2026-10-24-overnight-summary.md",
    frontmatter: { type: "report", tags: ["command-centre", "overnight-summary"] },
    body: `# Good morning: overnight summary (24 Oct 2026)

Everything below is merged to \`ccr-fa6f7f74-51z3o9\`, tested (typecheck + every package's tests + builds, green), pushed, and deployed to Railway.

**HTTPS on command.desktopmachineshop.com is not working yet.** Railway never got a certificate for it (Let's Encrypt rate-limited the earlier attempts), so Chrome shows it as not secure and won't install the app from it. Fix: in Cloudflare → DNS, set the \`command\` record to **Proxied** (orange cloud), and in SSL/TLS → Overview choose **Full** (not Flexible, not Full strict). Until then use **https://server-production-d0c1.up.railway.app**, which has a valid certificate.

It is running in **echo mode** (no Claude runs, no cost) until you add your Claude token (step 2 below).

## What's built

| Area | What you get |
|---|---|
| **Login** | Email + password, optional 2FA (authenticator app + recovery codes), sign out other devices, lockout on repeated failures. The admin token still works for automation. |
| **Agent org chart** | Chief of Staff, then a lead per business, then specialist roles (e.g. DMS Customer Support, Ops & Admin, Catalogue & Pricing). Work routes to the right role; roles can hand off to each other (max 3 hops). **Org** page with live stats. See \`docs/ORG.md\`. |
| **Personal assistant** | Google Calendar (read; create, move and delete events need your approval), reminders (recurring, pushed to your phone with Done/Snooze buttons), to-do and shopping lists. **Today** page. Morning brief and evening wrap are written but **off**. |
| **Voice / Drive mode** | Hands-free in the car. **Push-to-talk** or **Conversational** (the agent can ask you something and listens for your answer). Spoken briefing, approvals read aloud with "yes, approve" confirmation, headset/steering-wheel button support. Free browser speech by default; optional OpenAI/ElevenLabs voices. |
| **Notifications** | Types (approval, briefing, reminder, alert, digest, social, orders, system, agent), each with push / batch-to-digest / in-app-only, sound on/off, quiet hours 22:00–07:00 (urgent still comes through), per-device routing, a bell with unread count, test buttons. |
| **Email** | Polls your inboxes; replies are drafted for approval. |
| **Odoo** | Agents read products, orders, customers and chatter. New orders, customer messages, tickets, low stock, late deliveries and reviews become tasks or digest entries automatically. |
| **Social** | Discord, Instagram, Threads, X (posting only), Reddit, YouTube: replies to comments, mentions and DMs drafted for approval; one-approval multi-platform campaigns, scheduling, media hosting. **Social** page with composer. |
| **Video** | Pipeline for marketing videos and reels (OpenV, OpenD, DMS, 3dpandme; one master \`video-reel\` skill with per-brand guidelines): script, then screen capture, voice, burned-in captions and render (on your PC's worker), then a draft social post. Sample: \`docs/media/sample-opend-walkthrough.mp4\`. Design: \`docs/VIDEO.md\`. |
| **Storage** | Large files can live in your Google Drive (only files the app creates, \`drive.file\`), with a local cache. Public media links stay on our domain. |
| **Desktop** | Windows app + worker (GPU/ffmpeg/DaVinci/Claude jobs). Build via the GitHub "Desktop" workflow. |
| **Cost control** | Daily budget caps, digests that make no Claude calls, run guardrails, duplicate detection. |

**Looks:** the whole app was redesigned for phone and desktop, in light, dark or system theme (toggle in the header). Screenshots of every page are in \`docs/screenshots/\`.

**Final review:** an independent review of the fully merged code checked every \`/api\` route without credentials and found no unauthenticated access. It also found agents can't reach tools outside their role. It found and we fixed five bugs, each with a regression test:
- "Done" on a recurring reminder's notification ended the whole series. It now completes just that occurrence, and push links expire.
- A voice reply could lose its context if the subscription hit its limit mid-conversation.
- One-time upload links could be used twice at once, and leaked a file path in an error.
- A rare race between a voice reply and an approval completing.
- Video narration ignored the documented voice settings.

**Safety rule throughout:** anything triggered by outside input (email, webhooks, social, Odoo) can never send, post or change anything without your approval, whatever the settings say.

## Your setup checklist (in order)

**New: everything below that says "set X in Railway" can now be done on the Accounts page** (More → Accounts): paste keys, or press **Connect** to sign in to Google, YouTube, Instagram, Threads, X and Reddit. Changes apply straight away. See \`docs/SETUP.md\` → "Accounts page".

1. **Login: done.** Your account was created at 02:16 UTC. Optional: Settings → set up two-factor and save the recovery codes. **Install it on your phone:** in Chrome, tap **Install** on the card at the top of the Inbox (or ⋮ → Install app). It becomes a proper Android app, with its own icon in the app drawer, full screen, and long-press shortcuts to Approvals, Chat, Today and Drive mode. See \`docs/SETUP.md\` → "Phone (PWA)".
2. **Turn on Claude.** Accounts → Claude → **Connect**: open the sign-in link, sign in to claude.ai, paste the code back. That saves the token and switches agents to Claude. Then send the "First check after deploying" message from \`docs/SETUP.md\`. **This is the first real agent run; nothing here could test it.**
3. **Notifications:** bell → Notification settings → Enable on this device. Consider turning on "Let approvals through" during quiet hours.
4. **Google (Calendar + Drive, one sign-in):** follow \`docs/SETUP.md\` → "Personal assistant". Set the consent screen to **In production** (otherwise the token dies after 7 days), run \`pnpm --filter @cc/pa google:auth\` on your PC, set the \`GOOGLE_*\` variables and \`CALENDAR_ACCOUNTS\`, and optionally \`STORAGE_BACKEND=gdrive\`.
5. **Odoo:** \`ODOO_URL\`, \`ODOO_DB\`, \`ODOO_USERNAME\`, \`ODOO_API_KEY\`. Check your plan allows the external API (Odoo docs say the Custom plan). Odoo events start automatically; use \`ODOO_EVENTS=off\` to hold them.
6. **Email:** \`EMAIL_ACCOUNTS\` (Gmail app passwords). See "Email".
7. **Social:** \`SOCIAL_ACCOUNTS\` plus \`PUBLIC_BASE_URL\`. Notes:
   - **X** costs money per post (≈$0.015, $0.20 with a link). The free tier ended Feb 2026.
   - **Reddit:** the password sign-in doesn't work on accounts with 2FA, and new API access needs Reddit's approval. Apply early.
   - **Instagram/Threads** tokens last 60 days; renewal is manual for now.
   - **YouTube:** press "Publish app" on the consent screen; do one unlisted test upload.
8. **Voice (optional):** \`OPENAI_API_KEY\` and/or \`ELEVENLABS_API_KEY\` for better voices. Test Drive mode on your phone in the car. iPhone home-screen speech recognition may need the server voice.
9. **Morning brief / evening wrap:** set \`enabled: true\` in \`packages/verticals/src/org.ts\` (morning brief) and \`packages/verticals/src/personal.ts\` (evening wrap), then push.

## Decisions waiting for you

- Which roles to rely on first (suggested: DMS Customer Support, Ops & Admin, and the morning brief).
- Autonomy: everything outward-facing is "draft" (needs approval). Promote action types once you trust them. Personal \`notify\` is currently auto-with-digest.
- Video: brand kits (logos, colours, fonts), voice choice, demo logins, which PC renders, and how often. Full list in \`docs/VIDEO.md\`.
- Low-stock threshold (default 3) and big-order threshold for Odoo events.

## Known gaps

- **Not tried against real services:** Claude agent runs, Odoo, mail servers, Google, Meta, Reddit, X, YouTube, Jev and voice providers are all tested against fakes. The first live use of each is its real test.
- **Windows installer** never built here. Run the "Desktop" GitHub Action.
- **No \`main\` branch yet,** so no PR and no CI run. Create \`main\` from \`780b23e\` and I'll open the PR.
- Two separate Google token helpers (PA and storage). They work, but should be merged into one.
- A rare test-cache race between packages was seen once when running tests in parallel. Watch CI.
`,
  },
];
