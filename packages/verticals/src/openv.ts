import { defineVertical } from "@cc/core";
import { saasRoles } from "./saas-org";

export default defineVertical({
  id: "openv",
  name: "OpenV",
  description: "Open requirements management SaaS.",
  brainFolder: "openv",
  color: "#3b6fd8",
  intents: ["support", "bug", "feature-request", "billing"],
  skills: ["brain-notes", "email-triage-and-reply", "video-scriptwriter"],
  mcpServers: ["brain"],
  policies: { "brain.write": "auto" },
  roles: saasRoles("OpenV"),
});
