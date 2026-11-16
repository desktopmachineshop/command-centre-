import type { AgentMessage } from "@cc/core";
import { stepsSummary, toolLabel, withoutVoiceLine } from "../format";
import { Markdown } from "../markdown";
import { PlayReply, type useReadAloud } from "../voice/readAloud";

type Part = { kind: "message"; index: number; message: AgentMessage } | { kind: "steps"; index: number; steps: AgentMessage[] };

/** The line a runner logs when its session starts: bookkeeping, kept with the steps. */
const SESSION_LINE = /^session \S+ (started|resumed)/i;
const isStep = (m: AgentMessage) => m.type === "tool_use" || m.type === "tool_result" || (m.type === "system" && SESSION_LINE.test(m.text));

/** Runs of tool calls (and their results) become one part, so an answer isn't buried under them. */
export function transcriptParts(messages: AgentMessage[]): Part[] {
  const parts: Part[] = [];
  messages.forEach((message, index) => {
    const last = parts[parts.length - 1];
    if (isStep(message)) {
      if (last?.kind === "steps") last.steps.push(message);
      else parts.push({ kind: "steps", index, steps: [message] });
    } else if (message.type !== "text" || withoutVoiceLine(message.text)) {
      parts.push({ kind: "message", index, message });
    }
  });
  // A session line on its own says nothing worth a row.
  return parts.filter((p) => p.kind !== "steps" || p.steps.some((m) => m.type !== "system"));
}

/**
 * An agent's messages. What it said is shown in full; what it did (each run of tool calls) is
 * folded into one line that opens to the calls and their results. `working`: the run is still
 * going, so the last run of steps says what it is doing now. `readAloud` (optional) adds a play
 * button to each text reply; `id` keeps those buttons apart across transcripts.
 */
export function Transcript({ messages, readAloud, id = "", working = false }: { messages: AgentMessage[]; readAloud?: ReturnType<typeof useReadAloud>; id?: string; working?: boolean }) {
  const parts = transcriptParts(messages);
  return (
    <div className="transcript">
      {parts.map((part, n) => {
        if (part.kind === "steps") {
          const now = working && n === parts.length - 1;
          return (
            <details key={part.index} className={`steps ${now ? "is-working" : ""} ${part.steps.some((m) => m.type === "tool_result" && m.isError) ? "has-error" : ""}`}>
              <summary>{stepsSummary(part.steps, now)}</summary>
              <div className="steps-body">
                {part.steps.map((m, i) => (
                  <Step key={i} message={m} />
                ))}
              </div>
            </details>
          );
        }
        const m = part.message;
        const i = part.index;
        if (m.type === "text") {
          const text = withoutVoiceLine(m.text);
          return readAloud ? (
            <div key={i} className="msg-with-play">
              <Markdown className="msg text" text={text} />
              <PlayReply readAloud={readAloud} id={`${id}:${i}`} text={m.text} />
            </div>
          ) : (
            <Markdown key={i} className="msg text" text={text} />
          );
        }
        return <Step key={i} message={m} />;
      })}
      {working && parts.length > 0 && parts[parts.length - 1]!.kind !== "steps" && <p className="msg system muted small working-line">Still working…</p>}
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
      return null;
    default:
      return <p className="msg system muted small">{m.text}</p>;
  }
}
