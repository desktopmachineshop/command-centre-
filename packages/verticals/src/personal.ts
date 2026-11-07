import { defineVertical } from "@cc/core";
import { howWeWork } from "./how-we-work";
import { INTERNAL_AUTO_POLICIES } from "./policies";

/** Sun–Thu 21:00 wrap: tomorrow's calendar, open items and what is waiting for approval. */
const EVENING_WRAP = `Write Dave's evening wrap. Follow the personal-assistant skill (UK dates, 24-hour times, concise).

1. Call the pa tool list_events for tomorrow: the first commitment (and when he must leave if it has a location), anything needing prep tonight, clashes.
2. Call list_reminders with dueBy "tomorrow" for reminders still open, and list_items with no list for open to-dos; note anything overdue.
3. Call the actions tool list_pending for approvals waiting for Dave.
4. Propose exactly one "notify" action with title "Evening wrap", category "briefing" and a body of 3 to 5 short lines: tomorrow's first commitment and prep, open reminders and overdue items, then approvals waiting (count and the oldest). No greeting, no filler. If tomorrow is clear and nothing is waiting, say so in one line.

Do not propose any other action and do not change any reminder or list.`;

/** The areas of personal admin (the old org chart's roles), for the how-we-work note. */
const AREAS = [
    {
      id: "pa",
      title: "Personal Assistant",
      reportsTo: "chief-of-staff",
      aliases: ["assistant"],
      mission:
        "Anything personal: answering questions, the small bits of research and keeping track of loose ends, with the personal notes in the brain kept tidy.",
      intents: ["question"],
      skills: ["brain-notes", "email-triage-and-reply", "personal-assistant"],
      mcpServers: ["brain", "pa", "mail"],
      actions: ["brain.journal", "brain.write", "notify", "email.reply", "email.label"],
      kpis: ["Questions answered the same day", "Personal inbox at zero open threads"],
      autonomyNotes: "May file notes and notify Dave. Every email or message to another person is a draft for Dave to approve.",
    },
    {
      id: "calendar-reminders",
      title: "Calendar & Reminders",
      reportsTo: "pa",
      aliases: ["calendar", "reminders"],
      mission:
        "Makes sure nothing with a date slips: appointments, renewals, deadlines and things Dave asked to be reminded about. Records each one in the brain with its date and nudges Dave ahead of time.",
      intents: ["reminder"],
      skills: ["brain-notes", "personal-assistant"],
      mcpServers: ["brain", "pa"],
      actions: ["notify", "calendar.create", "calendar.update", "calendar.delete", "brain.journal", "brain.write"],
      kpis: ["No missed renewal or appointment", "Reminders land at least a day ahead"],
      autonomyNotes:
        "Sets reminders and keeps to-do lists itself (pa tools). Calendar bookings, moves and cancellations are calendar.* proposals for Dave to approve; it never accepts invitations.",
    },
    {
      id: "home-family",
      title: "Home & Family",
      reportsTo: "pa",
      aliases: ["home", "family"],
      mission:
        "Plans the family side of life: trips, outings, events, gifts and household purchases. Turns a loose idea into a short, costed plan with options, using what the brain knows about the family's preferences.",
      intents: ["plan"],
      skills: ["brain-notes", "email-triage-and-reply", "personal-assistant"],
      mcpServers: ["brain", "pa"],
      actions: ["brain.write", "notify", "email.send"],
      kpis: ["Plans delivered with 2 to 3 options", "Family preferences kept current in the brain"],
      autonomyNotes: "May draft plans in the brain. Bookings, purchases and messages to anyone else always need Dave.",
    },
    {
      id: "health-fitness",
      title: "Health & Fitness",
      reportsTo: "pa",
      aliases: ["gym", "fitness", "health", "training"],
      mission:
        "Keeps an eye on training and body weight from openGym: how the week went, PRs, gaps since the last session and progress against the weight goal. Answers questions from the real numbers, never from memory.",
      intents: ["question"],
      skills: ["brain-notes", "personal-assistant"],
      mcpServers: ["brain", "pa", "opengym"],
      actions: ["brain.write", "notify"],
      kpis: ["Weekly training summary every Sunday", "Weight trend against goal kept current"],
      autonomyNotes: "Reads openGym only; never logs or edits workouts. May file notes and notify Dave.",
    },
    {
      id: "finance-admin",
      title: "Finance Admin",
      reportsTo: "pa",
      aliases: ["finance", "money"],
      mission:
        "Keeps personal paperwork in order: bills, bank, insurance, utilities, tax and government letters. Files what came in, works out what needs doing by when and flags anything unusual.",
      intents: ["admin"],
      skills: ["brain-notes", "email-triage-and-reply", "personal-assistant"],
      mcpServers: ["brain", "pa", "mail"],
      actions: ["brain.write", "notify", "email.reply", "email.label"],
      kpis: ["Every bill filed with its due date", "No late-payment charges"],
      autonomyNotes:
        "Never pays, transfers, cancels or signs up for anything. May file notes and remind Dave; replies to providers are drafts.",
    },
];

export default defineVertical({
  id: "personal",
  name: "Personal",
  description: "Day-to-day life, planning, family, reminders and personal admin.",
  brainFolder: "personal",
  color: "#7c5cd6",
  intents: ["plan", "reminder", "question", "admin"],
  skills: ["brain-notes", "email-triage-and-reply", "personal-assistant"],
  // mail: read-only lookups in this business's mailboxes (and, for the Chief of Staff, every one).
  // opengym: Dave's workouts and weigh-ins (read-only), while openGym is connected.
  mcpServers: ["brain", "pa", "mail", "opengym"],
  // The morning brief moved to the Chief of Staff (src/org.ts), whose tasks run in this vertical.
  // notify only reaches Dave's own devices, so the brief is sent without an approval step and reported in the digest
  // (INTERNAL_AUTO_POLICIES, shared by every vertical, with reminders and to-dos).
  policies: { ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "email.label": "auto" },
  schedules: [
    { id: "evening-wrap", cron: "0 21 * * 0-4", timezone: "Europe/London", prompt: EVENING_WRAP, enabled: false },
  ],
  guidance: howWeWork("Personal", AREAS),
});