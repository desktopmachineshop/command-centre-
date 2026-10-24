import { defineVertical } from "@cc/core";

export default defineVertical({
  id: "3dpandme",
  name: "3dpandme",
  description: "Blog, Instagram and YouTube channel; site hosted on the same Odoo instance as Desktop Machine Shop.",
  brainFolder: "3dpandme",
  intents: ["content-idea", "comment-reply", "collab", "publishing"],
  skills: ["brain-notes", "social-voice-3dpandme", "social-platform-guide"],
  mcpServers: ["brain", "odoo", "pa"],
  policies: { "brain.write": "auto" },
});
