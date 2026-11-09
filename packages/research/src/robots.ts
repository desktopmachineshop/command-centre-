/**
 * robots.txt, for the tools that read a site in bulk on a schedule (the catalogue readers behind
 * `site_products` and `competitor_snapshot`). A shop that asks robots to stay out of a path is
 * taken at its word: that source is skipped and the agent is told why. A single page someone
 * asked to read (`fetch_page`) is not a crawl and is not checked.
 */

export interface RobotsRules {
  /** True when robots may read this path (with its query string). */
  allowed(path: string): boolean;
  /** `Sitemap:` lines. */
  sitemaps: string[];
}

interface Rule {
  allow: boolean;
  pattern: RegExp;
  length: number;
}

/** A robots.txt path pattern (`*` wildcard, `$` end anchor) as a regular expression. */
function patternOf(value: string): RegExp {
  const anchored = value.endsWith("$");
  const body = (anchored ? value.slice(0, -1) : value)
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`);
}

/**
 * The rules that apply to `agent` (a product token, e.g. "CommandCentreResearch"): its own group
 * if the file has one, else the `*` group. The longest matching rule wins, and Allow wins a tie,
 * as RFC 9309 says. An empty or missing file allows everything.
 */
export function parseRobots(text: string, agent: string): RobotsRules {
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;
  let inAgents = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const at = line.indexOf(":");
    if (at < 1) continue;
    const key = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    if (key === "sitemap") {
      if (value) sitemaps.push(value);
    } else if (key === "user-agent") {
      // Consecutive User-agent lines share one group.
      if (!current || !inAgents) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      inAgents = true;
    } else if (key === "allow" || key === "disallow") {
      inAgents = false;
      // "Disallow:" with nothing after it allows everything.
      if (current && value) current.rules.push({ allow: key === "allow", pattern: patternOf(value), length: value.length });
    } else {
      inAgents = false;
    }
  }
  const name = agent.toLowerCase();
  const own = groups.filter((g) => g.agents.some((a) => a !== "*" && name.includes(a)));
  const rules = (own.length ? own : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules);
  return {
    sitemaps,
    allowed(path: string): boolean {
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!rule.pattern.test(path)) continue;
        if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

export const ALLOW_ALL: RobotsRules = { allowed: () => true, sitemaps: [] };
