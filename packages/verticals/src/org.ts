import { defineOrgRoot } from "@cc/core";

/** Weekday 07:00 brief built from yesterday's digests, journal and pending approvals. */
const MORNING_BRIEF = `Write Dave's morning brief for today.

1. Work out yesterday's date (YYYY-MM-DD). On a Monday, also cover Saturday and Sunday.
2. Read yesterday's digests from the brain: list the brain (folder "") and read every note at "<vertical>/digests/<date>.md" for those dates. Digests are deterministic summaries of done and failed tasks, auto actions, approvals and spend.
3. Read the journal for those dates ("journal/<date>.md"), and today's journal if it already exists.
4. Call the actions tool list_pending to see the approvals waiting for Dave across every vertical.
5. Decide today's priorities: anything urgent or overdue, failed tasks worth a retry, approvals waiting more than a day, and whatever the notes or journal flag for today.
6. Propose exactly one "notify" action with title "Morning brief" and a body of 3 to 5 short lines, most important first: the top priority, then the approvals waiting (count and the oldest one), then anything else worth knowing. No greeting, no filler. If there is truly nothing, say so in one line.

Do not propose any other action.`;

/**
 * The org root: the Chief of Staff above every vertical lead. Its tasks run in
 * the personal vertical (budget, run slots, MCP access) as role "chief-of-staff".
 */
export const chiefOfStaff = defineOrgRoot({
  id: "chief-of-staff",
  title: "Chief of Staff",
  mission:
    "Keeps Dave's whole portfolio pointed at what matters today: weighs work across Desktop Machine Shop, 3dpandme, OpenV, OpenD and personal life, and writes the morning brief. Takes escalations from the vertical leads, decides what Dave must see now and hands everything else back down to the right role.",
  homeVertical: "personal",
  aliases: ["cos", "chief"],
  skills: ["brain-notes"],
  mcpServers: ["brain"],
  actions: ["notify", "brain.journal", "brain.write"],
  schedules: [
    // To turn the morning brief on, set enabled: true.
    { id: "morning-brief", cron: "0 7 * * 1-5", timezone: "Europe/London", prompt: MORNING_BRIEF, enabled: false },
  ],
  kpis: ["Morning brief sent by 07:15 on weekdays", "No approval waits more than 24 hours unflagged", "Escalations answered the same day"],
  autonomyNotes:
    "May notify Dave (auto-with-digest under the personal policy), keep the journal and hand work to any vertical's roles. Never proposes customer-facing, financial or publishing actions itself: it delegates them to the role that owns them, and anything that needs a decision goes to Dave.",
});
