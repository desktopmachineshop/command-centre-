import { defineVertical } from "@cc/core";

/** Weekday 07:00 brief built from yesterday's digests, journal and pending approvals. */
const MORNING_BRIEF = `Write Dave's morning brief for today.

1. Work out yesterday's date (YYYY-MM-DD). On a Monday, also cover Saturday and Sunday.
2. Read yesterday's digests from the brain: list the brain (folder "") and read every note at "<vertical>/digests/<date>.md" for those dates. Digests are deterministic summaries of done and failed tasks, auto actions, approvals and spend.
3. Read the journal for those dates ("journal/<date>.md"), and today's journal if it already exists.
4. Call the actions tool list_pending to see the approvals waiting for Dave.
5. Decide today's priorities: anything urgent or overdue, failed tasks worth a retry, approvals waiting more than a day, and whatever the notes or journal flag for today.
6. Propose exactly one "notify" action with title "Morning brief", category "briefing" and a body of 3 to 5 short lines, most important first: the top priority, then the approvals waiting (count and the oldest one), then anything else worth knowing. No greeting, no filler. If there is truly nothing, say so in one line.

Do not propose any other action.`;

export default defineVertical({
  id: "personal",
  name: "Personal",
  description: "Day-to-day life, planning, family, reminders and personal admin.",
  brainFolder: "personal",
  intents: ["plan", "reminder", "question", "admin"],
  skills: ["brain-notes", "email-triage-and-reply"],
  mcpServers: ["brain"],
  schedules: [
    // To turn the morning brief on, set enabled: true.
    { id: "morning-brief", cron: "0 7 * * 1-5", timezone: "Europe/London", prompt: MORNING_BRIEF, enabled: false },
  ],
  // notify only reaches Dave's own devices, so the brief is sent without an approval step and reported in the digest.
  policies: { "brain.write": "auto", notify: "auto-with-digest" },
});
