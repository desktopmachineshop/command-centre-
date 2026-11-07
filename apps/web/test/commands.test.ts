import { describe, expect, it } from "vitest";
import { buildAliases, buildRoleBook, describeRole, parseCommand, resolveRole } from "../src/voice/commands";

const aliases = buildAliases([
  { id: "personal", name: "Personal" },
  { id: "dms", name: "Desktop Machine Shop" },
  { id: "3dpandme", name: "3dpandme" },
  { id: "openv", name: "OpenV" },
  { id: "opend", name: "OpenD" },
]);
const p = (text: string) => parseCommand(text, aliases);

describe("parseCommand", () => {
  it("recognises the briefing", () => {
    for (const t of ["What's new?", "whats new", "Briefing", "OK, brief me please", "Hey command centre, what's new"]) {
      expect(p(t), t).toEqual({ kind: "briefing" });
    }
  });

  it("recognises approval reading and navigation", () => {
    for (const t of ["Read approvals", "read my approvals", "What's waiting for approval?", "approvals"]) expect(p(t), t).toEqual({ kind: "approvals" });
    for (const t of ["Next", "next one", "skip it"]) expect(p(t), t).toEqual({ kind: "next" });
  });

  it("separates approve/reject from their confirmations", () => {
    expect(p("Approve")).toEqual({ kind: "approve" });
    expect(p("approve it")).toEqual({ kind: "approve" });
    expect(p("Reject.")).toEqual({ kind: "reject" });
    expect(p("Yes, approve")).toEqual({ kind: "confirm", action: "approve" });
    expect(p("yes approve it")).toEqual({ kind: "confirm", action: "approve" });
    expect(p("Yes, reject.")).toEqual({ kind: "confirm", action: "reject" });
    expect(p("No")).toEqual({ kind: "deny" });
    // A bare "yes" never confirms anything.
    expect(p("yes")).toEqual({ kind: "chat", text: "yes" });
  });

  it("never treats a longer sentence as an approval", () => {
    expect(p("approve the quote for Jane")).toEqual({ kind: "chat", text: "approve the quote for Jane" });
    expect(p("reject all the spam emails")).toMatchObject({ kind: "chat" });
  });

  it("recognises conversation controls", () => {
    expect(p("repeat that")).toEqual({ kind: "repeat" });
    expect(p("Say that again")).toEqual({ kind: "repeat" });
    expect(p("Stop")).toEqual({ kind: "stop" });
    expect(p("cancel")).toEqual({ kind: "cancel" });
    expect(p("never mind")).toEqual({ kind: "cancel" });
    expect(p("That's all")).toEqual({ kind: "end" });
    expect(p("that's all, thanks")).toEqual({ kind: "end" });
    expect(p("goodbye")).toEqual({ kind: "end" });
    expect(p("conversation mode")).toEqual({ kind: "mode", mode: "conversational" });
    expect(p("push to talk")).toEqual({ kind: "mode", mode: "push" });
  });

  it("routes a business prefix to its vertical, keeping the original wording", () => {
    expect(p("dms: has order 1042 shipped?")).toEqual({ kind: "chat", text: "Has order 1042 shipped?", vertical: "dms" });
    expect(p("shop: has order 1042 shipped?")).toEqual({ kind: "chat", text: "Has order 1042 shipped?", vertical: "dms" });
    expect(p("Shop, what sold yesterday")).toEqual({ kind: "chat", text: "What sold yesterday", vertical: "dms" });
    expect(p("3dpandme: draft a post about the new printer")).toEqual({ kind: "chat", text: "Draft a post about the new printer", vertical: "3dpandme" });
    expect(p("3D P and me draft a post")).toEqual({ kind: "chat", text: "Draft a post", vertical: "3dpandme" });
    expect(p("Ask machine shop whether the ER11 collets are in stock")).toEqual({
      kind: "chat",
      text: "The ER11 collets are in stock",
      vertical: "dms",
    });
    expect(p("open v colon any new tickets")).toEqual({ kind: "chat", text: "Any new tickets", vertical: "openv" });
  });

  it("needs a separator for ambiguous names", () => {
    // "shop" alone could be ordinary speech.
    expect(p("shop for a new drill")).toEqual({ kind: "chat", text: "shop for a new drill" });
    expect(p("personal: book the dentist")).toEqual({ kind: "chat", text: "Book the dentist", vertical: "personal" });
  });

  it("sends everything else to chat as said", () => {
    expect(p("Remind me to call the supplier at 3")).toEqual({ kind: "chat", text: "Remind me to call the supplier at 3" });
    expect(p("   ")).toBeNull();
  });
});

const role = (id: string, title: string, vertical: string, aliases: string[]) => ({ id, title, vertical, aliases });
const org = {
  root: {
    ...role("chief-of-staff", "Assistant", "personal", ["assistant", "cos", "chief", "chief-of-staff"]),
    verticals: [
      { id: "dms", name: "Desktop Machine Shop", specialists: [] },
      { id: "command-centre", name: "Command Centre", specialists: [role("software-lead", "Software Lead", "command-centre", ["software", "code"])] },
      {
        id: "3dpandme",
        name: "3dpandme",
        specialists: [
          role("video-producer", "Video Producer", "3dpandme", ["video", "youtube"]),
          role("blog-writer", "Blog Writer", "3dpandme", ["blog"]),
          role("social-media-manager", "Social Media & Community", "3dpandme", ["writer"]),
        ],
      },
      { id: "openv", name: "OpenV", specialists: [role("docs-specialist", "Docs Specialist", "openv", ["docs", "writer"])] },
    ],
  },
};
const book = buildRoleBook(org, aliases);
const r = (text: string) => parseCommand(text, aliases, book);
const who = (target: string) => {
  const res = resolveRole(target, book);
  return res.kind === "role" ? `${res.choice.vertical}/${res.choice.role}` : res.kind === "ambiguous" ? res.options.map((o) => `${o.vertical}/${o.role}`) : res.kind;
};

describe("talking to a role", () => {
  it("recognises switching and asking who it is", () => {
    for (const t of ["Talk to the video producer", "put me through to the blog writer", "switch to youtube", "back to the assistant", "back to chief of staff", "can I speak to the COS please", "let me talk to 3dpandme blog"]) {
      expect(r(t), t).toMatchObject({ kind: "talkTo" });
    }
    expect(r("Talk to the video producer")).toEqual({ kind: "talkTo", target: "video producer" });
    expect(r("Who am I talking to?")).toEqual({ kind: "whoami" });
    expect(r("who's this")).toEqual({ kind: "whoami" });
    // Modes still win, and a long "talk to me about ..." is a request.
    expect(r("switch to conversation mode")).toEqual({ kind: "mode", mode: "conversational" });
    expect(r("talk to me about the VAT return due this month please")).toMatchObject({ kind: "chat" });
  });

  it("resolves titles, aliases and business + role, and refuses to guess", () => {
    expect(who("video producer")).toBe("3dpandme/video-producer");
    expect(who("assistant")).toBe("personal/chief-of-staff");
    expect(who("chief of staff")).toBe("personal/chief-of-staff");
    expect(who("the COS")).toBe("personal/chief-of-staff");
    expect(who("chief")).toBe("personal/chief-of-staff");
    expect(who("social media and community")).toBe("3dpandme/social-media-manager");
    expect(who("youtube")).toBe("3dpandme/video-producer");
    expect(who("software lead")).toBe("command-centre/software-lead");
    expect(who("3d p and me blog writer")).toBe("3dpandme/blog-writer");
    expect(who("open v writer")).toBe("openv/docs-specialist");
    expect(who("writer for 3dpandme")).toBe("3dpandme/social-media-manager");
    expect(who("writer")).toEqual(["3dpandme/social-media-manager", "openv/docs-specialist"]);
    expect(who("anyone")).toBe("auto");
    expect(who("automatic")).toBe("auto");
    expect(who("the plumber")).toBe("unknown");
    // Retired roles are gone.
    expect(who("shop lead")).toBe("unknown");
    expect(who("customer support")).toBe("unknown");
  });

  it("sends a one-off request to a named role, with a separator or ask/tell", () => {
    expect(r("Ask the video producer whether the lathe video is cut")).toEqual({ kind: "chat", text: "The lathe video is cut", vertical: "3dpandme", role: "video-producer" });
    expect(r("blog writer: draft a post about the new printer")).toEqual({ kind: "chat", text: "Draft a post about the new printer", vertical: "3dpandme", role: "blog-writer" });
    expect(r("Assistant, what's on my plate today")).toEqual({ kind: "chat", text: "What's on my plate today", vertical: "personal", role: "chief-of-staff" });
    expect(r("Chief of staff, what's on my plate today")).toEqual({ kind: "chat", text: "What's on my plate today", vertical: "personal", role: "chief-of-staff" });
    expect(r("tell the software lead to fix the login bug")).toEqual({ kind: "chat", text: "Fix the login bug", vertical: "command-centre", role: "software-lead" });
    // A business prefix still means the business; plain speech that starts with a role word is just a request.
    expect(r("shop: what sold yesterday")).toEqual({ kind: "chat", text: "What sold yesterday", vertical: "dms" });
    expect(r("video is the best part of the job")).toEqual({ kind: "chat", text: "video is the best part of the job" });
    // A shared name isn't guessed.
    expect(r("writer: draft the release notes")).toEqual({ kind: "chat", text: "writer: draft the release notes" });
  });

  it("says who it is", () => {
    const res = resolveRole("video producer", book);
    expect(res.kind === "role" && describeRole(res.choice)).toBe("the Video Producer at 3dpandme");
    const assistant = resolveRole("chief", book);
    expect(assistant.kind === "role" && describeRole(assistant.choice)).toBe("the Assistant");
  });
});
