import { describe, expect, it } from "vitest";
import { applyLexicon, estimateMarks, lessonScript, narrationPieces, partAt, PAUSES, parseLexicon, pronounce, standardNumbers, ukLetters } from "../src/lesson";

describe("lessons as speech", () => {
  it("reads the pronunciation note, skipping what's still to check", () => {
    const lex = parseLexicon("# Pronunciation\n\n## Say it like this\n- EtherCAT: Ether-cat\n- `PLC`: P L C\n| SaaS | sass |\n\n## To check\n- Beckhoff — sounded off\n");
    expect([...lex]).toEqual([
      ["EtherCAT", "Ether-cat"],
      ["PLC", "P L C"],
      ["SaaS", "sass"],
    ]);
  });

  it("says terms its way: whole words, plurals kept, longest first, case by the term", () => {
    const lex = new Map([
      ["PLC", "P L C"],
      ["TwinCAT", "Twin-cat"],
      ["TwinCAT 3", "Twin-cat three"],
      ["mm", "millimetres"],
    ]);
    expect(applyLexicon("Two PLCs run TwinCAT 3, not TwinCAT 2, on a 10 mm plate. PLCopen stays.", lex)).toBe(
      "Two P L Cs run Twin-cat three, not Twin-cat 2, on a 10 millimetres plate. PLCopen stays.",
    );
    expect(applyLexicon("MM and mm", new Map([["mm", "millimetres"]]))).toBe("millimetres and millimetres");
    expect(applyLexicon("a plc", new Map([["PLC", "P L C"]]))).toBe("a plc");
  });

  it("reads standards' numbers the way engineers say them", () => {
    expect(standardNumbers("IEC 61131-3 and IEC 61508, ISO 26262, EN 50128, ISO/IEC/IEEE 29148.")).toBe(
      "IEC sixty-one one thirty-one, part 3 and IEC sixty-one five oh eight, ISO twenty-six two sixty-two, EN fifty one twenty-eight, ISO/IEC/IEEE twenty-nine one forty-eight.",
    );
    expect(standardNumbers("It cost 61131 pounds; ISO 9001 stays.")).toBe("It cost 61131 pounds; ISO 9001 stays.");
  });

  it("says a lone Z the UK way, and pronounces in one step for any spoken text", () => {
    expect(ukLetters("Home the Z axis, then X, Y and Z. Gen Z and XYZ stay.")).toBe("Home the zed axis, then X, Y and zed. Gen zed and XYZ stay.");
    expect(ukLetters("Z-axis")).toBe("zed-axis");
    expect(pronounce("The EtherCAT drive on the Z axis meets IEC 61508.", new Map([["EtherCAT", "Ether-cat"]]))).toBe(
      "The Ether-cat drive on the zed axis meets IEC sixty-one five oh eight.",
    );
    expect(pronounce("Nothing to change here.")).toBe("Nothing to change here.");
  });

  it("applies the lexicon in the script, and gives a recording its cadence", () => {
    const script = lessonScript("# Title\n\n## One\nFirst sentence here. Second, with a comma, here.\n\nNew paragraph about a PLC.\n\n## Two\nLast one.\n", "Title", new Map([["PLC", "P L C"]]));
    expect(script.parts.map((p) => p.text)).toContain("New paragraph about a P L C.");
    const pieces = narrationPieces(script);
    expect(pieces.map((p) => [p.text, p.pause])).toEqual([
      ["Title.", PAUSES.section],
      ["One.", PAUSES.heading],
      ["First sentence here.", PAUSES.sentence],
      ["Second, with a comma, here.", PAUSES.paragraph],
      ["New paragraph about a P L C.", PAUSES.section],
      ["Two.", PAUSES.heading],
      ["Last one.", PAUSES.paragraph],
    ]);
  });

  it("gives every block of the text, each tied to the part it is when spoken (for the reading view)", () => {
    const body = "# Title\n\n## One\nFirst para.\nSame para.\n\n- Item.\n\n## Try it\n```\nx = 1\n```\nDo it.\n\n## Quiz\n1. Q?\n   **Answer:** A.\n";
    const s = lessonScript(body, "Title");
    expect(s.blocks.map((b) => [b.source, b.part, b.heading ?? null])).toEqual([
      ["# Title", 0, 1],
      ["## One", 1, 2],
      ["First para.\nSame para.", 2, null],
      ["- Item.", 3, null],
      ["## Try it", null, 2],
      ["```\nx = 1\n```", null, null],
      ["Do it.", null, null],
      ["## Quiz", 4, 2],
      ["1. Q?", 5, null],
      ["   **Answer:** A.", 6, null],
    ]);
    // Every spoken part has exactly one block, in order.
    expect(s.blocks.filter((b) => b.part !== null).map((b) => b.part)).toEqual(s.parts.map((_, i) => i));
    expect(narrationPieces(s).map((p) => p.part)).toEqual([0, 1, 2, 2, 3, 4, 5, 6]);
  });

  it("finds the part playing, and estimates part starts for old recordings", () => {
    expect(partAt([0, 4, 10], 0)).toBe(0);
    expect(partAt([0, 4, 10], 9.9)).toBe(1);
    expect(partAt([0, 4, 10], 60)).toBe(2);
    const marks = estimateMarks([{ section: 0, text: "one two" }, { section: 0, text: "three four five six seven eight" }], 100);
    expect(marks[0]).toBe(0);
    expect(marks[1]).toBeCloseTo(33.3, 0);
  });
});
