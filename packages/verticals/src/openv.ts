import { defineVertical } from "@cc/core";

export default defineVertical({
  id: "openv",
  name: "OpenV",
  description: "Open requirements management SaaS.",
  brainFolder: "openv",
  intents: ["support", "bug", "feature-request", "billing"],
  skills: ["brain-notes", "email-triage-and-reply"],
  mcpServers: ["brain", "pa"],
  policies: { "brain.write": "auto" },
});
