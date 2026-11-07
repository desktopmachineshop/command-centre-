# Plan: gym, body and money tracking for the personal assistant

Dave asked for three things in the Personal area, ideally by syncing with existing open-source or
free tools rather than building trackers from scratch:

1. gym tracking (openGym);
2. food, weight and body measurements;
3. spending, read-only from Nationwide, for analysis;
4. a shopping list and a recipe book.

Order agreed: gym first, then food and measurements, then finance. Shopping and recipes fit
alongside food (section 4).

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

What openGym's own plans say (ROADMAP.md, issues, November 2026):

- **Body weight and measurements are already in openGym.** Weigh-ins with a goal line; one
  measurement check-in per day with neck, chest, waist, hips, arms, legs, body fat %, and custom
  fields in cm/in, %, kg/lb or a plain number (#82, #699). Command Centre reads them with
  `get_measurements`. Nothing to build.
- **Body composition** (fat %, muscle mass, water, visceral fat, BMR as proper fields with charts,
  later filled from Health Connect and Apple Health) is the maintainer's own design in **#648**,
  milestone v1.4.6, nobody assigned. Until it lands, custom fields cover it (Muscle mass in kg,
  Visceral fat as a plain number). This is the best openGym contribution on Dave's list: it is
  wanted, designed and scheduled. Offer it on the issue first, then build it to that design.
- **Food is not meant to go into openGym.** The roadmap lists "openNutrition, the sister app for
  food" under later ideas, and a community PR adding a nutrition tracker to openGym (#947) has had
  no review. Building food into openGym would work against the project's direction.

For food, then:

1. Ask the maintainer (openGym Discussions → Ideas, or Discord) whether openNutrition has a plan
   and would welcome help, and how it should share data with openGym (weight, body composition).
   If it is starting, contribute there.
2. Until then, keep food out of openGym: log meals in Command Centre ("two eggs on toast" by chat
   or photo, macros from Open Food Facts), and keep the data simple enough to move into
   openNutrition later. wger stays the fallback if a full food app is wanted sooner.

### Fork, deploy the fork, upstream later

Changes are made in a fork under Dave's GitHub account, and Railway builds and runs the fork,
so the features are usable straight away. Each feature is its own branch in the fork, and also
goes upstream as its own PR. Once upstream has merged everything the fork carries, Railway goes
back to the official `ghcr.io/duartesantos8/opengym-*` images and the fork is retired.

- `main` in the fork = upstream `main` + the feature branches merged in. Railway deploys it,
  building `api/Dockerfile` and `web/Dockerfile` instead of pulling images.
- Pull upstream into the fork regularly (a scheduled GitHub Action or by hand), so the upstream
  PRs stay mergeable and the fork doesn't drift.
- How openGym wants contributions (CONTRIBUTING.md, CLAUDE.md): an issue or Discussions idea
  first for anything not already designed; dependency-light (no new packages without a strong
  case); training and read-back logic as pure helpers in `frontend/src/lib` with tests beside
  them; every new UI string in every locale; no em dashes in UI text; CHANGELOG left alone; the
  CLA signed once by Dave on the first PR; changes clicked through in a browser.
- Keep stored data compatible: new fields only, in a shape agreed on the upstream issue first.
  Otherwise switching back to the official images could drop or misread data.
- Licences: AGPL-3.0 is fine for a public fork run for Dave. The exercise media (Gym visual) may
  stay in a non-commercial fork unmodified and with its notice; nothing here is commercial.
- The fork is outside this repository, so it has to be added to the Claude session before any
  code is written.

## 4. Shopping list and recipe book

The shopping list already exists: `pa` lists ("add milk to shopping"), on the phone through the
app and by voice. What's missing is recipes, and getting from a recipe or a week's meal plan to
the list.

For recipes, use **[Mealie](https://github.com/mealie-recipes/mealie)** (open source, self-hosted, REST API):

- imports a recipe from a URL (most recipe sites), or one typed in or photographed;
- meal planner, and "add ingredients to shopping list", merging duplicates;
- nutrition per serving when it is entered or imported, which feeds section 2;
- one Docker image (SQLite or Postgres), so it is easy to host on Railway next to openGym.

[Tandoor Recipes](https://github.com/TandoorRecipes/recipes) is the alternative (stronger on
food and nutrition data, heavier to run). Mealie is simpler and enough for a family recipe book.

Command Centre side (`packages/recipes`, read and write through Mealie's API, with an API token
on the Accounts page):

- tools at `/mcp/recipes`: `search_recipes`, `get_recipe`, `import_recipe` (from a URL Dave
  sends), `meal_plan` (read and set the week), `ingredients_for` (a recipe or the week, scaled);
- one shopping list, not two: either ingredients go onto the `pa` "shopping" list (what Dave
  already uses), or `pa` reads and writes Mealie's list. Decide when this is built; the first is
  less work and keeps voice and reminders as they are.
- "What's for dinner this week?": the assistant plans from saved recipes, sets Mealie's meal
  plan, and adds what's missing to the shopping list.

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
