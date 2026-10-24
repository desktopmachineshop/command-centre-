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
  | { kind: "chat"; text: string; vertical?: string };

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
];

/** Parses one utterance. Anything that isn't a command is a chat request (with its business, when named first). */
export function parseCommand(utterance: string, aliases: Aliases = buildAliases([])): Command | null {
  const text = normalise(utterance);
  if (!text) return null;
  const bare = text.replace(FILLER, "").replace(/[:,]/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, cmd] of PHRASES) if (re.test(bare)) return cmd;
  return chatCommand(utterance, text, aliases);
}

function chatCommand(original: string, text: string, aliases: Aliases): Command {
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
