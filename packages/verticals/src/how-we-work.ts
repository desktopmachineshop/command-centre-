/**
 * The old org chart's roles, kept as guidance. When the Command Centre moved to one assistant, each
 * business's roles (Customer Support, Ops & Admin, ...) stopped being agents, but what they said
 * about how the work is done still matters: what good looks like, and what always needs Dave.
 * Each business's `guidance` is that text; the server writes it once to the brain as
 * "<brainFolder>/how-we-work.md" (where Dave can edit it), and the assistant reads it there.
 */
export interface Area {
  title: string;
  mission: string;
  autonomyNotes?: string;
  kpis?: string[];
}

export function howWeWork(business: string, areas: Area[]): string {
  const lines = [
    `# How we work: ${business}`,
    "",
    `The areas of ${business}'s work, what good looks like in each and what always needs Dave. Read this before working on ${business}. It started as the old org chart's roles; edit it freely.`,
  ];
  for (const a of areas) {
    lines.push("", `## ${a.title}`, a.mission);
    if (a.autonomyNotes) lines.push("", `Needs Dave: ${a.autonomyNotes}`);
    if (a.kpis?.length) lines.push("", `Good looks like: ${a.kpis.join("; ")}.`);
  }
  return lines.join("\n");
}
