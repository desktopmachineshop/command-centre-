import type { AgentMessage } from "@cc/core";
import { Markdown } from "../markdown";

export function Transcript({ messages }: { messages: AgentMessage[] }) {
  return (
    <div className="transcript">
      {messages.map((m, i) => {
        switch (m.type) {
          case "text":
            return <Markdown key={i} className="msg text" text={m.text} />;
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
