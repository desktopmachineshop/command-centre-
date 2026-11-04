---
name: brain-notes
description: Conventions for reading and writing the command centre's long-term memory (the "brain" MCP server). Use whenever you look something up about Dave's businesses or life, or learn a fact, decision or outcome worth keeping.
---

# Brain notes

The brain is a store of markdown notes (in the server's database; Dave edits the same notes in
the app, and every save is kept in a note's history). Use the `brain` MCP tools: `search`,
`read`, `write`, `append_journal`, `list`.

## Before acting

Search the brain for the customer, product, supplier or topic first. Read any note that looks
relevant before you answer or propose an action.

## Where things go

| What | Path |
| --- | --- |
| A customer, supplier or contact | `<vertical>/people/<kebab-name>.md`; cross-vertical people go in `people/` |
| A product or service | `<vertical>/products/<sku-or-name>.md` |
| A decision and its reasoning | `<vertical>/decisions/YYYY-MM-DD-<topic>.md` |
| A repeatable how-to | `<vertical>/playbooks/<topic>.md` |
| Something that happened today | `append_journal` (one line, with the vertical) |
| A bug, fault or problem with the Command Centre, an agent or an integration | `report_issue` (the central issue log, `issues/`), never your own folder |

## Note format

```markdown
---
type: customer        # customer | supplier | product | decision | playbook | note
vertical: dms
tags: [wholesale]
---

# Jane Doe

Short summary first, then details. Link related notes with [[other-note]].

## History
- 2026-10-23: Asked about ER11 collets for a 300W spindle; recommended the 7-piece set.
```

## Issues

Every agent uses one issue log: `issues/`, written with the brain tools `report_issue`,
`list_issues` and `update_issue` (plain `write` refuses issue notes outside it). Report anything
broken or wrong in the app, an agent's behaviour, or an outside service: a page that fails, a tool
error, a sync that dropped data, a skill that told you the wrong thing.

- `category`: `ui`, `backend`, `integration`, `agent` (an agent's skill, prompt, routing or
  permissions), `data`, `infrastructure`, `docs` or `other`.
- `agent`: the role id of the agent affected (yourself if you went wrong), or `none`.
- `severity`: `critical` (data loss, security, everything down), `high` (a feature unusable),
  `medium` (wrong but workable), `low` (cosmetic).
- A specific title ("Odoo stock sync skips variants", not "Odoo problem"), and in the description
  what happened, what should have, and how to see it again. Never put secrets in it.
- Seen it again? `report_issue` with the same title adds a History line rather than a duplicate.
- Log it and carry on with your task; don't work around it silently. The Software Lead
  triages the log and files it on GitHub.

## Rules

- Update an existing note rather than creating a duplicate. Read it, then write the full new
  version, keeping what was there.
- Record facts and outcomes, not chit-chat. Never store passwords, card numbers or other secrets.
- Prefer one journal line per meaningful event: "Replied to Jane Doe about ER11 collets (draft approved)".
