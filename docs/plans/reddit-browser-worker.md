# Plan: post to Reddit from Dave's own browser (desktop-worker job)

**Status:** designed, not built. Written 2026-11-09 alongside Reddit session mode
(docs/SETUP.md, "Reddit without a developer app"). Build this only if session mode turns out not
to work from the server.

## Why this might be needed

Session mode sends Dave's `reddit_session` cookie from the **server** (Railway) to
old.reddit.com. Two things can stop that:

- Reddit refuses many data-centre addresses outright, cookie or no cookie. The connection
  **Test** would fail with *Reddit refused the session check (HTTP 403)*.
- Reddit may tie a session to the device it was created on, or ask for a captcha when a cookie
  turns up somewhere new.

Neither can be (or should be) worked around from the server. The honest alternative is to post
from the place the session really lives: **a Chrome profile on Dave's own PC, in which he signed
in to Reddit himself**, driven by the desktop worker that already drives Chrome for
`video.capture`.

This was not built because it can't be verified from the build machine: it depends on Reddit's
live page structure, which needs a real signed-in browser to develop against, and the session
(cookie) mode had to be made solid first.

## Shape

```
approved social.reply ─► Reddit adapter (credentials { browserNode: "…" })
                              │  enqueue job, wait for its result (≤ 5 min)
                              ▼
        worker on Dave's PC: job kind "social.reddit.browser" (needs capability `browser`)
                              │  Playwright, persistent Chrome profile, visible window
                              ▼
                 old.reddit.com thread page ─► fill the reply box ─► Save ─► read back the permalink
```

Everything upstream is unchanged: the same `social.reply` / `social.post` / `social.dm`
proposals, the same approvals and batches, the same pacing (`packages/social/src/pacing.ts`), the
same "expired sign-in" alert. Only the last hop differs.

### Pieces

1. **A third credential mode on the Reddit adapter** (`packages/social/src/adapters/reddit.ts`):
   `{ browserNode?: "<worker node id or 'any'>", username }`. `isRedditBrowserAccount`, paced by
   default like session accounts. The adapter gets a `BrowserJobs` dependency
   (`run(kind, payload, { capability: "browser", timeoutMs }) => Promise<result>`), injected by
   the server from `apps/server/src/workers.ts` (enqueue, then await the job's completion the way
   `video.ts` awaits capture jobs). No worker online: fail with "the PC that posts to Reddit
   isn't connected (Devices page)"; with the outbox, a queued item simply fails and alerts.
2. **Job kind `social.reddit.browser`** in `packages/core` (the job schema) and
   `apps/worker/src/handlers/reddit.ts`, registered in `handlers/registry.ts` behind the existing
   `browser` capability. Payload: `{ op: "whoami" | "comment" | "submit" | "compose" | "inbox", … }`
   with exactly the fields the adapter already builds for `/api/comment`, `/api/submit`,
   `/api/compose`. Result: `{ id, url }`, or `{ error, code }` with the same codes the session
   client throws (`USER_REQUIRED`, `RATELIMIT`, `THREAD_LOCKED`…).
3. **A persistent profile.** `chromium.launchPersistentContext(<worker data dir>/reddit-profile,
   { executablePath: findBrowser(...), headless: false })`, using `apps/worker/src/browser.ts`'s
   browser and playwright-core discovery. Not Dave's everyday Chrome profile: a separate one, so
   the worker never touches his other sign-ins and Chrome doesn't complain about a profile in use.
4. **One-time sign-in, by hand.** A "Sign in to Reddit on this PC" button on the Devices page
   (and `cc-worker reddit-login`) opens that profile's window at
   `https://old.reddit.com/login`. Dave types his username, password and 2FA code himself; the
   worker never sees or stores them. The window closes when `/api/me.json` reports a username.
5. **Doing the action.** Prefer the page's own form endpoints over clicking:
   with the profile's cookies, `page.request.get("https://old.reddit.com/api/me.json")` gives the
   modhash, and `page.request.post("/api/comment", { form })` posts from inside the real browser
   session (same origin, same cookies, same address as Dave browsing). That reuses the session
   client's request building and error mapping almost unchanged, and avoids depending on DOM
   selectors. Fall back to filling the visible form (`textarea[name=text]`, `button.save` on
   old.reddit.com) only if the in-page request is refused.
6. **Inbound.** `op: "inbox"` returns `/message/inbox.json` through the same in-page request, so
   the adapter's poll works; with the PC off, polling pauses (logged, with backoff) and catches up
   by cursor when it returns.
7. **Accounts page.** A kind `reddit-browser` (vertical, handle, which PC, the pacing fields);
   **Test** runs `op: "whoami"` on the worker and shows the username and karma, or "not signed in
   on <PC>: press Sign in to Reddit on the Devices page".

### What it must not do

The same lines as session mode, and they matter more here because a real browser makes the
other things easy:

- **No stealth.** No `playwright-extra`, no stealth or fingerprint plugins, no patched
  `navigator.webdriver`, no fake User-Agent, no headless-detection evasion. A normal Chrome,
  visibly open on Dave's PC.
- **No proxies or address rotation**, no captcha solving (if Reddit shows one, stop and tell
  Dave: he can solve it in that window himself), no second accounts, no voting.
- **One account, a person's pace**: the existing pacing limits apply unchanged.
- If Reddit blocks or challenges, the job fails with what the page said.

### Tests

- `apps/worker/test/reddit.test.ts`: the handler against a local HTTP server that speaks
  old.reddit.com's form protocol (the fake in `packages/social/test/reddit-session.test.ts`,
  served over real HTTP), with Playwright's bundled Chromium where CI has it
  (`browser.test.ts` shows the skip-if-missing pattern).
- `packages/social/test`: the adapter in browser mode with an in-memory `BrowserJobs`.
- `apps/server/test`: an approved reply becomes a `social.reddit.browser` job, the job's result
  becomes the proposal's result; no worker online fails clearly; pacing still queues.
- A manual checklist against the real site, run once by Dave: sign in, **Test**, one reply in a
  test subreddit (r/test), one expired-session run.

### Open questions

- Does Reddit serve `old.reddit.com/api/*` to an automated Chrome at all? The first thing to try
  on Dave's PC, before writing any code: sign in to a fresh profile launched by Playwright and
  open `https://old.reddit.com/api/me.json`.
- Should replies wait for the PC? Today the outbox fails a queued item whose send fails. For this
  mode "PC is off" should mean "wait", not "fail": add a `retryable` flag to the failure and leave
  such items queued, with one "your PC needs to be on to post 3 Reddit replies" push.
- Whether to keep the window visible or minimised. Visible is the honest default.
