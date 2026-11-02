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

const role = (id: string, title: string, vertical: string, aliases: string[], children: any[] = []) => ({ id, title, vertical, aliases, children });
const org = {
  root: {
    ...role("chief-of-staff", "Chief of Staff", "personal", ["cos", "chief"]),
    verticals: [
      {
        id: "dms",
        name: "Desktop Machine Shop",
        lead: role("shop-lead", "Shop Lead", "dms", ["shop"], [
          role("customer-support", "Customer Support", "dms", ["support"]),
          role("catalogue-pricing", "Catalogue & Pricing", "dms", ["pricing", "catalogue"]),
          role("ops-admin", "Ops & Admin", "dms", ["ops"]),
        ]),
      },
      { id: "openv", name: "OpenV", lead: role("product-lead", "Product Lead", "openv", ["product"], [role("support-engineer", "Support Engineer", "openv", ["support"])]) },
      { id: "opend", name: "OpenD", lead: role("product-lead", "Product Lead", "opend", ["product"], [role("support-engineer", "Support Engineer", "opend", ["support"])]) },
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
    for (const t of ["Talk to the shop lead", "put me through to customer support", "switch to ops", "back to chief of staff", "can I speak to the COS please", "let me talk to OpenV support"]) {
      expect(r(t), t).toMatchObject({ kind: "talkTo" });
    }
    expect(r("Talk to the shop lead")).toEqual({ kind: "talkTo", target: "shop lead" });
    expect(r("Who am I talking to?")).toEqual({ kind: "whoami" });
    expect(r("who's this")).toEqual({ kind: "whoami" });
    // Modes still win, and a long "talk to me about ..." is a request.
    expect(r("switch to conversation mode")).toEqual({ kind: "mode", mode: "conversational" });
    expect(r("talk to me about the VAT return due this month please")).toMatchObject({ kind: "chat" });
  });

  it("resolves titles, aliases and business + role, and refuses to guess", () => {
    expect(who("shop lead")).toBe("dms/shop-lead");
    expect(who("chief of staff")).toBe("personal/chief-of-staff");
    expect(who("the COS")).toBe("personal/chief-of-staff");
    expect(who("catalogue and pricing")).toBe("dms/catalogue-pricing");
    expect(who("ops")).toBe("dms/ops-admin");
    expect(who("machine shop customer support")).toBe("dms/customer-support");
    expect(who("open d support")).toBe("opend/support-engineer");
    expect(who("support engineer for openv")).toBe("openv/support-engineer");
    expect(who("support")).toEqual(["dms/customer-support", "openv/support-engineer", "opend/support-engineer"]);
    expect(who("anyone")).toBe("auto");
    expect(who("automatic")).toBe("auto");
    expect(who("the plumber")).toBe("unknown");
  });

  it("sends a one-off request to a named role, with a separator or ask/tell", () => {
    expect(r("Ask the shop lead whether order 1042 has shipped")).toEqual({ kind: "chat", text: "Order 1042 has shipped", vertical: "dms", role: "shop-lead" });
    expect(r("customer support: chase the Royal Mail claim")).toEqual({ kind: "chat", text: "Chase the Royal Mail claim", vertical: "dms", role: "customer-support" });
    expect(r("Chief of staff, what's on my plate today")).toEqual({ kind: "chat", text: "What's on my plate today", vertical: "personal", role: "chief-of-staff" });
    expect(r("tell open d support to close ticket 12")).toEqual({ kind: "chat", text: "Close ticket 12", vertical: "opend", role: "support-engineer" });
    // A business prefix still means the business; plain speech that starts with a role word is just a request.
    expect(r("shop: what sold yesterday")).toEqual({ kind: "chat", text: "What sold yesterday", vertical: "dms" });
    expect(r("ops is the best part of the job")).toEqual({ kind: "chat", text: "ops is the best part of the job" });
    // A shared name isn't guessed.
    expect(r("support: any new tickets")).toEqual({ kind: "chat", text: "support: any new tickets" });
  });

  it("says who it is", () => {
    const res = resolveRole("shop lead", book);
    expect(res.kind === "role" && describeRole(res.choice)).toBe("the Shop Lead at Desktop Machine Shop");
    const cos = resolveRole("chief", book);
    expect(cos.kind === "role" && describeRole(cos.choice)).toBe("the Chief of Staff");
  });
});
