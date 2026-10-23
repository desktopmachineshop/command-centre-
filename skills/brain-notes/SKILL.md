---
name: brain-notes
description: Conventions for reading and writing the command centre's long-term memory (the "brain" MCP server). Use whenever you look something up about Dave's businesses or life, or learn a fact, decision or outcome worth keeping.
---

# Brain notes

The brain is a git repo of markdown notes. Use the `brain` MCP tools: `search`, `read`,
`write`, `append_journal`, `list`.

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

## Rules

- Update an existing note rather than creating a duplicate. Read it, then write the full new
  version, keeping what was there.
- Record facts and outcomes, not chit-chat. Never store passwords, card numbers or other secrets.
- Prefer one journal line per meaningful event: "Replied to Jane Doe about ER11 collets (draft approved)".
