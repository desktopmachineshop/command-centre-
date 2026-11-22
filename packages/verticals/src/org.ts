import { defineOrgRoot } from "@cc/core";

/** Weekday 07:00 brief: today's calendar, reminders and top to-dos, plus yesterday's digests and pending approvals. */
const MORNING_BRIEF = `Write Dave's morning brief for today. Follow the personal-assistant skill (UK dates, 24-hour times, concise).

1. Work out yesterday's date (YYYY-MM-DD). On a Monday, also cover Saturday and Sunday.
2. Call the pa tool list_events for today: the fixed points of the day (first commitment, anything needing travel or prep, clashes).
3. Call the pa tool list_reminders with dueBy "today" (includes overdue ones), and list_items with no list for the top open to-dos.
4. Read yesterday's digest from the brain: the note at "digests/<date>.md" covers every business for that day (if it isn't there, read each "<vertical>/digests/<date>.md" that is). Digests are deterministic summaries of done and failed tasks, auto actions, orders and revenue, parcels, approvals and spend: they are the record of what ran by itself.
5. Read the journal for those dates ("journal/<date>.md"), and today's journal if it already exists.
6. Call the actions tool list_pending to see the approvals waiting for Dave across every vertical.
7. Decide today's priorities: fixed calendar commitments, reminders due, overdue to-dos, approvals waiting more than a day, failed tasks worth a retry, and whatever the notes or journal flag for today.
8. Learning: list "learning/lessons/" in the brain and read the newest lesson's frontmatter (from today or yesterday, status ready), and the "## Up next" section of "learning/topics.md". Write the learning line as the career-coach skill says ("The morning brief's learning line").
9. Propose exactly one "notify" action with title "Morning brief", category "briefing" and a body of 3 to 8 short lines, most important first: the first commitment and any clash, reminders due, the top to-do or two, then the approvals waiting (count and the oldest one), then one line summing up what was done without him yesterday (orders and revenue, tasks done and anything that failed, naming a business only where there is something to say), then anything else worth knowing, and last the learning line (always, even on a quiet day). No greeting, no filler. If there is truly nothing else, say so in one line before the learning line.

Do not propose any other action, and do not use the mail tools: reading outside mail would hold this brief for approval instead of sending it.`;

/** Daily 05:40, before the brief: the career coach picks a topic and writes a 30-minute lesson into the brain. */
export const DAILY_LESSON_ID = "daily-lesson";
const DAILY_LESSON = `Write today's learning lesson for Dave. Follow the career-coach skill exactly: it says where the topic map and lessons live, how to pick the topic and how to write a 30-minute lesson that works read or listened to.

1. Work out today's date in Europe/London (YYYY-MM-DD).
2. Read "learning/topics.md" (Requested, Up next, Backlog, Taught, Preferences) and list "learning/lessons/". If a lesson dated today already exists, stop: say so in one line and do nothing else.
3. Pick today's topic as the skill says (Requested first, then rotate tracks, timely news preferred, never a repeat).
4. Research it on the web where it is recent or specific, then write the lesson (4,300 to 4,800 words, spoken style, the skill's headings and frontmatter, status ready) to "learning/lessons/<date>-<slug>.md".
5. Update "learning/topics.md": move the topic to Taught and top Up next back up to three to five topics across the tracks.

Do not propose any action (no notify: the morning brief mentions the lesson), and do not use the mail tools. Finish with one line: the title and track.`;

/**
 * The org root: Dave's assistant. It takes every task in every business (its tasks run in the
 * business they were triaged to; its own schedules, like the morning brief, in "personal"), and hands
 * specialist work to the specialists. The id stays "chief-of-staff", which existing tasks carry.
 */
export const chiefOfStaff = defineOrgRoot({
  id: "chief-of-staff",
  title: "Assistant",
  mission:
    "The one Dave talks to, for Desktop Machine Shop, 3dpandme, OpenV, OpenD, the Command Centre and his own life admin: takes his chats and voice requests and everything that comes in (email, Odoo, social), does the work itself with every business's tools, and hands only specialist work (code changes, videos, blog posts) to the specialists. Writes the morning brief, and coaches him with a daily 30-minute lesson.",
  homeVertical: "personal",
  aliases: ["assistant", "cos", "chief", "chief-of-staff"],
  skills: ["brain-notes", "personal-assistant", "career-coach"],
  mcpServers: ["brain", "pa", "mail"],
  actions: ["notify", "brain.journal", "brain.write"],
  schedules: [
    // On by default. It fires at 07:00, the end of the default quiet hours (22:00-07:00), so its
    // "briefing" notify (auto-with-digest in personal) pushes straight away. To turn it off, set enabled: false.
    { id: "morning-brief", cron: "0 7 * * 1-5", timezone: "Europe/London", prompt: MORNING_BRIEF, enabled: true },
    // Every day (weekends too), before the brief, so the lesson is ready for the drive in. Writes only to the brain.
    { id: DAILY_LESSON_ID, cron: "40 5 * * *", timezone: "Europe/London", prompt: DAILY_LESSON, enabled: true },
  ],
  kpis: ["Morning brief sent by 07:15 on weekdays", "A 30-minute lesson ready in Learning by 07:00 every day", "No approval waits more than 24 hours unflagged", "Escalations answered the same day"],
  autonomyNotes:
    "Proposes whatever the work needs, in the business it is for; that business's policy decides whether it runs or waits for Dave. Anything customer-facing, financial or published, and every decision a business's how-we-work note reserves for Dave, waits for his approval.",
});
