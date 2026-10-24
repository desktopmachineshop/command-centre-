/** Minimal PCM WAV helpers (16-bit little-endian), enough to make silence and measure clips. */

export function silentWav(durationSec: number, sampleRate = 24_000, channels = 1): Uint8Array {
  const frames = Math.max(1, Math.round(durationSec * sampleRate));
  const dataBytes = frames * channels * 2;
  const buf = new Uint8Array(44 + dataBytes);
  const view = new DataView(buf.buffer);
  const ascii = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return buf;
}

/**
 * Duration of a PCM WAV. Streams often carry a placeholder size (0 or
 * 0xFFFFFFFF) in the data chunk, so the real byte length is used then.
 */
export function wavDuration(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") byteRate = view.getUint32(offset + 16, true);
    if (id === "data") {
      if (!byteRate) throw new Error("WAV data before fmt chunk");
      const available = bytes.length - offset - 8;
      const dataBytes = size === 0 || size === 0xffffffff || size > available ? available : size;
      return dataBytes / byteRate;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}
