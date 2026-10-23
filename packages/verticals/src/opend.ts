import { defineVertical } from "@cc/core";

export default defineVertical({
  id: "opend",
  name: "OpenD",
  description: "Open documentation SaaS.",
  brainFolder: "opend",
  intents: ["support", "bug", "feature-request", "billing"],
  skills: ["brain-notes"],
  mcpServers: ["brain"],
  policies: { "brain.write": "auto" },
});
