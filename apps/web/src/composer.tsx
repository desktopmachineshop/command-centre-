import { type FormEvent, type ReactNode, useRef } from "react";
import type { Api } from "./api";
import { Icon } from "./icons";
import { ErrorBanner } from "./ui";
import { joinDictation, useDictation } from "./voice/dictation";

/**
 * The message box shared by the Chat page and a task's "Reply to the agent": a text box,
 * the dictation mic and Send. Enter sends, Shift+Enter is a new line. The mic dictates
 * into the box (nothing is sent by itself); Send while dictating finishes listening, then
 * sends everything said. The mic is hidden where the device can't listen.
 */
export function Composer({
  api,
  value,
  onChange,
  onSend,
  label,
  placeholder,
  busy = false,
  className = "",
  children,
}: {
  api: Pick<Api, "voiceConfig" | "transcribe">;
  value: string;
  onChange: (text: string) => void;
  /** Called with the trimmed text; the caller clears the box (or keeps it on failure). */
  onSend: (text: string) => void | Promise<void>;
  /** The text box's accessible name. */
  label: string;
  placeholder: string;
  busy?: boolean;
  className?: string;
  /** Controls before the mic, e.g. the chat's "Send to" picker. */
  children?: ReactNode;
}) {
  const dictation = useDictation(api);
  // What was typed before dictation started, and a send waiting for it to finish.
  const typedBefore = useRef("");
  const sendWhenDone = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);

  const toggleMic = () => {
    if (dictation.listening) return dictation.stop();
    typedBefore.current = value;
    void dictation.start((spoken, final) => {
      onChange(joinDictation(typedBefore.current, spoken));
      if (final && sendWhenDone.current) {
        sendWhenDone.current = false;
        // Let the final words reach the box before the form reads it.
        setTimeout(() => formRef.current?.requestSubmit(), 0);
      }
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (dictation.listening) {
      sendWhenDone.current = true;
      dictation.stop();
      return;
    }
    const text = value.trim();
    if (text && !busy) void onSend(text);
  };

  return (
    <>
      {dictation.error && <ErrorBanner>{dictation.error}</ErrorBanner>}
      <form ref={formRef} className={`composer ${dictation.available ? "has-mic" : ""} ${className}`.trim()} onSubmit={submit}>
        {children}
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={dictation.listening ? "Listening… press the mic again when you're done" : placeholder}
          aria-label={label}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {dictation.available && (
          <button
            type="button"
            className={`mic ${dictation.listening ? "is-listening" : ""}`}
            onClick={toggleMic}
            aria-pressed={dictation.listening}
            data-help-key="chat.dictate"
            aria-label={dictation.listening ? "Stop dictating" : "Dictate"}
            title={dictation.listening ? "Stop dictating" : "Dictate: talk instead of typing"}
          >
            <Icon name={dictation.listening ? "stop" : "mic"} size={16} />
          </button>
        )}
        <button className="primary send" aria-label="Send" disabled={busy}>
          <Icon name="send" size={16} />
          {busy ? "Sending…" : "Send"}
        </button>
      </form>
    </>
  );
}
