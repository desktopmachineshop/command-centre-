# Plan: post to Reddit from Dave's own browser (desktop-worker job)

**Status:** built 2026-11-10 (see "What was built" at the end; user docs: docs/SETUP.md, "Reddit
from your own PC"). Not yet run against real Reddit or real Chrome on Windows. Written
2026-11-09 alongside Reddit session mode (docs/SETUP.md, "Reddit without a developer app").

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

## What was built (2026-11-10)

The shape above, with these decisions:

- **Credentials** `{ browserNode: "<node id or name>" | "any" }`; the username is the account's
  handle (required on the Accounts kind `reddit-browser`, "Reddit (posts from my PC)"). Paced by
  default exactly like session accounts; inbox checked every 10 minutes (each check is a job).
- **Request building and error mapping are shared, not copied.** The adapter builds the same
  forms and queries for every mode. The job's result is Reddit's own JSON (plus the signed-in
  user), which the server reads with the same code as session mode (`throwJsonErrors`,
  `httpError`, `pageError`); `/api/me.json` and the login redirect are read by one pair of pure
  functions in `@cc/core` (`readMe`, `readRedirect`) that both session mode and the worker use.
  So the job returns `{ ok: true, user, status, data }` or `{ ok: false, code, message }` (codes
  `USER_REQUIRED`, `WRONG_USER`, `USER_SUSPENDED`, `RATELIMIT`, `BLOCKED`, `REDIRECT`, `BROWSER`,
  `TIMEOUT`) rather than `{ id, url }`: `{ id, url }` is still what the action returns.
- **Fixed ops, fixed paths.** `comment`, `submit`, `compose`, `inbox`, `sent`, `info`, `whoami`,
  `login`; the worker maps each to one old.reddit.com path and never takes a path or the modhash
  from the server. The payload names the account's username; the worker refuses (`WRONG_USER`)
  when its window is signed in as someone else.
- **In-page requests only** (`context.request`, the window's cookies and Chrome's own
  User-Agent). The fallback of filling the visible form was not built: if Reddit refuses the
  in-page request, the job fails with what Reddit said.
- **Window:** `launchPersistentContext(<dir of worker.json>/reddit-profile, { headless: false })`
  with the Chrome/Edge that screen capture found. One window, one job at a time; it stays open
  between jobs and closes after 15 idle minutes (open question 3: visible, not minimised).
- **Sign-in:** a `login` job from the Devices page (**Sign in to Reddit on this PC**, `POST
  /api/nodes/:id/reddit-login`, waits 5 minutes) or `cc-worker reddit-login` (10 minutes); both
  open `old.reddit.com/login` in that profile and wait until `/api/me.json` names a user.
- **Waiting for the result** (`WorkerService.run`): a job no PC takes within a minute (offline,
  or busy with e.g. a capture) is cancelled and counts as "PC not there"; a running one is
  awaited up to 5 minutes. Posts are run **at most once**: if the PC drops mid-job the job is
  cancelled, not requeued, and the action fails with "check Reddit before sending it again".
  Read jobs are deleted once read.
- **Open question 2, answered: replies wait for the PC.** A send that fails only because the PC
  isn't there throws `PcOfflineError` (`retryable`). The executors put an approved one in the
  outbox for 5 minutes later instead of failing it, and `sendDueSubmissions` puts a due one back
  (`SubmissionStore.deferSubmission`) instead of failing it; one push per account ("Reddit posts
  are waiting for your PC") until one goes out. Campaign and scheduled posts still fail with the
  message. Everything Reddit itself refused fails as before. No migration was needed.

**Verified** (tests, no network): the worker handler against a local HTTP stand-in for
old.reddit.com with Playwright's Chromium (`apps/worker/test/reddit.test.ts`: sign-in through
the login page and the profile keeping it, comment/submit/compose/inbox with cookie, modhash and
Chrome's own User-Agent, stale modhash retried once, wrong user refused, block page, login
redirect, sign-in timeout, one job at a time, window reopening); the adapter with an in-memory
`BrowserJobs` (`packages/social/test/reddit-browser.test.ts`); and the server end to end with a
fake connected PC (`apps/server/test/reddit-browser.test.ts`: Accounts kind and Test, approved
reply → job → result, pacing, PC off → queued, one push, deferred, sent when back, busy PC,
dropped PC not rerun, signed-out alert, Devices sign-in).

**Not verified:** real Chrome or Edge on Windows (only Linux Chromium, headless because the test
machine has no display), a real Reddit sign-in, and open question 1: whether Reddit serves
`old.reddit.com/api/*` to a Playwright-driven Chrome. The manual checklist above (sign in,
**Test**, one reply in r/test, one expired-session run) is still to do on Dave's PC.
