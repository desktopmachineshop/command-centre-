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

Do not propose any other action, and do not use the mail tools: reading outside mail would hold this brief for approval instead of sending it.`;

/**
 * The org root: Dave's assistant. It takes every task in every business (its tasks run in the
 * business they were triaged to; its own schedules, like the morning brief, in "personal"), and hands
 * specialist work to the specialists. The id stays "chief-of-staff", which existing tasks carry.
 */
export const chiefOfStaff = defineOrgRoot({
  id: "chief-of-staff",
  title: "Assistant",
  mission:
    "The one Dave talks to, for Desktop Machine Shop, 3dpandme, OpenV, OpenD, the Command Centre and his own life admin: takes his chats and voice requests and everything that comes in (email, Odoo, social), does the work itself with every business's tools, and hands only specialist work (code changes, videos, blog posts) to the specialists. Writes the morning brief.",
  homeVertical: "personal",
  aliases: ["assistant", "cos", "chief", "chief-of-staff"],
  skills: ["brain-notes", "personal-assistant"],
  mcpServers: ["brain", "pa", "mail"],
  actions: ["notify", "brain.journal", "brain.write"],
  schedules: [
    // On by default. It fires at 07:00, the end of the default quiet hours (22:00-07:00), so its
    // "briefing" notify (auto-with-digest in personal) pushes straight away. To turn it off, set enabled: false.
    { id: "morning-brief", cron: "0 7 * * 1-5", timezone: "Europe/London", prompt: MORNING_BRIEF, enabled: true },
  ],
  kpis: ["Morning brief sent by 07:15 on weekdays", "No approval waits more than 24 hours unflagged", "Escalations answered the same day"],
  autonomyNotes:
    "Proposes whatever the work needs, in the business it is for; that business's policy decides whether it runs or waits for Dave. Anything customer-facing, financial or published, and every decision a business's how-we-work note reserves for Dave, waits for his approval.",
});
