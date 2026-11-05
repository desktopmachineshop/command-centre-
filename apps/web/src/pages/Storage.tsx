import { useContext, useEffect, useState } from "react";
import type { Api, StorageOverview, StoredFile } from "../api";
import { ago } from "../format";
import { Icon } from "../icons";
import { Empty, ErrorBanner, PageHead, Skeleton, VerticalsContext, VTag } from "../ui";
import { VideoPreview } from "../video";

const FOLDER_LABELS: Record<string, string> = {
  media: "Uploads and post media",
  renders: "Video renders",
  footage: "Footage",
  attachments: "Attachments",
  assets: "Assets",
};
const folderLabel = (f: string) => FOLDER_LABELS[f] ?? f;

/** 1.2 GB, 340 MB, 12 KB. */
export function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** Usage per vertical ("shared" for files with none), largest first, with each one's folders. */
function byVertical(rows: StorageOverview["byFolder"]) {
  const map = new Map<string, { vertical: string; files: number; bytes: number; folders: Map<string, number> }>();
  for (const u of rows) {
    const v = u.vertical ?? "shared";
    const e = map.get(v) ?? { vertical: v, files: 0, bytes: 0, folders: new Map<string, number>() };
    e.files += u.files;
    e.bytes += u.bytes;
    e.folders.set(u.folder, (e.folders.get(u.folder) ?? 0) + u.bytes);
    map.set(v, e);
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}

/**
 * What's stored and where: the server volume's space (with the free-space reserve and the
 * render clean-up), usage by vertical, and the files themselves, newest first, to preview,
 * open, move to another vertical or delete. With Google Drive connected, new files are in
 * Drive, one folder per vertical, and the volume holds only the cache.
 */
export function Storage({ api }: { api: Api }) {
  const [data, setData] = useState<StorageOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [vertical, setVertical] = useState("");
  const verticals = useContext(VerticalsContext);
  const name = (v: string) => (v === "shared" ? "Shared" : (verticals[v]?.name ?? v));

  const load = () =>
    api
      .storage({ vertical: vertical || undefined })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), [api, vertical]);

  const remove = async (f: StoredFile) => {
    if (!confirm(`Delete ${f.name} (${bytes(f.size)})? Anything that links to it (a post, an approval) loses the file. This can't be undone.`)) return;
    try {
      await api.deleteStoredFile(f.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const move = async (f: StoredFile, to: string) => {
    try {
      await api.moveStoredFile(f.id, to);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const folders = data ? [...new Set(data.byFolder.map((u) => u.folder))] : [];
  const files = data?.files.filter((f) => !folder || f.folder === folder) ?? [];
  const usage = data ? byVertical(data.byFolder) : [];
  const choices = [...Object.values(verticals).map((v) => v.id), "shared"];

  return (
    <section>
      <PageHead
        title="Storage"
        sub={
          data
            ? data.backend === "gdrive"
              ? "New files go to Google Drive, in a folder per vertical."
              : "Files are kept on the server until Google Drive is connected."
            : undefined
        }
      >
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </PageHead>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {!data && !error && <Skeleton rows={3} />}
      {data && (
        <>
          <Space data={data} />
          {usage.length > 0 && (
            <div className="card">
              <div className="card-head">
                <Icon name="storage" />
                <h3>By vertical</h3>
              </div>
              <ul className="list storage-folders">
                {usage.map((u) => (
                  <li key={u.vertical} className="item static">
                    <button type="button" className="storage-vertical row between" onClick={() => setVertical(vertical === u.vertical ? "" : u.vertical)} aria-pressed={vertical === u.vertical}>
                      <span>{u.vertical === "shared" ? <span className="tag">Shared</span> : <VTag id={u.vertical}>{name(u.vertical)}</VTag>}</span>
                      <span className="muted small">
                        {u.files} file{u.files === 1 ? "" : "s"} · {bytes(u.bytes)}
                      </span>
                    </button>
                    <p className="muted small storage-vertical-folders">
                      {[...u.folders].map(([f, b]) => `${folderLabel(f)} ${bytes(b)}`).join(" · ")}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="section-title row between wrap">
            <h3>Files</h3>
            <span className="row wrap">
              <select value={vertical} onChange={(e) => setVertical(e.target.value)} aria-label="Vertical">
                <option value="">All verticals</option>
                {choices.map((v) => (
                  <option key={v} value={v}>
                    {name(v)}
                  </option>
                ))}
              </select>
              {folders.length > 1 && (
                <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder">
                  <option value="">All folders</option>
                  {folders.map((f) => (
                    <option key={f} value={f}>
                      {folderLabel(f)}
                    </option>
                  ))}
                </select>
              )}
            </span>
          </div>
          {files.length === 0 ? (
            <Empty icon="inbox">{vertical ? `Nothing stored for ${name(vertical)}.` : "Nothing stored yet. Uploads, video renders and attachments show up here."}</Empty>
          ) : (
            <ul className="list storage-files">
              {files.map((f) => (
                <FileRow key={f.id} file={f} choices={choices} name={name} onDelete={() => void remove(f)} onMove={(to) => void move(f, to)} />
              ))}
            </ul>
          )}
          {data.files.length >= 500 && <p className="small muted">Showing the newest 500 files.</p>}
        </>
      )}
    </section>
  );
}

/** The server volume's space, or Drive's quota, as a meter with what the limits mean. */
function Space({ data }: { data: StorageOverview }) {
  const v = data.volume;
  const used = v ? v.total - v.free : 0;
  const share = v && v.total > 0 ? used / v.total : 0;
  const quota = data.drive?.quota;
  return (
    <div className="card">
      <div className="card-head">
        <Icon name="server" />
        <h3>{data.backend === "gdrive" ? "Space" : "Server disk"}</h3>
      </div>
      {v ? (
        <>
          <div
            className={`progress storage-meter ${share >= 0.8 ? "is-high" : ""}`}
            role="meter"
            aria-label="Server disk used"
            aria-valuenow={Math.round(share * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${Math.min(100, Math.round(share * 100))}%` }} />
          </div>
          <p className="small">
            <strong>{bytes(used)}</strong> of {bytes(v.total)} used · {bytes(v.free)} free
            {share >= 0.8 && <span className="error"> · nearly full</span>}
          </p>
          <p className="small muted">
            Uploads stop with "Storage is full" before the last {bytes(v.minFreeBytes)}.{" "}
            {v.renderRetentionDays > 0
              ? `Video renders older than ${v.renderRetentionDays} days are deleted each night, unless an approval still needs them.`
              : "Video renders are kept until you delete them."}
          </p>
        </>
      ) : (
        <p className="small muted">The server's disk space couldn't be read.</p>
      )}
      {data.drive && (
        <p className="small">
          Google Drive{quota?.limit ? `: ${bytes(quota.usage)} of ${bytes(quota.limit)} used` : ""} ·{" "}
          <a href={data.drive.folderUrl} target="_blank" rel="noreferrer">
            Open the folder
          </a>
        </p>
      )}
    </div>
  );
}

function FileRow({
  file,
  choices,
  name,
  onDelete,
  onMove,
}: {
  file: StoredFile;
  choices: string[];
  name: (vertical: string) => string;
  onDelete: () => void;
  onMove: (vertical: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const kind = file.contentType.split("/")[0];
  const previewable = !!file.url && (kind === "video" || kind === "image" || kind === "audio");
  return (
    <li className="item static">
      <div className="row between wrap">
        <span className="title storage-name" title={file.name}>
          {file.name}
        </span>
        <span className="muted small">
          {bytes(file.size)} · {ago(file.createdAt)}
        </span>
      </div>
      <div className="row between wrap small">
        <span className="muted row wrap">
          {file.vertical ? <VTag id={file.vertical}>{name(file.vertical)}</VTag> : <span className="tag">Shared</span>}
          {file.wip && (
            <span className="tag" title="Work in progress: deleted once the final file of this work is published">
              WIP
            </span>
          )}
          <span>
            {folderLabel(file.folder)}
            {file.backend === "gdrive" ? " · Drive" : ""}
          </span>
        </span>
        <span className="row wrap storage-actions">
          <select className="small storage-move" value={file.vertical ?? "shared"} onChange={(e) => onMove(e.target.value)} aria-label={`Move ${file.name} to a vertical`}>
            {choices.map((v) => (
              <option key={v} value={v}>
                {v === (file.vertical ?? "shared") ? name(v) : `Move to ${name(v)}`}
              </option>
            ))}
          </select>
          {previewable && (
            <button type="button" className="small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              {open ? "Hide" : "Preview"}
            </button>
          )}
          {file.url && (
            <a className="button-link small" href={file.url} target="_blank" rel="noreferrer">
              Open
            </a>
          )}
          <button type="button" className="danger-text small" onClick={onDelete}>
            <Icon name="x" size={14} /> Delete
          </button>
        </span>
      </div>
      {open && file.url && (
        <div className="storage-preview">
          {kind === "video" && <VideoPreview video={{ url: file.url }} title={file.name} />}
          {kind === "image" && <img src={file.url} alt={file.name} loading="lazy" />}
          {kind === "audio" && <audio src={file.url} controls preload="metadata" />}
        </div>
      )}
    </li>
  );
}
