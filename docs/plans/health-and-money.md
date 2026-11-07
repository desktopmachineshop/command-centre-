# Plan: gym, body and money tracking for the personal assistant

Dave asked for three things in the Personal area, ideally by syncing with existing open-source or
free tools rather than building trackers from scratch:

1. gym tracking (openGym);
2. food, weight and body measurements;
3. spending, read-only from Nationwide, for analysis.

Order agreed: gym first, then food and measurements, then finance.

## 1. Gym: openGym (done in this change)

[openGym](https://github.com/DuarteSantos8/openGym) (AGPL-3.0, very active, self-hostable) is the
tracker. It already has workouts, PRs, estimated 1RMs, body weight with a goal line, imports from
Strong, Hevy and FitNotes, Apple Health and Health Connect, and signed webhooks.

Command Centre reads it over its HTTP API (`packages/opengym`):

- Auth: openGym's phone-pairing flow. Dave pastes a pairing code on the Accounts page; the server
  redeems it for a bearer token, saves it as the entry's secret, and saves each renewal openGym
  sends from `/api/me`.
- Data: `GET /api/data` (the whole state document), re-fetched only when `/api/data/rev` moves.
- Tools at `/mcp/opengym`: `training_summary`, `list_workouts`, `get_workout`, `get_bodyweight`.
  Read-only on purpose; logging stays in the app.
- openGym's own MCP server isn't used: it reads the data folder directly, so it has to run on the
  same machine as openGym.

Still to do:

- **Host openGym on Railway** (two image services plus a volume, see `docs/SETUP.md`, "Hosting
  openGym on Railway") on a domain of Dave's, then pair it.
- **Weekly training summary**: a Sunday schedule in `personal` that calls `training_summary` and
  sends one `notify`. Easy once real data is flowing; left off until then so it can be tuned
  against real numbers.
- **Webhooks**: openGym can POST signed events (workout finished, PR, weigh-in). A
  `/webhooks/opengym` ingress could congratulate PRs or update a brain note. Optional.

## 2. Food, weight and body measurements

openGym has body weight (and progress photos) today, and body composition is on its roadmap
(v1.4.6). It has no food log and no tape measurements (waist, chest, arms...).

Options:

| Option | For | Against |
| --- | --- | --- |
| **Contribute measurements, then food, to openGym** (Dave's preference) | One app for everything; the API and our tools pick it up for free; benefits the project | Upstream must agree on scope. A food diary is a big feature (food database, barcode scanning, macros) and may be judged out of scope for a gym app. openGym requires a CLA (`CLA.md`) |
| wger alongside | Has food diary (Open Food Facts, barcode), weight and custom measurements, REST API | A second app and server (Django, Postgres, Redis) |
| Log in Command Centre | Lightest; "two eggs on toast" by chat or photo | Another place for the data; no app UI |

Recommended path:

1. **Body measurements in openGym first.** Small and close to what it already has (it sits next
   to body weight and the planned body composition). Open an issue upstream proposing it
   (`bodyMeasurements[]: { d, site, value, unit }`, a chart per site, CSV export, the MCP tool),
   then a PR once the maintainer agrees. Read `CONTRIBUTING.md` and sign the CLA.
2. **Food: ask before building.** Open a discussion issue on whether nutrition fits openGym. If
   yes, start small (daily calories and protein against a target, no food database), which keeps
   the PR reviewable. If no, use wger for food only, or log meals in Command Centre.
3. Command Centre reads whichever lands through the same `/api/data` document: add
   `get_measurements` (and later `get_nutrition`) to `/mcp/opengym`.

Working on openGym means forking it under Dave's GitHub account: that repository is outside
this one, so it needs adding to the Claude session before any code is written.

## 3. Finance: Nationwide, read-only

Free routes to a UK current account's transactions, as of November 2026:

- **GoCardless Bank Account Data** (ex-Nordigen), the usual free option, no longer takes new sign-ups.
- **Enable Banking** offers a free "restricted production" mode: real data, but only from
  accounts you link yourself, which is exactly personal use. Read-only (AIS) by design.
  **To check first:** that Nationwide appears in its GB bank list (`GET /aspsps?country=GB`), and
  how far back the first fetch goes.
- Fallback: Nationwide's CSV/OFX statement download, dropped into chat.

Recommended design, `packages/finance`, same shape as Sendcloud and openGym:

- Accounts page entry "Bank (Enable Banking)": application id and the private key Enable Banking
  issues (secret). A "Connect bank" button starts the bank's consent flow and stores the session.
- Consent lasts up to 180 days under UK rules: the Accounts card shows when it runs out, and a
  reminder goes to Dave a week before to re-consent.
- A daily pull of transactions into Postgres (`finance_transactions`, keyed by the bank's
  transaction id so repeats are ignored), with a rules-plus-agent categoriser (merchant →
  category, learned from Dave's corrections).
- Tools at `/mcp/finance`: `spending_summary` (by category, period vs previous), `transactions`
  (search), `recurring` (subscriptions and direct debits found in the data), `balance`.
- Read-only end to end: no payment scopes are requested, and no action type can move money.
  Transactions are personal data: the `finance` server goes on the Personal area only (and
  Finance Admin), never on a business.

Steps: sign up for Enable Banking and confirm Nationwide → build the client and consent flow →
transactions table and daily sync → tools and a monthly spending note in the brain.
