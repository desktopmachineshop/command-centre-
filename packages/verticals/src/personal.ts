import { defineVertical } from "@cc/core";

export default defineVertical({
  id: "personal",
  name: "Personal",
  description: "Day-to-day life, planning, family, reminders and personal admin.",
  brainFolder: "personal",
  intents: ["plan", "reminder", "question", "admin"],
  skills: ["brain-notes"],
  mcpServers: ["brain"],
  policies: { "brain.write": "auto" },
});
