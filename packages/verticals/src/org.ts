import { defineOrgRoot } from "@cc/core";

/** Weekday 07:00 brief: today's calendar, reminders and top to-dos, plus yesterday's digests and pending approvals. */
const MORNING_BRIEF = `Write Dave's morning brief for today. Follow the personal-assistant skill (UK dates, 24-hour times, concise).

1. Work out yesterday's date (YYYY-MM-DD). On a Monday, also cover Saturday and Sunday.
2. Call the pa tool list_events for today: the fixed points of the day (first commitment, anything needing travel or prep, clashes).
3. Call the pa tool list_reminders with dueBy "today" (includes overdue ones), and list_items with no list for the top open to-dos.
4. Read yesterday's digests from the brain: list the brain (folder "") and read every note at "<vertical>/digests/<date>.md" for those dates. Digests are deterministic summaries of done and failed tasks, auto actions, approvals and spend.
5. Read the journal for those dates ("journal/<date>.md"), and today's journal if it already exists.
6. Call the actions tool list_pending to see the approvals waiting for Dave across every vertical.
7. Decide today's priorities: fixed calendar commitments, reminders due, overdue to-dos, approvals waiting more than a day, failed tasks worth a retry, and whatever the notes or journal flag for today.
8. Propose exactly one "notify" action with title "Morning brief", category "briefing" and a body of 3 to 6 short lines, most important first: the first commitment and any clash, reminders due, the top to-do or two, then the approvals waiting (count and the oldest one), then anything else worth knowing. No greeting, no filler. If there is truly nothing, say so in one line.

Do not propose any other action.`;

/**
 * The org root: the Chief of Staff above every vertical lead. Its tasks run in
 * the personal vertical (budget, run slots, MCP access) as role "chief-of-staff".
 */
export const chiefOfStaff = defineOrgRoot({
  id: "chief-of-staff",
  title: "Chief of Staff",
  mission:
    "Dave's front door and the one he talks to: takes his chats and voice requests, handles the quick and personal ones itself, hands the rest to the right role in Desktop Machine Shop, 3dpandme, OpenV, OpenD or personal life, and tells him the outcome when they report back. Weighs work across the portfolio, writes the morning brief, and takes escalations from the vertical leads.",
  homeVertical: "personal",
  aliases: ["cos", "chief"],
  skills: ["brain-notes", "personal-assistant"],
  mcpServers: ["brain", "pa", "mail"],
  actions: ["notify", "brain.journal", "brain.write"],
  schedules: [
    // To turn the morning brief on, set enabled: true.
    { id: "morning-brief", cron: "0 7 * * 1-5", timezone: "Europe/London", prompt: MORNING_BRIEF, enabled: false },
  ],
  kpis: ["Morning brief sent by 07:15 on weekdays", "No approval waits more than 24 hours unflagged", "Escalations answered the same day"],
  autonomyNotes:
    "May notify Dave (auto-with-digest under the personal policy), keep the journal and hand work to any vertical's roles. Never proposes customer-facing, financial or publishing actions itself: it delegates them to the role that owns them, and anything that needs a decision goes to Dave.",
});
