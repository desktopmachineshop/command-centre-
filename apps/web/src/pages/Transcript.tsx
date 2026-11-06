import type { AgentMessage } from "@cc/core";
import { withoutVoiceLine } from "../format";
import { Markdown } from "../markdown";
import { PlayReply, type useReadAloud } from "../voice/readAloud";

/** `readAloud` (optional) adds a play button to each text reply; `id` keeps those buttons apart across transcripts. */
export function Transcript({ messages, readAloud, id = "" }: { messages: AgentMessage[]; readAloud?: ReturnType<typeof useReadAloud>; id?: string }) {
  return (
    <div className="transcript">
      {messages.map((m, i) => {
        switch (m.type) {
          case "text": {
            const text = withoutVoiceLine(m.text);
            if (!text) return null;
            return readAloud ? (
              <div key={i} className="msg-with-play">
                <Markdown className="msg text" text={text} />
                <PlayReply readAloud={readAloud} id={`${id}:${i}`} text={m.text} />
              </div>
            ) : (
              <Markdown key={i} className="msg text" text={text} />
            );
          }
          case "tool_use":
            return (
              <details key={i} className="msg tool">
                <summary>→ {m.name}</summary>
                <pre>{JSON.stringify(m.input, null, 2)}</pre>
              </details>
            );
          case "tool_result":
            return (
              <details key={i} className={`msg tool ${m.isError ? "err" : ""}`}>
                <summary>← {m.name ?? "result"}</summary>
                <pre>{typeof m.output === "string" ? m.output : JSON.stringify(m.output, null, 2)}</pre>
              </details>
            );
          default:
            return <p key={i} className="msg system muted small">{m.text}</p>;
        }
      })}
    </div>
  );
}
