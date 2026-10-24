import { describe, expect, it } from "vitest";
import { buildAliases, parseCommand } from "../src/voice/commands";

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
