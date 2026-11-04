import {
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Api, ChatFile } from "./api";
import { formatBytes } from "./format";
import { Icon } from "./icons";
import { ErrorBanner } from "./ui";
import { joinDictation, useDictation } from "./voice/dictation";
import { Waveform } from "./voice/Waveform";

/**
 * The message box shared by the Chat page and a task's "Reply to the agent": a text box,
 * the dictation mic and Send. Enter sends, Shift+Enter is a new line. The mic dictates
 * into the box (nothing is sent by itself): while it listens, a live waveform follows the
 * voice and the words appear as they're said; ✓ keeps them, ✕ throws them away. Send while
 * dictating finishes listening, then sends everything said. The mic is hidden where the
 * device can't listen.
 *
 * Files: the paperclip picks them, and pasting (a screenshot, a file copied in the file manager)
 * or dropping them on the box attaches them too. Each uploads straight away and shows as a chip
 * above the text; Send waits for the uploads and passes the files with the text. Without
 * `api.uploadChatFile` there is no paperclip and pasted files are ignored.
 */

/** Most files on one message (the server's limit). */
export const MAX_FILES = 10;

type Attachment = {
  key: number;
  name: string;
  size: number;
  state: "uploading" | "ready" | "failed";
  file?: ChatFile;
  error?: string;
  abort: AbortController;
};

/** Files a paste or drop carries; a paste of plain text has none. */
export function filesOf(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = [...(data.files ?? [])];
  if (files.length) return files;
  // Some browsers only list a pasted image under items.
  return [...(data.items ?? [])]
    .filter((i) => i.kind === "file")
    .map((i) => i.getAsFile())
    .filter((f): f is File => !!f);
}

/** A name for a pasted image, which arrives as "image.png" (or with no name at all). */
function named(file: File): File {
  if (file.name && file.name !== "image.png") return file;
  const ext =
    /^image\/(\w+)/.exec(file.type)?.[1]?.replace("jpeg", "jpg") ?? "bin";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
  return new File([file], `pasted-${stamp}.${ext}`, { type: file.type });
}
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
  panel,
}: {
  api: Pick<Api, "voiceConfig" | "transcribe" | "voiceListenUrl" | "token"> &
    Partial<Pick<Api, "uploadChatFile">>;
  value: string;
  onChange: (text: string) => void;
  /**
   * Called with the trimmed text and the uploaded files; the caller clears the box (or keeps it
   * on failure). Resolving to false (failed) keeps the attachments too.
   */
  onSend: (
    text: string,
    files: ChatFile[],
  ) => void | boolean | Promise<void | boolean>;
  /** The text box's accessible name. */
  label: string;
  placeholder: string;
  busy?: boolean;
  className?: string;
  /** Controls before the mic, e.g. the chat's "Send to" picker. */
  children?: ReactNode;
  /**
   * Shown under the text box, growing into the space (Drive mode in the chat). While it's there
   * the mic and the paperclip are off; everything else stays where it is.
   */
  panel?: ReactNode;
}) {
  const dictation = useDictation(api);
  // What was typed before dictation started, and a send waiting for it to finish.
  const typedBefore = useRef("");
  const sendWhenDone = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const pickRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const nextKey = useRef(0);
  const upload = api.uploadChatFile;
  const live = useRef(attachments);
  live.current = attachments;
  // Uploads still running when the box goes away are abandoned.
  useEffect(
    () => () =>
      live.current.forEach((a) => a.state === "uploading" && a.abort.abort()),
    [],
  );

  const update = (key: number, patch: Partial<Attachment>) =>
    setAttachments((as) =>
      as.map((a) => (a.key === key ? { ...a, ...patch } : a)),
    );
  const attach = (files: File[]) => {
    if (!upload || !files.length) return;
    setFileError(null);
    const room = MAX_FILES - live.current.length;
    if (files.length > room)
      setFileError(`Up to ${MAX_FILES} files per message.`);
    for (const raw of files.slice(0, Math.max(0, room))) {
      const file = named(raw);
      const a: Attachment = {
        key: nextKey.current++,
        name: file.name,
        size: file.size,
        state: "uploading",
        abort: new AbortController(),
      };
      setAttachments((as) => [...as, a]);
      upload(file, a.abort.signal).then(
        (uploaded) => update(a.key, { state: "ready", file: uploaded }),
        (err: Error) =>
          !a.abort.signal.aborted &&
          update(a.key, { state: "failed", error: err.message }),
      );
    }
  };
  const remove = (a: Attachment) => {
    a.abort.abort();
    setAttachments((as) => as.filter((x) => x.key !== a.key));
  };
  const uploading = attachments.some((a) => a.state === "uploading");
  const ready = attachments.filter((a) => a.state === "ready" && a.file);

  const onPaste = (e: ClipboardEvent) => {
    const files = filesOf(e.clipboardData);
    if (!upload || !files.length) return; // plain text pastes as usual
    e.preventDefault();
    attach(files);
  };
  const dropProps = upload
    ? {
        onDragOver: (e: DragEvent) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        },
        onDragLeave: (e: DragEvent) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          setDragging(false);
          const files = filesOf(e.dataTransfer);
          if (!files.length) return;
          e.preventDefault();
          attach(files);
        },
      }
    : {};

  const elapsed = useElapsed(dictation.listening);

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
    if (busy) return;
    if (uploading)
      return setFileError("Wait for the files to finish uploading, then send.");
    if (attachments.some((a) => a.state === "failed"))
      return setFileError(
        "Remove the files that didn't upload (or attach them again), then send.",
      );
    const files = ready.map((a) => a.file!);
    const text =
      value.trim() ||
      (files.length
        ? `Have a look at the attached file${files.length === 1 ? "" : "s"}.`
        : "");
    if (!text) return;
    setFileError(null);
    void Promise.resolve(onSend(text, files)).then((ok) => {
      if (ok !== false && files.length)
        setAttachments((as) =>
          as.filter((a) => !a.file || !files.includes(a.file)),
        );
    });
  };
  const classes = [
    "composer",
    dictation.available ? "has-mic" : "",
    dictation.listening ? "is-recording" : "",
    upload ? "has-attach" : "",
    attachments.length ? "has-files" : "",
    dragging ? "is-dragging" : "",
    className,
  ];

  const textBox = (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={dictation.listening ? "Listening…" : placeholder}
      aria-label={label}
      rows={panel ? 1 : 2}
      onPaste={onPaste}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.form?.requestSubmit();
        }
      }}
    />
  );

  return (
    <>
      {dictation.error && <ErrorBanner>{dictation.error}</ErrorBanner>}
      {fileError && <ErrorBanner>{fileError}</ErrorBanner>}
      <form
        ref={formRef}
        className={classes.filter(Boolean).join(" ")}
        onSubmit={submit}
        {...dropProps}
      >
        {attachments.length > 0 && (
          <ul className="composer-files" aria-label="Attached files">
            {attachments.map((a) => (
              <li
                key={a.key}
                className={`file-chip is-${a.state}`}
                title={a.error ?? a.name}
              >
                <Icon
                  name={a.state === "failed" ? "alert" : "file"}
                  size={14}
                />
                <span className="file-name">{a.name}</span>
                <span className="file-size small muted">
                  {a.state === "uploading"
                    ? "uploading…"
                    : a.state === "failed"
                      ? "didn't upload"
                      : formatBytes(a.size)}
                </span>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => remove(a)}
                  aria-label={`Remove ${a.name}`}
                >
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {children}
        {panel ? (
          // Drive mode: the text box stays where it is, and the panel grows beneath it.
          <div className="composer-main">
            {textBox}
            <div className="composer-panel">{panel}</div>
          </div>
        ) : (
          textBox
        )}
        {upload && (
          <>
            <input
              ref={pickRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                attach([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="attach"
              onClick={() => pickRef.current?.click()}
              disabled={!!panel}
              aria-label="Attach files"
              title="Attach files: or paste them, or drop them here"
            >
              <Icon name="attach" size={16} />
            </button>
          </>
        )}
        {dictation.listening && (
          <div className="dictation-bar" role="group" aria-label="Dictating">
            <button
              type="button"
              className="dictation-cancel"
              onClick={dictation.cancel}
              aria-label="Cancel dictation"
              title="Cancel: discard what was said"
            >
              <Icon name="x" size={16} />
            </button>
            <Waveform source={dictation.level} className="dictation-wave" />
            <span className="dictation-time" aria-hidden="true">
              {elapsed}
            </span>
          </div>
        )}
        {dictation.available && (
          <button
            type="button"
            className={`mic ${dictation.listening ? "is-listening" : ""}`}
            onClick={toggleMic}
            disabled={!!panel}
            aria-pressed={dictation.listening}
            data-help-key="chat.dictate"
            aria-label={dictation.listening ? "Done dictating" : "Dictate"}
            title={
              dictation.listening
                ? "Done: keep what was said"
                : "Dictate: talk instead of typing"
            }
          >
            <Icon name={dictation.listening ? "check" : "mic"} size={16} />
          </button>
        )}
        <button className="primary send" aria-label="Send" disabled={busy}>
          <Icon name="send" size={16} />
          {busy ? "Sending…" : uploading ? "Uploading…" : "Send"}
        </button>
      </form>
    </>
  );
}

/** The files attached to a chat message (the event's `files`, see the server's chat-files.ts). */
export function chatFilesOf(
  payload: Record<string, unknown> | null | undefined,
): ChatFile[] {
  const files = payload?.files;
  return Array.isArray(files)
    ? files.filter(
        (f): f is ChatFile =>
          !!f &&
          typeof f === "object" &&
          typeof (f as ChatFile).name === "string",
      )
    : [];
}

/** Names and sizes of attached files, as chips. */
export function AttachedFiles({
  files,
}: {
  files: Pick<ChatFile, "name" | "size">[];
}) {
  if (!files.length) return null;
  return (
    <ul className="attached-files" aria-label="Attached files">
      {files.map((f, i) => (
        <li key={i} className="file-chip" title={f.name}>
          <Icon name="file" size={14} />
          <span className="file-name">{f.name}</span>
          <span className="file-size small muted">{formatBytes(f.size)}</span>
        </li>
      ))}
    </ul>
  );
}

/** "0:07" since `running` became true. */
function useElapsed(running: boolean): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    setSeconds(0);
    const t = setInterval(
      () => setSeconds(Math.floor((Date.now() - started) / 1000)),
      250,
    );
    return () => clearInterval(t);
  }, [running]);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
