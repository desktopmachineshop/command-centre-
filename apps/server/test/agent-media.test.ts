import { describe, expect, it } from "vitest";
import { agentMedia, builtinExecutors } from "../src/actions";

const BASE = "https://command.example.com";
const VIDEO = `${"a".repeat(32)}.mp4`;
const IMAGE = `${"b".repeat(32)}.png`;

describe("agent notify media", () => {
  it("takes this server's /media files, absolute or as a path, and says which are video", () => {
    expect(agentMedia(undefined, BASE)).toEqual([]);
    expect(agentMedia([], undefined)).toEqual([]);
    expect(agentMedia([`${BASE}/media/${VIDEO}`, { url: `/media/${IMAGE}`, alt: "Kit photo" }], `${BASE}/`)).toEqual([
      { url: `${BASE}/media/${VIDEO}`, type: "video" },
      { url: `${BASE}/media/${IMAGE}`, type: "image", alt: "Kit photo" },
    ]);
    // One item on its own is fine too.
    expect(agentMedia(`/media/${IMAGE}`, BASE)).toEqual([{ url: `${BASE}/media/${IMAGE}`, type: "image" }]);
  });

  it("refuses anything that isn't one of our own image or video files", () => {
    const refused = [
      `https://evil.example/media/${IMAGE}`, // someone else's host
      `${BASE}.evil.example/media/${IMAGE}`, // a host that only starts like ours
      `${BASE}/media/${IMAGE}?x=1`,
      `${BASE}/media/../api/stats`,
      `/media/${"c".repeat(32)}.mp3`, // audio
      `/media/${"c".repeat(31)}.png`,
      "/api/storage",
      "javascript:alert(1)",
      { alt: "no url" },
      42,
    ];
    for (const bad of refused) expect(() => agentMedia([bad], BASE), JSON.stringify(bad)).toThrow(/payload\.media\[0\]/);
    expect(() => agentMedia(Array(5).fill(`/media/${IMAGE}`), BASE)).toThrow(/at most 4/);
    expect(() => agentMedia([`/media/${IMAGE}`], undefined)).toThrow(/PUBLIC_BASE_URL/);
  });

  it("refuses bad media when the agent proposes the notify, so the agent sees why", () => {
    const validate = builtinExecutors.notify!.validate!;
    expect(() => validate({ title: "t", body: "b", media: ["https://evil.example/x.png"] }, { vertical: "dms", publicBaseUrl: BASE })).toThrow(/this server's \/media/);
    expect(() => validate({ title: "t", body: "b", media: [`/media/${VIDEO}`] }, { vertical: "dms", publicBaseUrl: BASE })).not.toThrow();
  });
});
