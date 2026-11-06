import { defineVertical } from "@cc/core";
import { INTERNAL_AUTO_POLICIES } from "./policies";
import { saasRoles } from "./saas-org";

export default defineVertical({
  id: "openv",
  name: "OpenV",
  description: "Open requirements management SaaS.",
  brainFolder: "openv",
  color: "#3b6fd8",
  intents: ["support", "bug", "feature-request", "billing"],
  skills: ["brain-notes", "email-triage-and-reply", "video-reel", "social-platform-guide", "reddit-marketing"],
  mcpServers: ["brain", "pa", "mail"],
  policies: { ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "email.label": "auto" },
  roles: saasRoles("OpenV"),
});
