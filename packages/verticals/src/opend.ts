import { defineVertical } from "@cc/core";

export default defineVertical({
  id: "opend",
  name: "OpenD",
  description: "Open documentation SaaS.",
  brainFolder: "opend",
  intents: ["support", "bug", "feature-request", "billing"],
  skills: ["brain-notes", "email-triage-and-reply"],
  mcpServers: ["brain", "pa"],
  policies: { "brain.write": "auto" },
});
