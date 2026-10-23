import { defineVertical } from "@cc/core";

export default defineVertical({
  id: "personal",
  name: "Personal",
  description: "Day-to-day life, planning, family, reminders and personal admin.",
  brainFolder: "personal",
  color: "#7c5cd6",
  intents: ["plan", "reminder", "question", "admin"],
  skills: ["brain-notes", "email-triage-and-reply"],
  mcpServers: ["brain"],
  // The morning brief moved to the Chief of Staff (src/org.ts), whose tasks run in this vertical.
  // notify only reaches Dave's own devices, so the brief is sent without an approval step and reported in the digest.
  policies: { "brain.write": "auto", notify: "auto-with-digest" },
  roles: [
    {
      id: "pa",
      title: "Personal Assistant",
      reportsTo: "chief-of-staff",
      aliases: ["assistant"],
      mission:
        "Dave's first stop for anything personal: answers questions, does the small bits of research and keeps track of loose ends. Passes calendar, household and money matters to the specialist who owns them, and keeps the personal notes in the brain tidy.",
      intents: ["question"],
      skills: ["brain-notes", "email-triage-and-reply"],
      actions: ["brain.journal", "brain.write", "notify", "email.reply"],
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
      skills: ["brain-notes"],
      actions: ["notify", "brain.journal", "brain.write"],
      kpis: ["No missed renewal or appointment", "Reminders land at least a day ahead"],
      autonomyNotes:
        "May notify Dave and keep the reminders note. There is no calendar connector yet, so it never books, moves or accepts anything: it tells Dave what to do.",
    },
    {
      id: "home-family",
      title: "Home & Family",
      reportsTo: "pa",
      aliases: ["home", "family"],
      mission:
        "Plans the family side of life: trips, outings, events, gifts and household purchases. Turns a loose idea into a short, costed plan with options, using what the brain knows about the family's preferences.",
      intents: ["plan"],
      skills: ["brain-notes", "email-triage-and-reply"],
      actions: ["brain.write", "notify", "email.send"],
      kpis: ["Plans delivered with 2 to 3 options", "Family preferences kept current in the brain"],
      autonomyNotes: "May draft plans in the brain. Bookings, purchases and messages to anyone else always need Dave.",
    },
    {
      id: "finance-admin",
      title: "Finance Admin",
      reportsTo: "pa",
      aliases: ["finance", "money"],
      mission:
        "Keeps personal paperwork in order: bills, bank, insurance, utilities, tax and government letters. Files what came in, works out what needs doing by when and flags anything unusual.",
      intents: ["admin"],
      skills: ["brain-notes", "email-triage-and-reply"],
      actions: ["brain.write", "notify", "email.reply"],
      kpis: ["Every bill filed with its due date", "No late-payment charges"],
      autonomyNotes:
        "Never pays, transfers, cancels or signs up for anything. May file notes and remind Dave; replies to providers are drafts.",
    },
  ],
});
