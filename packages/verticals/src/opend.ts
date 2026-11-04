import { defineVertical } from "@cc/core";
import { INTERNAL_AUTO_POLICIES } from "./policies";
import { saasRoles } from "./saas-org";

export default defineVertical({
  id: "opend",
  name: "OpenD",
  description: "Open documentation SaaS.",
  brainFolder: "opend",
  color: "#1f9a8a",
  intents: ["support", "bug", "feature-request", "billing"],
  skills: ["brain-notes", "email-triage-and-reply", "video-reel"],
  mcpServers: ["brain", "pa"],
  policies: { ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "email.label": "auto" },
  roles: saasRoles("OpenD", { docsWriter: true }),
});
