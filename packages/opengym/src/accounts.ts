import { z } from "zod";

/**
 * Dave's openGym server (https://github.com/DuarteSantos8/openGym), self-hosted. `token` is a
 * paired session token, or the 8-character pairing code openGym shows under Settings → "Pair the
 * mobile app": the service swaps a code for a token on first use and saves the token.
 */
export const OpenGymAccount = z.object({
  id: z.string().regex(/^[\w-]+$/, "id must be letters, digits, - or _"),
  vertical: z.string().min(1),
  url: z.string().min(1, "the openGym address is required"),
  token: z.string().min(1, "a pairing code or token is required"),
});
export type OpenGymAccount = z.infer<typeof OpenGymAccount>;

/** The env (Railway) account: OPENGYM_URL + OPENGYM_TOKEN, for OPENGYM_VERTICAL (default personal). */
export function openGymAccountFromEnv(env: NodeJS.ProcessEnv): OpenGymAccount[] {
  const url = env.OPENGYM_URL?.trim();
  const token = env.OPENGYM_TOKEN?.trim();
  if (!url && !token) return [];
  if (!url || !token) throw new Error("OPENGYM_URL and OPENGYM_TOKEN must both be set to enable openGym");
  return [OpenGymAccount.parse({ id: "default", vertical: env.OPENGYM_VERTICAL?.trim() || "personal", url, token })];
}
