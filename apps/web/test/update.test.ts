import { describe, expect, it } from "vitest";
import { decideUpdate } from "../src/update";

describe("decideUpdate", () => {
  it("does nothing when nothing changed or it can't tell", () => {
    expect(decideUpdate("abc", "abc", true)).toBe("none");
    expect(decideUpdate("abc", null, true)).toBe("none");
    expect(decideUpdate("dev", "abc", true)).toBe("none");
  });
  it("reloads when the app comes back with a newer version, else offers a banner", () => {
    expect(decideUpdate("abc", "def", true)).toBe("reload");
    expect(decideUpdate("abc", "def", false)).toBe("banner");
  });
});
