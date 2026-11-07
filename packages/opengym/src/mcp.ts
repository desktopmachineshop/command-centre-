import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GymService } from "./service";

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });
const day = () => z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD");

async function guard<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (err) {
    return fail((err as Error).message);
  }
}

/**
 * Read-only openGym tools at /mcp/opengym: Dave's workouts and weigh-ins. Nothing is written to
 * openGym. `timeZone` sets what "today" means.
 */
export function createOpenGymMcpServer(gym: GymService, timeZone?: string): McpServer {
  const server = new McpServer({ name: "opengym", version: "0.1.0" });

  server.registerTool(
    "training_summary",
    {
      description:
        "Dave's training and weight over the last `days` days (default 7) up to `to` (default today): sessions, volume (weight × reps of work sets, in `unit`), sets, PRs, days since the last workout, and weight change against the goal. Compares with the period before. Start here for 'how's the gym going?'.",
      inputSchema: { days: z.number().int().min(1).max(365).optional(), to: day().optional() },
    },
    ({ days, to }) => guard(() => gym.summary({ days, to, timeZone })),
  );

  server.registerTool(
    "list_workouts",
    {
      description: "Finished gym sessions, newest first: date, routine, exercises, sets done/planned, volume, duration in minutes, PR count. Use get_workout for one session's sets.",
      inputSchema: { from: day().optional(), to: day().optional(), limit: z.number().int().min(1).max(200).optional() },
    },
    ({ from, to, limit }) => guard(() => gym.workouts({ from, to, limit, timeZone })),
  );

  server.registerTool(
    "get_workout",
    {
      description: "One session set by set (e.g. '8 × 60 kg'), with each exercise's best estimated 1RM that day and the PRs set. By `id` from list_workouts, or by `date` (two sessions on one day are listed for you to pick).",
      inputSchema: { id: z.string().min(1).optional(), date: day().optional() },
    },
    ({ id, date }) => (id || date ? guard(() => gym.workout({ id, date })) : Promise.resolve(fail("Give an id or a date"))),
  );

  server.registerTool(
    "get_bodyweight",
    {
      description: "Weigh-ins (one value per day) between `from` and `to`, the goal weight, the latest weight against the goal, and the 7- and 30-day change.",
      inputSchema: { from: day().optional(), to: day().optional() },
    },
    ({ from, to }) => guard(() => gym.bodyweight({ from, to, timeZone })),
  );

  return server;
}
