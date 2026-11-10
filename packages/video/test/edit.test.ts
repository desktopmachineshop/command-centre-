import { describe, expect, it } from "vitest";
import { buildEditTimeline, EditError, editFiles, fileUrl, FRAME, parseSpec, planTimeline, relinkFcpxml, toFcpxml } from "../src";
import { minimalSpec } from "./helpers";

const spec = parseSpec(
  minimalSpec({
    title: 'OpenD: edit & "publish" <fast>',
    format: "16:9",
    scenes: [
      { id: "hook", kind: "title", heading: "Docs that ship", narration: "Ship docs faster." },
      { id: "demo", kind: "capture", steps: [{ action: "goto", url: "https://docs.opend.app/" }], narration: "Here is the editor." },
      { id: "shot", kind: "image", url: "https://example.com/a.png", alt: "diagram" },
      { id: "cta", kind: "outro", heading: "OpenD", cta: "Try it", narration: "Try OpenD." },
    ],
    music: { url: "https://example.com/m.mp3", volumeDb: -22 },
  }),
);
const voices = { hook: { durationSec: 1.5, words: [] }, demo: { durationSec: 2, words: [] }, cta: { durationSec: 0.9, words: [] } };
const timeline = planTimeline(spec, voices, { demo: 4 });
const files = {
  scenes: { hook: "01-hook.mp4", demo: "02-demo.mp4", shot: "03-shot.mp4", cta: "04-cta.mp4" },
  voices: { hook: { file: "voice-hook.mp3", durationSec: 1.5 }, demo: { file: "voice-demo.mp3", durationSec: 2 }, cta: { file: "voice-cta.mp3", durationSec: 0.9 } },
  music: "music.mp3",
  srt: "captions.srt",
};
const edit = buildEditTimeline(spec, FRAME[spec.format], timeline, files);

describe("editable timeline", () => {
  it("places each scene, its narration and the music where the render had them", () => {
    expect(edit).toMatchObject({ width: 1920, height: 1080, fps: 30, totalSec: 13.5, music: { file: "music.mp3", volumeDb: -22 }, srt: "captions.srt" });
    expect(edit.scenes.map((s) => [s.id, s.kind, s.file, s.startSec, s.durationSec])).toEqual([
      ["hook", "title", "01-hook.mp4", 0, 2.5],
      ["demo", "capture", "02-demo.mp4", 2.5, 4],
      ["shot", "image", "03-shot.mp4", 6.5, 3],
      ["cta", "outro", "04-cta.mp4", 9.5, 4],
    ]);
    expect(edit.scenes[1]!.narration).toEqual({ file: "voice-demo.mp3", offsetSec: 0.3, durationSec: 2 });
    expect(edit.scenes[2]!.narration).toBeUndefined();
    expect(edit.scenes[0]!.note).toBe("Ship docs faster.");
    expect(editFiles(edit)).toEqual(["01-hook.mp4", "voice-hook.mp3", "02-demo.mp4", "voice-demo.mp3", "03-shot.mp4", "04-cta.mp4", "voice-cta.mp3", "music.mp3"]);
  });

  it("refuses a missing clip or a file name that is a path", () => {
    expect(() => buildEditTimeline(spec, FRAME[spec.format], timeline, { ...files, scenes: { ...files.scenes, demo: "" } })).toThrow(EditError);
    expect(() => buildEditTimeline(spec, FRAME[spec.format], timeline, { ...files, scenes: { ...files.scenes, demo: "../x.mp4" } })).toThrow(/plain file name/);
    expect(() => buildEditTimeline(spec, FRAME[spec.format], planTimeline({ ...spec, scenes: spec.scenes.slice(1) }, voices), files)).toThrow(/does not match/);
  });
});

describe("FCPXML", () => {
  const doc = toFcpxml(edit);

  it("is a 1.9 document with one format and an asset per file", () => {
    expect(doc.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n<fcpxml version="1.9">')).toBe(true);
    expect(doc).toContain('<format id="r1" name="FFVideoFormat1080p30" frameDuration="1/30s" width="1920" height="1080" colorSpace="1-1-1 (Rec. 709)"/>');
    expect(doc.match(/<asset id=/g)).toHaveLength(8);
    expect(doc).toContain('<asset id="r2" name="01-hook" start="0s" duration="75/30s" hasVideo="1" format="r1" videoSources="1">\n      <media-rep kind="original-media" src="media/01-hook.mp4"/>');
    expect(doc).toContain('<asset id="r3" name="voice-hook" start="0s" duration="72000/48000s" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000">');
    expect(doc).toContain('<sequence format="r1" duration="405/30s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">');
    // The title is escaped wherever it appears.
    expect(doc).toContain('<project name="OpenD: edit &amp; &quot;publish&quot; &lt;fast&gt;">');
  });

  it("puts scenes end to end on the spine, narration one lane below its scene, music two lanes below across the video", () => {
    const clips = [...doc.matchAll(/^ {12}<asset-clip ref="(r\d+)" name="([^"]+)" offset="([^"]+)" start="0s" duration="([^"]+)" tcFormat="NDF">/gm)].map((m) => m.slice(1));
    expect(clips).toEqual([
      ["r2", "01 hook", "0s", "75/30s"],
      ["r5", "02 demo", "75/30s", "120/30s"],
      ["r7", "03 shot", "195/30s", "90/30s"],
      ["r8", "04 cta", "285/30s", "120/30s"],
    ]);
    expect(doc).toContain('<asset-clip ref="r3" lane="-1" name="voice hook" offset="9/30s" start="0s" duration="72000/48000s" audioRole="dialogue"/>');
    expect(doc).toContain('<asset-clip ref="r6" lane="-1" name="voice demo" offset="9/30s" start="0s" duration="96000/48000s" audioRole="dialogue"/>');
    expect(doc).toContain('<asset-clip ref="r4" lane="-2" name="music" offset="0s" start="0s" duration="405/30s" audioRole="music">\n                <adjust-volume amount="-22dB"/>');
    expect(doc.match(/lane="-2"/g)).toHaveLength(1);
    expect(doc).toContain('<marker start="0s" duration="1/30s" value="Here is the editor."/>');
  });

  it("is well formed: every element that opens closes, in order", () => {
    const stack: string[] = [];
    for (const m of doc.matchAll(/<(\/?)([a-z-]+)\b[^>]*?(\/?)>/g)) {
      if (m[3]) continue;
      if (m[1]) expect(stack.pop()).toBe(m[2]);
      else stack.push(m[2]!);
    }
    expect(stack).toEqual([]);
  });

  it("describes vertical and square frames as custom formats", () => {
    const vertical = toFcpxml({ ...edit, width: 1080, height: 1920 });
    expect(vertical).toContain('<format id="r1" frameDuration="1/30s" width="1080" height="1920" colorSpace="1-1-1 (Rec. 709)"/>');
  });

  it("is deterministic, and works without music or narration", () => {
    expect(toFcpxml(edit)).toBe(doc);
    const bare = toFcpxml(buildEditTimeline({ ...spec, music: undefined }, FRAME[spec.format], timeline, { scenes: files.scenes, voices: {} }), { mediaPrefix: "" });
    expect(bare).not.toContain("lane=");
    expect(bare).toContain('src="01-hook.mp4"');
    expect(bare.match(/<asset id=/g)).toHaveLength(4);
  });

  it("relinks media to where the files are on a PC", () => {
    const linked = relinkFcpxml(doc, (file) => (file === "music.mp3" ? undefined : fileUrl(`C:\\Users\\Dave\\Videos\\OpenD edit\\${file}`)));
    expect(linked).toContain('src="file:///C:/Users/Dave/Videos/OpenD%20edit/01-hook.mp4"');
    expect(linked).toContain('src="media/music.mp3"');
    expect(linked.match(/src="file:/g)).toHaveLength(7);
    expect(fileUrl("/home/dave/a b/x.mp4")).toBe("file:///home/dave/a%20b/x.mp4");
  });
});
