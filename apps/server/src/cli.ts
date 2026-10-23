/**
 * User admin against DATABASE_URL, for first setup and password resets:
 *
 *   pnpm --filter @cc/server user:create -- --email dave@example.com --name Dave
 *   pnpm --filter @cc/server user:reset-password -- --email dave@example.com [--disable-2fa]
 *   pnpm --filter @cc/server user:list
 *
 * The password is prompted for (hidden), or read from the first line of stdin when piped,
 * so it never lands in shell history. On Railway: `railway run --service Postgres -- pnpm ...`
 * (see docs/SETUP.md, "Authentication"). Inside the server container: `node dist/cli.js ...`.
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { AuthError, AuthService } from "./accounts/service";
import { createPool, migrate, type Pool } from "./db/pool";

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads a password (hidden on a terminal). */
  readPassword: (prompt: string) => Promise<string>;
}

const USAGE = `Usage:
  user:create          --email <email> --name <name>
  user:reset-password  --email <email> [--disable-2fa]
  user:list`;

/** Runs one command. Returns the process exit code. */
export async function runCli(argv: string[], pool: Pool, io: CliIo, auth = new AuthService(pool)): Promise<number> {
  const { positionals, values } = parseArgs({
    // `pnpm <script> -- --email x` passes the `--` through; it isn't an end-of-options marker here.
    args: argv.filter((a) => a !== "--"),
    allowPositionals: true,
    options: { email: { type: "string" }, name: { type: "string" }, "disable-2fa": { type: "boolean" }, help: { type: "boolean" } },
  });
  const command = positionals[0];
  if (values.help || !command) {
    io.out(USAGE);
    return command ? 0 : 1;
  }
  await migrate(pool);

  const newPassword = async () => {
    const password = await io.readPassword("New password: ");
    const again = await io.readPassword("Repeat it: ");
    if (password !== again) throw new AuthError(400, "The passwords don't match");
    return password;
  };

  try {
    switch (command) {
      case "create": {
        if (!values.email || !values.name) throw new AuthError(400, "--email and --name are required");
        const user = await auth.createUser({ email: values.email, name: values.name, password: await newPassword() });
        io.out(`Created ${user.role} ${user.email} (${user.id}). Sign in at your Command Centre URL.`);
        return 0;
      }
      case "reset-password": {
        if (!values.email) throw new AuthError(400, "--email is required");
        const user = await auth.resetPassword(values.email, await newPassword(), { disableTotp: values["disable-2fa"] });
        io.out(`Password reset for ${user.email}. Every session was signed out${values["disable-2fa"] ? " and two-factor is off" : ""}.`);
        return 0;
      }
      case "list": {
        const users = await auth.store.listUsers();
        if (!users.length) io.out("No users yet. Open the app for first-run setup, or run user:create.");
        for (const u of users) {
          const locked = u.lockedUntil && Date.parse(u.lockedUntil) > Date.now() ? ` locked until ${u.lockedUntil}` : "";
          io.out(`${u.email}\t${u.name}\t${u.role}\t2FA ${u.totpEnabled ? "on" : "off"}\tlast login ${u.lastLoginAt ?? "never"}${locked}`);
        }
        return 0;
      }
      default:
        io.err(`Unknown command ${command}\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof AuthError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
}

/** Prompts without echoing on a terminal; reads successive stdin lines when piped. */
function terminalIo(): CliIo {
  const lines: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  let piped: ReturnType<typeof createInterface> | null = null;
  const nextPipedLine = () =>
    new Promise<string>((resolve) => {
      piped ??= createInterface({ input: process.stdin }).on("line", (l) => {
        const w = waiters.shift();
        if (w) w(l);
        else lines.push(l);
      }).on("close", () => waiters.splice(0).forEach((w) => w("")));
      const l = lines.shift();
      if (l !== undefined) resolve(l);
      else waiters.push(resolve);
    });

  return {
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    readPassword: async (prompt) => {
      if (!process.stdin.isTTY) return nextPipedLine();
      process.stdout.write(prompt);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      return new Promise((resolve, reject) => {
        let value = "";
        const onData = (buf: Buffer) => {
          for (const ch of buf.toString("utf8")) {
            if (ch === "\r" || ch === "\n") {
              cleanup();
              process.stdout.write("\n");
              return resolve(value);
            }
            if (ch === "\u0003") {
              cleanup();
              return reject(new Error("cancelled"));
            }
            if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
            else value += ch;
          }
        };
        const cleanup = () => {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
        };
        process.stdin.on("data", onData);
      });
    },
  };
}

/** The Postgres URL to use: DATABASE_PUBLIC_URL first, since `railway run` executes on your PC, outside Railway's private network. */
export function cliDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  return env.CC_DATABASE_URL || env.DATABASE_PUBLIC_URL || env.DATABASE_URL;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const url = cliDatabaseUrl(process.env);
  if (!url) {
    console.error("Set DATABASE_URL (or run through `railway run`).");
    process.exit(1);
  }
  const pool = createPool(url);
  const code = await runCli(process.argv.slice(2), pool, terminalIo()).catch((err) => {
    console.error((err as Error).message);
    return 1;
  });
  await pool.end();
  process.exit(code);
}
