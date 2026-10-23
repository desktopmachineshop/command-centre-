#!/usr/bin/env node
// Stand-in for ffmpeg: prints a Duration line and -progress output, then writes
// its own argv as JSON to the output file (the last argument).
// FAKE_FFMPEG_EXIT=<code> makes it fail.
const args = process.argv.slice(2);
const output = args.at(-1);
process.stderr.write("Input #0, mov, from 'input.mp4':\n  Duration: 00:00:10.00, start: 0.000000, bitrate: 1000 kb/s\n");
if (process.env.FAKE_FFMPEG_EXIT) {
  process.stderr.write("Conversion failed!\n");
  process.exit(Number(process.env.FAKE_FFMPEG_EXIT));
}
const { writeFileSync } = await import("node:fs");
for (const us of [2_500_000, 5_000_000, 7_500_000, 10_000_000]) {
  process.stdout.write(`frame=1\nout_time_us=${us}\nout_time_ms=${us}\nprogress=${us === 10_000_000 ? "end" : "continue"}\n`);
  await new Promise((r) => setTimeout(r, 30));
}
writeFileSync(output, JSON.stringify(args));
