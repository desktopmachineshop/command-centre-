import type { AddressInfo } from "node:net";
import { SMTPServer } from "smtp-server";

export interface Received {
  from: string;
  to: string[];
  raw: string;
  user?: string;
}

/** An in-process SMTP server that records what it receives. */
export async function startSmtp() {
  const received: Received[] = [];
  const server = new SMTPServer({
    hideSTARTTLS: true,
    allowInsecureAuth: true,
    logger: false,
    onAuth(auth, _session, cb) {
      if (auth.username === "u" && auth.password === "p") cb(null, { user: auth.username });
      else cb(new Error("bad credentials"));
    },
    onData(stream, session, cb) {
      const chunks: Buffer[] = [];
      stream.on("data", (c: Buffer) => chunks.push(c));
      stream.on("end", () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString(),
          user: session.user as string | undefined,
        });
        cb();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;
  return { port, received, close: () => new Promise<void>((resolve) => server.close(resolve)) };
}
