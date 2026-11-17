import type { AgentMessage } from "@cc/core";
import { stepsSummary, toolLabel, withoutVoiceLine } from "../format";
import { Markdown } from "../markdown";
import { PlayReply, type useReadAloud } from "../voice/readAloud";

/** The line a runner logs when its session starts: bookkeeping. */
const SESSION_LINE = /^session \S+ (started|resumed)/i;
/**
 * The line the server puts at the start of a run that answers a reply (voice/conversations.ts):
 * Dave's own words, or a report from a role the task handed work to. The thread shows these as
 * their own bubbles (`runOpener`), so the transcript leaves them out.
 */
const OPENER = /^(Dave replied|.{1,80}? reported back|.{1,80}? sent a follow-up): ([\s\S]*)$/;

/** Who opened a run, and with what: Dave's reply, or a role reporting back or following up. */
export function runOpener(messages: AgentMessage[]): { from: "dave" | "role"; author: string; kind: "reply" | "report" | "followup"; text: string } | null {
  const first = messages.find((m) => !(m.type === "system" && SESSION_LINE.test(m.text)));
  if (first?.type !== "system") return null;
  const m = OPENER.exec(first.text);
  if (!m) return null;
  if (m[1] === "Dave replied") return { from: "dave", author: "Dave", kind: "reply", text: m[2]!.replace(/ \[attached: [^\]]*\]$/, "") };
  const report = m[1]!.endsWith(" reported back");
  return { from: "role", author: m[1]!.replace(/ (reported back|sent a follow-up)$/, ""), kind: report ? "report" : "followup", text: m[2]! };
}

const isCall = (m: AgentMessage) => m.type === "tool_use" || m.type === "tool_result";
const said = (m: AgentMessage) => m.type === "text" && !!withoutVoiceLine(m.text);

/**
 * Splits an agent's messages into what it did (`trace`: every tool call and result, the notes it
 * made along the way, bookkeeping lines) and what it said to Dave (`answer`).
 *
 * The answer is what comes after its last tool call. A finished run that ended on a tool call
 * (it saved its notes last) answers with the last thing it said. While it is still working,
 * what it has said since its last call is shown as it arrives.
 */
export function splitTranscript(messages: AgentMessage[], working = false): { trace: AgentMessage[]; answer: AgentMessage[] } {
  const all = messages.filter((m) => (m.type === "text" ? said(m) : !(m.type === "system" && OPENER.test(m.text))));
  const lastCall = all.findLastIndex(isCall);
  if (lastCall < 0) {
    // No tools at all: everything it said is the answer; a lone session line isn't worth a row.
    return { trace: [], answer: all.filter((m) => !(m.type === "system" && SESSION_LINE.test(m.text))) };
  }
  let trace = all.slice(0, lastCall + 1);
  let answer = all.slice(lastCall + 1);
  if (!working && !answer.some(said)) {
    const lastSaid = trace.findLastIndex(said);
    if (lastSaid >= 0) {
      answer = [trace[lastSaid]!, ...answer];
      trace = trace.filter((_, i) => i !== lastSaid);
    }
  }
  return { trace, answer };
}

/**
 * An agent's messages, as Dave wants to read them: one line for everything it did (which says what
 * it is doing while it works, and afterwards how many steps it took), then what it said. The line
 * opens to every call, result and note, in order; it starts folded. `readAloud` (optional) adds a
 * play button to each reply; `id` keeps those buttons apart across transcripts.
 */
export function Transcript({ messages, readAloud, id = "", working = false }: { messages: AgentMessage[]; readAloud?: ReturnType<typeof useReadAloud>; id?: string; working?: boolean }) {
  const { trace, answer } = splitTranscript(messages, working);
  const hasCalls = trace.some(isCall);
  return (
    <div className={`transcript ${working ? "is-working" : ""}`}>
      {hasCalls && (
        <details className={`steps ${working ? "is-working" : ""}`}>
          <summary>{stepsSummary(trace, working && !answer.some(said))}</summary>
          <div className="steps-body">
            {trace.map((m, i) => (
              <Step key={i} message={m} />
            ))}
          </div>
        </details>
      )}
      {!hasCalls && working && answer.length === 0 && messages.length > 0 && <p className="msg system muted small working-line">Working on it…</p>}
      {answer.map((m, i) => {
        if (m.type !== "text") return <Step key={i} message={m} />;
        const text = withoutVoiceLine(m.text);
        return readAloud ? (
          <div key={i} className="msg-with-play">
            <Markdown className="msg text" text={text} />
            <PlayReply readAloud={readAloud} id={`${id}:${i}`} text={m.text} />
          </div>
        ) : (
          <Markdown key={i} className="msg text" text={text} />
        );
      })}
    </div>
  );
}

function Step({ message: m }: { message: AgentMessage }) {
  switch (m.type) {
    case "tool_use":
      return (
        <details className="msg tool">
          <summary title={m.name}>→ {toolLabel(m.name)}</summary>
          <pre>{JSON.stringify(m.input, null, 2)}</pre>
        </details>
      );
    case "tool_result":
      return (
        <details className={`msg tool ${m.isError ? "err" : ""}`}>
          <summary title={m.name}>← {m.isError ? "Problem: " : ""}{m.name ? toolLabel(m.name) : "result"}</summary>
          <pre>{typeof m.output === "string" ? m.output : JSON.stringify(m.output, null, 2)}</pre>
        </details>
      );
    case "text":
      return <Markdown className="msg text note" text={withoutVoiceLine(m.text)} />;
    default:
      return <p className="msg system muted small">{m.text}</p>;
  }
}
