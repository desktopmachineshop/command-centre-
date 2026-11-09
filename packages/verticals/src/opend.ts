import { defineVertical } from "@cc/core";
import { INTERNAL_AUTO_POLICIES } from "./policies";
import { howWeWork } from "./how-we-work";
import { saasAreas, saasSchedules } from "./saas-org";

export default defineVertical({
  id: "opend",
  name: "OpenD",
  description: "Open documentation SaaS.",
  brainFolder: "opend",
  color: "#1f9a8a",
  intents: ["support", "bug", "feature-request", "billing"],
  skills: ["brain-notes", "email-triage-and-reply", "video-reel", "social-platform-guide", "reddit-marketing", "competitor-analysis"],
  // reddit and research: read-only Reddit threads and web research (packages/research).
  mcpServers: ["brain", "pa", "mail", "reddit", "research"],
  policies: { ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "email.label": "auto" },
  schedules: saasSchedules("OpenD", "opend", 46),
  guidance: howWeWork("OpenD", saasAreas("OpenD", { docsWriter: true })),
});
