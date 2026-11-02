/**
 * Drive-mode voice commands, parsed locally before anything goes to the agent.
 * Pure: no DOM, no state. Commands only match a whole (short) utterance, so
 * "approve the quote for Jane" is a request for the agent, never an approval.
 */

export type VoiceMode = "push" | "conversational";

export type Command =
  | { kind: "briefing" }
  | { kind: "approvals" }
  | { kind: "next" }
  | { kind: "approve" }
  | { kind: "reject" }
  /** "yes, approve" / "yes, reject": confirms a pending approve or reject, and only that one. */
  | { kind: "confirm"; action: "approve" | "reject" }
  | { kind: "deny" }
  | { kind: "repeat" }
  | { kind: "stop" }
  | { kind: "cancel" }
  /** "that's all", "goodbye": ends the conversation. */
  | { kind: "end" }
  | { kind: "mode"; mode: VoiceMode }
  /** "talk to the shop lead": who new requests go to from now on (resolve `target` with `resolveRole`). */
  | { kind: "talkTo"; target: string }
  /** "who am I talking to?" */
  | { kind: "whoami" }
  /** A request for the agent; `role` (with its `vertical`) when a role was named, e.g. "ask customer support whether ...". */
  | { kind: "chat"; text: string; vertical?: string; role?: string };

export type Aliases = { vertical: string; alias: string; /** Safe to match without a ":" or "," after it. */ bare: boolean }[];

/** Extra spoken names per vertical; ids and names from the server are added by `buildAliases`. */
const EXTRA: Record<string, { alias: string; bare: boolean }[]> = {
  dms: [
    { alias: "d m s", bare: true },
    { alias: "machine shop", bare: true },
    { alias: "the shop", bare: false },
    { alias: "shop", bare: false },
  ],
  "3dpandme": [
    { alias: "3d pandme", bare: true },
    { alias: "3d p and me", bare: true },
    { alias: "3dp and me", bare: true },
    { alias: "3 d p and me", bare: true },
    { alias: "three d p and me", bare: true },
    { alias: "3d and me", bare: true },
  ],
  openv: [{ alias: "open v", bare: true }],
  opend: [{ alias: "open d", bare: true }],
  personal: [{ alias: "personal", bare: false }],
};

export function buildAliases(verticals: { id: string; name: string }[]): Aliases {
  const out: Aliases = [];
  const ids = new Set(verticals.map((v) => v.id));
  for (const id of Object.keys(EXTRA)) ids.add(id);
  for (const id of ids) {
    const v = verticals.find((x) => x.id === id);
    out.push({ vertical: id, alias: normalise(id), bare: id !== "personal" });
    if (v && normalise(v.name) !== normalise(id)) out.push({ vertical: id, alias: normalise(v.name), bare: true });
    for (const e of EXTRA[id] ?? []) out.push({ vertical: id, ...e });
  }
  // Longest first, so "machine shop" wins over "shop".
  return out.sort((a, b) => b.alias.length - a.alias.length);
}

/** Lower case, apostrophes dropped, punctuation (other than ":" and ",") turned to spaces. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}:,\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const FILLER = /^(?:(?:ok(?:ay)?|hey|please|so|um+|uh+|right|command(?: centre| center)?)[\s,]+)+|(?:[\s,]+(?:please|thanks|thank you|now))+$/g;

const PHRASES: [RegExp, Command][] = [
  [/^(?:whats new|what is new|whats up|briefing|brief me|give me (?:a|the|my) briefing|(?:my |the )?briefing please|any news|update me|catch me up)$/, { kind: "briefing" }],
  [/^(?:(?:read|list|check|go through)(?: my| the| out)?(?: pending)? approvals?|whats waiting(?: for (?:me|approval))?|what needs (?:my )?approval|approvals|any approvals)$/, { kind: "approvals" }],
  [/^(?:next|next one|skip|skip it|skip this(?: one)?|next approval)$/, { kind: "next" }],
  [/^(?:yes,? ?approve(?: it)?|yes,? i approve|confirm approve|confirm,? approve|approve confirmed)$/, { kind: "confirm", action: "approve" }],
  [/^(?:yes,? ?reject(?: it)?|yes,? i reject|confirm reject|confirm,? reject|reject confirmed)$/, { kind: "confirm", action: "reject" }],
  [/^(?:approve|approve it|approve this(?: one)?|approve that(?: one)?|approved)$/, { kind: "approve" }],
  [/^(?:reject|reject it|reject this(?: one)?|reject that(?: one)?|rejected|decline|decline it)$/, { kind: "reject" }],
  [/^(?:no|nope|no thanks|dont|do not|not yet|leave it)$/, { kind: "deny" }],
  [/^(?:repeat|repeat that|say (?:that|it) again|again|what did you say|pardon|come again)$/, { kind: "repeat" }],
  [/^(?:stop|stop talking|quiet|shut up|be quiet|pause)$/, { kind: "stop" }],
  [/^(?:cancel|cancel that|never mind|nevermind|forget it|abort)$/, { kind: "cancel" }],
  [/^(?:thats all|that is all|thats it|that will do|thatll do|im done|all done|goodbye|bye|end conversation|end)$/, { kind: "end" }],
  [/^(?:conversation(?:al)? mode|switch to conversation(?:al)? mode|hands free(?: mode)?)$/, { kind: "mode", mode: "conversational" }],
  [/^(?:push to talk(?: mode)?|switch to push to talk(?: mode)?)$/, { kind: "mode", mode: "push" }],
  [/^(?:who am i (?:talking|speaking) (?:to|with)|whos this|who is this|who are you|whos listening|who am i with)$/, { kind: "whoami" }],
];

/** "talk to X", "put me through to X", "switch to X"; X is resolved against the org by `resolveRole`. */
const TALK_TO = /^(?:(?:can i |could i |i want to |id like to |let me )?(?:talk|speak) (?:to|with)|switch to|put me through to|connect me (?:to|with)|transfer me to|get me|back to) (?:the |my )?(.+)$/;

/** Parses one utterance. Anything that isn't a command is a chat request (with its business, when named first). */
export function parseCommand(utterance: string, aliases: Aliases = buildAliases([]), roles: RoleBook = []): Command | null {
  const text = normalise(utterance);
  if (!text) return null;
  const bare = text.replace(FILLER, "").replace(/[:,]/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, cmd] of PHRASES) if (re.test(bare)) return cmd;
  // A short "talk to ..." switches who you're talking to; a long one ("talk to me about the VAT return") is a request.
  const talk = bare.match(TALK_TO);
  if (talk && talk[1]!.split(" ").length <= 6) return { kind: "talkTo", target: talk[1]! };
  return chatCommand(utterance, text, aliases, roles);
}

function chatCommand(original: string, text: string, aliases: Aliases, roles: RoleBook): Command {
  // A role named first: "customer support: ...", "ask the shop lead whether ...", "tell open d support to ...".
  // Only with a separator or "ask"/"tell"; a name that is also a business's ("shop") means the business.
  const businessNames = new Set(aliases.map((a) => a.alias));
  for (const { name, choice } of roleNames(roles)) {
    if (businessNames.has(name)) continue;
    const re = new RegExp(`^(?:(ask|tell)\\s+)?(?:the\\s+)?${escape(name)}(\\s*[:,]|\\s+colon\\b|\\s+(?=\\S))\\s*(.+)$`);
    const m = text.match(re);
    if (!m) continue;
    if (!m[1] && !/[:,]|colon/.test(m[2]!)) continue;
    if (!choice) return { kind: "chat", text: original.trim() }; // a name several roles share: let the server decide
    const rest = stripLead(original, m[3]!);
    if (rest) return { kind: "chat", text: rest, vertical: choice.vertical, role: choice.role };
  }
  for (const a of aliases) {
    // "dms: has order 1042 shipped", "shop, ...", "ask dms whether ...", "for 3dpandme: ...", "dms colon ..."
    const re = new RegExp(`^(?:(?:ask|tell|for|to|on)\\s+)?${escape(a.alias)}(\\s*[:,]|\\s+colon\\b|\\s+(?=\\S))\\s*(.+)$`);
    const m = text.match(re);
    if (!m) continue;
    const separated = /[:,]|colon/.test(m[1]!);
    if (!separated && !a.bare) continue;
    const rest = stripLead(original, m[2]!);
    if (rest) return { kind: "chat", text: rest, vertical: a.vertical };
  }
  return { kind: "chat", text: original.trim() };
}

/** The original wording (case, punctuation, numbers) of the request after its prefix. */
function stripLead(original: string, normalisedRest: string): string {
  const words = normalisedRest.split(" ").length;
  const originalWords = original.trim().split(/\s+/);
  const kept = originalWords.slice(Math.max(0, originalWords.length - words)).join(" ");
  const cleaned = kept.replace(/^(?:whether|if|to)\s+/i, "").replace(/^[:,\s]+/, "").trim();
  return cleaned ? cleaned[0]!.toUpperCase() + cleaned.slice(1) : "";
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
}

// ---------- Roles: who you're talking to ----------

/** One role you can talk to, from the org chart. */
export interface RoleChoice {
  vertical: string;
  role: string;
  title: string;
  /** The business's name, e.g. "Desktop Machine Shop" ("" for the Chief of Staff). */
  business: string;
}

/** Every role with the names it answers to (normalised), Chief of Staff first. */
export type RoleBook = { choice: RoleChoice; names: string[] }[];

interface OrgRole {
  id: string;
  title: string;
  vertical: string;
  aliases: string[];
  children: OrgRole[];
}

/** The roles of the org chart (`GET /api/org`), with spoken names: title, aliases, id, and each with its business in front. */
export function buildRoleBook(org: { root: OrgRole & { verticals: { id: string; name: string; lead: OrgRole }[] } }, aliases: Aliases): RoleBook {
  const book: RoleBook = [];
  // "Catalogue & Pricing" is said "catalogue and pricing" (or without the "and").
  const nameSet = (r: OrgRole) =>
    [...new Set([r.title, r.title.replace(/&/g, " and "), r.id.replace(/[-_]+/g, " "), ...r.aliases].map(normalise).filter(Boolean))];
  const root = org.root;
  book.push({ choice: { vertical: root.vertical, role: root.id, title: root.title, business: "" }, names: [...new Set([...nameSet(root), "chief", "cos"])] });
  for (const v of root.verticals) {
    const walk = (r: OrgRole) => {
      const own = nameSet(r);
      const businesses = aliases.filter((a) => a.vertical === v.id).map((a) => a.alias);
      const combined = businesses.flatMap((b) => own.map((n) => `${b} ${n}`));
      book.push({ choice: { vertical: v.id, role: r.id, title: r.title, business: v.name }, names: [...new Set([...own, ...combined])] });
      r.children.forEach(walk);
    };
    walk(v.lead);
  }
  return book;
}

/** Every spoken name, longest first; `choice` is null when several roles share it. */
function roleNames(book: RoleBook): { name: string; choice: RoleChoice | null }[] {
  const byName = new Map<string, RoleChoice[]>();
  for (const { choice, names } of book) {
    for (const n of names) {
      const list = byName.get(n) ?? [];
      if (!list.some((c) => c.vertical === choice.vertical && c.role === choice.role)) list.push(choice);
      byName.set(n, list);
    }
  }
  return [...byName]
    .map(([name, list]) => ({ name, choice: list.length === 1 ? list[0]! : null }))
    .sort((a, b) => b.name.length - a.name.length);
}

const AUTO = /^(?:anyone|anybody|automatic|auto|whoever|whoevers best|the right (?:person|role)|nobody in particular|no one in particular|default|everyone)$/;

export type RoleResolution =
  | { kind: "role"; choice: RoleChoice }
  /** Back to automatic: each request goes to whichever role fits it. */
  | { kind: "auto" }
  | { kind: "ambiguous"; options: RoleChoice[] }
  | { kind: "unknown" };

/**
 * Who "talk to <target>" means: a title or alias ("customer support", "ops"), with its business
 * in front or after ("shop customer support", "support for open v"), or "anyone" for automatic.
 */
export function resolveRole(target: string, book: RoleBook): RoleResolution {
  const t = normalise(target)
    .replace(/[:,]/g, " ")
    .replace(/^(?:the|my|our)\s+/, "")
    .replace(/\s+(?:please|now|instead)$/, "")
    .trim();
  if (AUTO.test(t)) return { kind: "auto" };
  const exact = book.filter((r) => r.names.includes(t)).map((r) => r.choice);
  if (exact.length === 1) return { kind: "role", choice: exact[0]! };
  if (exact.length > 1) return { kind: "ambiguous", options: exact };
  // "support for open v", "the lead at the shop"
  const split = t.match(/^(.+?)\s+(?:for|at|in|of|from|on)\s+(?:the\s+)?(.+)$/);
  if (split) {
    const [, rolePart, businessPart] = split;
    const matches = book.filter((r) => r.choice.business && r.names.includes(rolePart!) && r.names.some((n) => n === `${businessPart} ${rolePart}`)).map((r) => r.choice);
    if (matches.length === 1) return { kind: "role", choice: matches[0]! };
  }
  return { kind: "unknown" };
}

/** How the role is said aloud: "the Chief of Staff", "the Shop Lead at Desktop Machine Shop". */
export function describeRole(choice: RoleChoice): string {
  return choice.business ? `the ${choice.title} at ${choice.business}` : `the ${choice.title}`;
}
