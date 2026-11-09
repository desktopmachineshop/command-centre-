import { defineVertical } from "@cc/core";
import { INTERNAL_AUTO_POLICIES } from "./policies";
import { howWeWork } from "./how-we-work";
import { saasAreas, saasSchedules } from "./saas-org";

export default defineVertical({
  id: "openv",
  name: "OpenV",
  description: "Open requirements management SaaS.",
  brainFolder: "openv",
  color: "#3b6fd8",
  intents: ["support", "bug", "feature-request", "billing"],
  skills: ["brain-notes", "email-triage-and-reply", "video-reel", "social-platform-guide", "reddit-marketing", "competitor-analysis"],
  // reddit and research: read-only Reddit threads and web research (packages/research).
  mcpServers: ["brain", "pa", "mail", "reddit", "research"],
  policies: { ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "email.label": "auto" },
  schedules: saasSchedules("OpenV", "openv", 34),
  guidance: howWeWork("OpenV", saasAreas("OpenV")),
});
