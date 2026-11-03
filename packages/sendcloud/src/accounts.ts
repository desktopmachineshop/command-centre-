import { z } from "zod";

/** One Sendcloud account (API key pair) and the business whose parcels it ships. */
export const SendcloudAccount = z.object({
  id: z.string().regex(/^[\w-]+$/, "id must be letters, digits, - or _"),
  vertical: z.string().min(1),
  publicKey: z.string().min(1, "public key is required"),
  secretKey: z.string().min(1, "secret key is required"),
});
export type SendcloudAccount = z.infer<typeof SendcloudAccount>;

/** The env (Railway) account: SENDCLOUD_PUBLIC_KEY + SENDCLOUD_SECRET_KEY, for SENDCLOUD_VERTICAL (default dms). */
export function sendcloudAccountFromEnv(env: NodeJS.ProcessEnv): SendcloudAccount[] {
  const publicKey = env.SENDCLOUD_PUBLIC_KEY?.trim();
  const secretKey = env.SENDCLOUD_SECRET_KEY?.trim();
  if (!publicKey && !secretKey) return [];
  if (!publicKey || !secretKey) throw new Error("SENDCLOUD_PUBLIC_KEY and SENDCLOUD_SECRET_KEY must both be set to enable Sendcloud");
  return [SendcloudAccount.parse({ id: "sendcloud", vertical: env.SENDCLOUD_VERTICAL?.trim() || "dms", publicKey, secretKey })];
}
