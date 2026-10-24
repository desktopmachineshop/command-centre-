import { defineVertical } from "@cc/core";

/** Weekday 07:00 brief: today's calendar, reminders and top to-dos, plus yesterday's digests and pending approvals. */
const MORNING_BRIEF = `Write Dave's morning brief for today. Follow the personal-assistant skill (UK dates, 24-hour times, concise).

1. Work out yesterday's date (YYYY-MM-DD). On a Monday, also cover Saturday and Sunday.
2. Call the pa tool list_events for today: the fixed points of the day (first commitment, anything needing travel or prep, clashes).
3. Call the pa tool list_reminders with dueBy "today" (includes overdue ones), and list_items with no list for the top open to-dos.
4. Read yesterday's digests from the brain: list the brain (folder "") and read every note at "<vertical>/digests/<date>.md" for those dates. Digests are deterministic summaries of done and failed tasks, auto actions, approvals and spend.
5. Read the journal for those dates ("journal/<date>.md"), and today's journal if it already exists.
6. Call the actions tool list_pending to see the approvals waiting for Dave.
7. Decide today's priorities: fixed calendar commitments, reminders due, overdue to-dos, approvals waiting more than a day, failed tasks worth a retry, and whatever the notes flag for today.
8. Propose exactly one "notify" action with title "Morning brief" and a body of 3 to 6 short lines, most important first: the first commitment and any clash, reminders due, the top to-do or two, then approvals waiting (count and the oldest). No greeting, no filler. If there is truly nothing, say so in one line.

Do not propose any other action.`;

/** Weekday 21:00 wrap: tomorrow's calendar, open items and what is waiting for approval. */
const EVENING_WRAP = `Write Dave's evening wrap. Follow the personal-assistant skill (UK dates, 24-hour times, concise).

1. Call the pa tool list_events for tomorrow: the first commitment (and when he must leave if it has a location), anything needing prep tonight, clashes.
2. Call list_reminders with dueBy "tomorrow" for reminders still open, and list_items with no list for open to-dos; note anything overdue.
3. Call the actions tool list_pending for approvals waiting for Dave.
4. Propose exactly one "notify" action with title "Evening wrap" and a body of 3 to 5 short lines: tomorrow's first commitment and prep, open reminders and overdue items, then approvals waiting (count and the oldest). No greeting, no filler. If tomorrow is clear and nothing is waiting, say so in one line.

Do not propose any other action and do not change any reminder or list.`;

export default defineVertical({
  id: "personal",
  name: "Personal",
  description: "Day-to-day life, planning, family, reminders and personal admin.",
  brainFolder: "personal",
  intents: ["plan", "reminder", "question", "admin"],
  skills: ["brain-notes", "email-triage-and-reply", "personal-assistant"],
  mcpServers: ["brain", "pa"],
  schedules: [
    // To turn the morning brief on, set enabled: true.
    { id: "morning-brief", cron: "0 7 * * 1-5", timezone: "Europe/London", prompt: MORNING_BRIEF, enabled: false },
    // To turn the evening wrap on, set enabled: true.
    { id: "evening-wrap", cron: "0 21 * * 0-4", timezone: "Europe/London", prompt: EVENING_WRAP, enabled: false },
  ],
  // notify only reaches Dave's own devices, so the brief is sent without an approval step and reported in the digest.
  policies: { "brain.write": "auto", notify: "auto-with-digest" },
});
