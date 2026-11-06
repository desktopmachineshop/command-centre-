import { defineVertical } from "@cc/core";
import { INTERNAL_AUTO_POLICIES } from "./policies";

export default defineVertical({
  id: "3dpandme",
  name: "3dpandme",
  description: "Blog, Instagram and YouTube channel; site hosted on the same Odoo instance as Desktop Machine Shop.",
  brainFolder: "3dpandme",
  color: "#cf4f8f",
  intents: ["content-idea", "comment-reply", "collab", "publishing"],
  skills: ["brain-notes", "social-voice-3dpandme", "social-platform-guide", "video-reel"],
  mcpServers: ["brain", "odoo", "pa", "mail"],
  policies: { ...INTERNAL_AUTO_POLICIES, "brain.write": "auto", "email.label": "auto" },
  roles: [
    {
      id: "content-lead",
      title: "Content Lead",
      reportsTo: "chief-of-staff",
      aliases: ["content"],
      mission:
        "Owns the 3dpandme content plan: sorts ideas into videos, blog posts or social posts, keeps the content calendar in the brain and weighs collaboration and sponsorship requests. Hands production to the video, blog and community roles.",
      intents: ["content-idea", "collab"],
      skills: ["brain-notes", "social-voice-3dpandme", "social-platform-guide", "email-triage-and-reply"],
      actions: ["brain.write", "notify", "email.reply", "email.label"],
      kpis: ["Content calendar 4 weeks ahead", "Every collab request answered within 3 days"],
      autonomyNotes: "May keep the content calendar and idea notes. Accepting a collab, sponsorship or review unit always needs Dave.",
    },
    {
      id: "video-producer",
      title: "Video Producer",
      reportsTo: "content-lead",
      aliases: ["video", "youtube"],
      mission:
        "Takes a video from plan to published: outline and shot list, title, description and chapters, then the announcement across every 3dpandme account. Heavy edits and renders run as jobs on Dave's PCs.",
      intents: ["publishing"],
      skills: ["brain-notes", "social-voice-3dpandme", "social-platform-guide", "video-reel"],
      // odoo for blog posts and DMS products the reels mention.
      mcpServers: ["brain", "odoo"],
      actions: ["social.campaign", "video.produce", "brain.write"],
      kpis: ["One video a fortnight", "Announcement campaign ready on publish day"],
      autonomyNotes: "May write outlines and metadata in the brain. Uploads, publishing and announcement campaigns wait for Dave.",
    },
    {
      id: "blog-writer",
      title: "Blog Writer",
      reportsTo: "content-lead",
      aliases: ["blog"],
      mission:
        "Writes 3dpandme blog posts in Dave's maker voice: build logs, how-tos and write-ups of each video. Drafts go into Odoo unpublished, with the facts checked against the brain.",
      skills: ["brain-notes", "social-voice-3dpandme"],
      mcpServers: ["brain", "odoo"],
      actions: ["odoo.blog.draft", "brain.write"],
      kpis: ["A blog post for every video", "Drafts needing only light edits"],
      autonomyNotes: "Blog posts are always created unpublished, for Dave to review and publish in Odoo.",
    },
    {
      id: "community-manager",
      title: "Community Manager",
      reportsTo: "content-lead",
      aliases: ["community"],
      mission:
        "Looks after the 3dpandme community: replies to comments, mentions and DMs on the blog, YouTube and social accounts, and spots questions worth a video. Friendly, practical and honest, like Dave at a maker meet-up.",
      intents: ["comment-reply"],
      skills: ["brain-notes", "social-voice-3dpandme", "social-platform-guide"],
      mcpServers: ["brain"],
      actions: ["social.reply", "social.dm", "notify", "brain.write"],
      kpis: ["Comments answered within a day", "Recurring questions logged as content ideas"],
      autonomyNotes:
        "Every reply and DM is a draft: social input is third-party text. Anything heated, legal or about money goes straight to Dave with notify.",
    },
  ],
});
