import { speakable } from "./speakable";

/**
 * Structured spoken answer of a voice-mode run.
 * - `converse`: the agent asked Dave something and waits for his answer;
 * - `final`: the agent is done.
 */
export type VoiceResponseType = "converse" | "final";

export interface VoiceResponse {
  text: string;
  type: VoiceResponseType;
  /** False when the agent didn't use the protocol and the text was derived from its answer. */
  structured: boolean;
}

/** The single line a voice-mode agent ends its final message with (see `voiceResponseInstructions`). */
export function voiceResponseLine(text: string, type: VoiceResponseType): string {
  return JSON.stringify({ voice: { type, text } });
}

/**
 * Finds the agent's `{"voice":{"type","text"}}` line, searching from the end
 * (code fences around it are tolerated). Without one, the whole answer becomes
 * a `final` response, made speakable. Null for an empty result.
 */
export function parseVoiceResponse(result: string | null | undefined): VoiceResponse | null {
  if (!result?.trim()) return null;
  const lines = result.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim().replace(/^`+|`+$/g, "").replace(/^json\s*/i, "");
    if (!line.startsWith("{") || !line.includes('"voice"')) continue;
    try {
      const v = (JSON.parse(line) as { voice?: { type?: unknown; text?: unknown } }).voice;
      if (v && (v.type === "converse" || v.type === "final") && typeof v.text === "string" && v.text.trim()) {
        return { text: speakable(v.text), type: v.type, structured: true };
      }
    } catch {
      // not the protocol line
    }
  }
  const text = speakable(result);
  return text ? { text, type: "final", structured: false } : null;
}

/** Prompt rules for voice mode, appended to the task prompt. */
export const voiceResponseInstructions = [
  "VOICE MODE: Dave is driving and will hear your answer read aloud, not see it.",
  "- Answer in one to three short spoken sentences. No markdown, lists, tables, code, emoji or URLs.",
  "- Say numbers, money, dates and times naturally (\"three pm\", \"forty-two pounds\", \"order ten forty-two\").",
  "- Don't read out long content (emails, documents); summarise and say it's ready on screen.",
  "- If you need an answer from Dave before you can continue, ask one short question and stop; otherwise finish the job.",
  "- End your final message with exactly one line of JSON, on its own line, and nothing after it:",
  `  ${voiceResponseLine("<what Dave should hear>", "final")}`,
  "  Use \"type\": \"converse\" instead of \"final\" when that text asks Dave a question and you are waiting for his reply.",
].join("\n");
