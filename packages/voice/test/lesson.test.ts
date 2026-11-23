import { describe, expect, it } from "vitest";
import { applyLexicon, lessonScript, narrationPieces, PAUSES, parseLexicon, pronounce, standardNumbers, ukLetters } from "../src/lesson";

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
});
