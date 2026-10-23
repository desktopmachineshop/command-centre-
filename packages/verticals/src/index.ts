import type { VerticalManifest } from "@cc/core";
import threeDPandMe from "./3dpandme";
import dms from "./dms";
import opend from "./opend";
import openv from "./openv";
import personal from "./personal";

/** All verticals. To add one, create a manifest file and list it here. */
export const verticals: readonly VerticalManifest[] = [personal, dms, threeDPandMe, openv, opend];

/** Fallback vertical for events nothing else claims. */
export const DEFAULT_VERTICAL = "personal";

export class VerticalRegistry {
  private readonly byId: Map<string, VerticalManifest>;

  constructor(list: readonly VerticalManifest[] = verticals) {
    this.byId = new Map();
    for (const v of list) {
      if (this.byId.has(v.id)) throw new Error(`Duplicate vertical id: ${v.id}`);
      this.byId.set(v.id, v);
    }
  }

  all(): VerticalManifest[] {
    return [...this.byId.values()];
  }

  get(id: string): VerticalManifest | undefined {
    return this.byId.get(id);
  }

  require(id: string): VerticalManifest {
    const v = this.byId.get(id);
    if (!v) throw new Error(`Unknown vertical: ${id}`);
    return v;
  }
}
