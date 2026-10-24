import { defineVertical } from "@cc/core";
import { saasRoles } from "./saas-org";

export default defineVertical({
  id: "opend",
  name: "OpenD",
  description: "Open documentation SaaS.",
  brainFolder: "opend",
  color: "#1f9a8a",
  intents: ["support", "bug", "feature-request", "billing"],
  skills: ["brain-notes", "email-triage-and-reply", "video-scriptwriter"],
  mcpServers: ["brain"],
  policies: { "brain.write": "auto" },
  roles: saasRoles("OpenD", { docsWriter: true }),
});
