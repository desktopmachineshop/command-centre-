import { useState } from "react";

/** A rendered video in a proposal payload or a finished render job. */
export interface VideoInfo {
  url: string;
  durationSec?: number;
  width?: number;
  height?: number;
}

const isHttpUrl = (v: unknown): v is string => typeof v === "string" && /^https?:\/\//i.test(v);

/** The video a proposal or job result carries (`video: { url, ... }`, or a render result's own `url`), if any. */
export function videoOf(value: unknown): VideoInfo | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const v = (o.video && typeof o.video === "object" ? o.video : o) as Record<string, unknown>;
  if (!isHttpUrl(v.url)) return null;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  return { url: v.url, durationSec: num(v.durationSec), width: num(v.width), height: num(v.height) };
}

const length = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;

/**
 * Watch a rendered video in place: a player sized to the video's shape (portrait shorts stay
 * narrow), its length and size, and a link to the full file. Loads only the first frame until played.
 */
export function VideoPreview({ video, title }: { video: VideoInfo; title?: string }) {
  const [failed, setFailed] = useState(false);
  const portrait = video.width && video.height ? video.height > video.width : false;
  const facts = [
    video.durationSec != null ? length(video.durationSec) : null,
    video.width && video.height ? `${video.width}×${video.height}` : null,
  ].filter(Boolean);
  return (
    <figure className={`video-preview ${portrait ? "portrait" : ""}`}>
      {failed ? (
        <p className="small muted">This video can't be played here (it may have moved, or the browser can't play its format).</p>
      ) : (
        <video
          src={video.url}
          controls
          playsInline
          preload="metadata"
          aria-label={title ? `Video: ${title}` : "Video preview"}
          style={video.width && video.height ? { aspectRatio: `${video.width} / ${video.height}` } : undefined}
          onError={() => setFailed(true)}
        />
      )}
      <figcaption className="small muted row between">
        <span>{facts.join(" · ") || "Video"}</span>
        <a href={video.url} target="_blank" rel="noreferrer">
          Open full size
        </a>
      </figcaption>
    </figure>
  );
}
