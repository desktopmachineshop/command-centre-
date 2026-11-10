import { describe, expect, it } from "vitest";
import { buildComposePlan, ComposeError, parseSpec, planTimeline } from "../src";
import { minimalSpec } from "./helpers";

const spec = parseSpec(
  minimalSpec({
    scenes: [
      { id: "hook", kind: "title", heading: "Docs that ship", narration: "Ship docs faster." },
      { id: "demo", kind: "capture", steps: [{ action: "goto", url: "https://docs.opend.app/" }], narration: "The editor." },
      { id: "shot", kind: "image", url: "https://example.com/a.png", alt: "diagram" },
      { id: "cta", kind: "outro", heading: "OpenD", cta: "Try it" },
    ],
    music: { url: "https://example.com/m.mp3", volumeDb: -22 },
  }),
);
const timeline = planTimeline(spec, { hook: { durationSec: 1.5, words: [] }, demo: { durationSec: 2, words: [] } }, { demo: 4 });
const base = {
  spec,
  timeline,
  visuals: { demo: { kind: "video" as const, file: "demo.webm", trimStartSec: 0.25 }, shot: { kind: "image" as const, file: "shot.png" } },
  narration: { hook: "voice-hook.wav", demo: "voice-demo.mp3" },
  subtitles: "captions.ass",
  encoder: "libx264" as const,
  output: "out.mp4",
};

describe("compositor", () => {
  it("builds one input per scene, then narration, with the trim before the recording", () => {
    const { args } = buildComposePlan(base);
    const inputs = args.flatMap((a, i) => (a === "-i" ? [args[i + 1]] : []));
    expect(inputs).toEqual([
      "color=c=0x0d1b2a:s=1080x1920:r=30:d=2.5",
      "demo.webm",
      "shot.png",
      "color=c=0x0d1b2a:s=1080x1920:r=30:d=4",
      "anullsrc=r=48000:cl=stereo",
      "voice-hook.wav",
      "voice-demo.mp3",
    ]);
    expect(args.slice(args.indexOf("demo.webm") - 3, args.indexOf("demo.webm") + 1)).toEqual(["-ss", "0.25", "-i", "demo.webm"]);
    expect(args.slice(-1)).toEqual(["out.mp4"]);
    expect(args).toEqual(expect.arrayContaining(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart"]));
    expect(args[args.indexOf("-t", args.indexOf("-filter_complex")) + 1]).toBe(String(timeline.total));
  });

  it("fits, freezes and trims each scene, concatenates, burns captions and mixes the voice at its start", () => {
    const { filterGraph } = buildComposePlan(base);
    expect(filterGraph).toContain("[1:v]scale=1080:1920:force_original_aspect_ratio=decrease:flags=lanczos,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0d1b2a,");
    expect(filterGraph).toContain("tpad=stop_mode=clone:stop_duration=4,trim=duration=4,setpts=PTS-STARTPTS");
    expect(filterGraph).toContain("zoompan=z='min(1+0.0008*on,1.12)'");
    expect(filterGraph).toContain("[v0][v1][v2][v3]concat=n=4:v=1:a=0");
    expect(filterGraph).toContain("[vcat]subtitles=filename=captions.ass[vout]");
    // demo voice starts at hook duration (2.5) + lead-in (0.3)
    expect(filterGraph).toContain("adelay=2800|2800[n1]");
    expect(filterGraph).toContain("[4:a][n0][n1]amix=inputs=3:duration=first:dropout_transition=0:normalize=0[voice]");
    expect(filterGraph).toContain("loudnorm=I=-14");
    expect(filterGraph).not.toContain("music"); // spec has music but no file was given
  });

  it("adds logo overlays, ducked music and the NVENC encoder when asked", () => {
    const { args, filterGraph } = buildComposePlan({ ...base, logo: "logo.png", music: "music.mp3", encoder: "h264_nvenc" });
    expect(args.slice(args.indexOf("music.mp3") - 3, args.indexOf("music.mp3") + 1)).toEqual(["-stream_loop", "-1", "-i", "music.mp3"]);
    expect(filterGraph).toMatch(/overlay=x=W-w-32:y=48:enable='between\(t,2\.5,6\.5\)\+between\(t,6\.5,9\.5\)'/);
    expect(filterGraph).toMatch(/overlay=x=\(W-w\)\/2:y=346:enable='between\(t,0,2\.5\)\+between\(t,9\.5,13\.5\)'/);
    expect(filterGraph).toContain("volume=-22dB");
    expect(filterGraph).toContain("[music][voiceSC]sidechaincompress");
    expect(args).toEqual(expect.arrayContaining(["-c:v", "h264_nvenc", "-cq", "21"]));
  });

  it("draws a logo scene as the logo alone, joins scenes with a dip to the brand colour, and cuts when asked", () => {
    const sting = parseSpec(minimalSpec({ scenes: [{ id: "sting", kind: "logo" }, { id: "hook", kind: "title", heading: "Docs that ship" }, { id: "cta", kind: "outro", heading: "OpenD", cta: "Try it" }] }));
    const stingTimeline = planTimeline(sting, {});
    expect(stingTimeline.scenes.map((s) => s.duration)).toEqual([1.5, 2.5, 4]);
    const { filterGraph } = buildComposePlan({ ...base, spec: sting, timeline: stingTimeline, narration: {}, visuals: {}, logo: "logo.png" });
    expect(filterGraph).toContain("format=rgba,split=3[logoS0][logoL0][logoX0]");
    expect(filterGraph).toContain("[logoX0]scale=w='min(756,iw*281/ih)':h=-1[logoX]");
    expect(filterGraph).toContain("[vcat][logoX]overlay=x=(W-w)/2:y=(H-h)/2:enable='between(t,0,1.5)'[vlogo0]");
    // The first scene only fades out, the last only fades in, the middle one both: no hard jumps.
    expect(filterGraph).toContain("setpts=PTS-STARTPTS,fade=t=out:st=1.3:d=0.2:color=0x0d1b2a,format=yuv420p[v0]");
    expect(filterGraph).toContain("fade=t=in:st=0:d=0.2:color=0x0d1b2a,fade=t=out:st=2.3:d=0.2:color=0x0d1b2a,format=yuv420p[v1]");
    expect(filterGraph).toContain("setpts=PTS-STARTPTS,fade=t=in:st=0:d=0.2:color=0x0d1b2a,format=yuv420p[v2]");

    const cut = buildComposePlan({ ...base, spec: { ...sting, transition: { style: "cut", durationSec: 0.2 } }, timeline: stingTimeline, narration: {}, visuals: {} });
    expect(cut.filterGraph).not.toContain("color=0x0d1b2a,format");
  });

  it("makes a picture-only clip for an editor: no sound, no fades from black", () => {
    const plan = buildComposePlan({ ...base, videoOnly: true });
    expect(plan.args).toContain("-an");
    expect(plan.args).not.toContain("[aout]");
    expect(plan.filterGraph).not.toContain("anullsrc");
    expect(plan.filterGraph).toContain("concat=n=4:v=1:a=0[vcat]");
  });

  it("cuts a recording to its clip window and never clips the mix", () => {
    const { args, filterGraph } = buildComposePlan({ ...base, visuals: { ...base.visuals, demo: { kind: "video", file: "demo.webm", trimStartSec: 1.25, maxDurationSec: 2 } } });
    expect(args.slice(args.indexOf("demo.webm") - 5, args.indexOf("demo.webm") + 1)).toEqual(["-ss", "1.25", "-t", "2", "-i", "demo.webm"]);
    expect(filterGraph).toContain("loudnorm=I=-14:TP=-1.5:LRA=11,alimiter=limit=0.84:level=false");
    expect(filterGraph).toMatch(/afade=t=out:st=13\.1:d=0\.4\[aout\]$/);
  });

  it("uses cover-fit when a capture scene asks for it", () => {
    const cover = parseSpec(minimalSpec({ format: "16:9", scenes: [{ id: "demo", kind: "capture", fit: "cover", steps: [{ action: "goto", url: "https://x.test/" }] }] }));
    const { filterGraph } = buildComposePlan({ ...base, spec: cover, timeline: planTimeline(cover, {}), narration: {} });
    expect(filterGraph).toContain("force_original_aspect_ratio=increase:flags=lanczos,crop=1920:1080");
  });

  it("refuses paths, missing visuals and mismatched timelines", () => {
    expect(() => buildComposePlan({ ...base, output: "../out.mp4" })).toThrow(ComposeError);
    expect(() => buildComposePlan({ ...base, subtitles: "C:\\x.ass" })).toThrow(/plain file name/);
    expect(() => buildComposePlan({ ...base, visuals: { demo: { kind: "video", file: "/etc/x" }, shot: base.visuals.shot } })).toThrow(/plain file name/);
    expect(() => buildComposePlan({ ...base, visuals: { shot: base.visuals.shot } })).toThrow(/no visual for capture scene "demo"/);
    expect(() => buildComposePlan({ ...base, timeline: { ...timeline, scenes: timeline.scenes.slice(1) } })).toThrow(/timeline/);
  });
});
