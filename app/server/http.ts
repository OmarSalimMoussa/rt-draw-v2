import type { IncomingMessage, ServerResponse } from "node:http";

/** A request the server refuses, with the status to answer it with. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Bodies larger than this are refused (413), so one request can't exhaust the server's memory. */
const MAX_BODY = 2_000_000;

/** Reads a JSON body, refusing anything but JSON (415: a plain cross-site form post can't send it) or too big (413). */
export async function readJson<T>(req: IncomingMessage, max = MAX_BODY): Promise<T> {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "send application/json");
  // Bytes first, decoded once: a character split across two chunks would otherwise come out garbled.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new HttpError(413, `body over ${max} bytes`);
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

export type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

/** Routes by exact path; the API's routes are all flat. */
export class Router {
  private routes = new Map<string, Handler>();

  use(path: string, handler: Handler) {
    this.routes.set(path, handler);
  }

  /** Runs the matching route; false if there is none. */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const handler = this.routes.get((req.url ?? "").split("?")[0]);
    if (!handler) return false;
    await handler(req, res);
    return true;
  }
}

export function json(res: ServerResponse, status: number, value: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(value));
}
