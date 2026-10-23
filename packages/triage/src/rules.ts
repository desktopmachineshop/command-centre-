import type { Event, TriageResult } from "@cc/core";
import { triageOdooEvent } from "./odoo";
import type { TriageContext, Triager } from "./triager";

/**
 * Deterministic triage with no model call. Handles the events whose meaning is
 * already known: scheduled prompts, events whose ingress set a vertical, and
 * direct chat requests (which always go to the command agent).
 */
export class RulesTriager implements Triager {
  readonly name = "rules";

  async triage(event: Event, context: TriageContext): Promise<TriageResult | null> {
    const known = event.vertical ? context.verticals.find((v) => v.id === event.vertical) : undefined;

    if (event.source === "cron") {
      return {
        vertical: known?.id ?? context.defaultVertical,
        intent: "scheduled",
        urgency: 0.5,
        route: "agent",
        confidence: 1,
        triager: this.name,
      };
    }

    if (event.source === "chat") {
      const mentioned = known ?? mentionedVertical(event, context);
      return {
        vertical: mentioned?.id ?? context.defaultVertical,
        intent: "request",
        urgency: 0.8,
        route: "agent",
        confidence: 1,
        triager: this.name,
      };
    }

    // --- Odoo events: route and intent from the kind (./odoo.ts) ---
    if (event.source === "odoo") {
      const odoo = triageOdooEvent(event, context, this.name);
      if (odoo) return odoo;
    }
    // --- end odoo ---

    if (known) {
      return {
        vertical: known.id,
        intent: "other",
        urgency: 0.3,
        route: "agent",
        confidence: 0.5,
        triager: this.name,
        notes: "Vertical known from ingress; intent needs a model triager",
      };
    }

    return null;
  }
}

/** Finds a vertical named in a chat message, e.g. "for dms: ..." or "Desktop Machine Shop". */
function mentionedVertical(event: Event, context: TriageContext) {
  const text = `${event.title} ${typeof event.payload.text === "string" ? event.payload.text : ""}`.toLowerCase();
  return context.verticals.find(
    (v) => new RegExp(`(^|[^a-z0-9])${escape(v.id)}([^a-z0-9]|$)`).test(text) || text.includes(v.name.toLowerCase()),
  );
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
