#!/usr/bin/env node
/**
 * Streamable HTTP stub MCP for the harness's own tests. It serves the same surface as the stdio
 * stub (`stub.ts`) over `node:http`, bridged to the SDK's web-standard Streamable HTTP server
 * transport, and records every request so tests can prove what the client actually sent.
 *
 * Modes:
 * - `response: "sse"` (default) answers POSTs with `text/event-stream` framing.
 * - `response: "json"` answers POSTs with a single `application/json` body.
 * - `sessions: true` (default) issues an `mcp-session-id` on initialise and requires it after.
 *   `sessions: false` is stateless: a fresh server and transport per request, no session id.
 * - `bearer: "<value>"` rejects any request whose `Authorization` header is not `Bearer <value>`
 *   with HTTP 401, before the MCP layer sees it.
 * - `hang: true` accepts connections and never answers, to exercise client timeouts.
 *
 * All values are synthetic. Run directly for manual checks:
 *   node dist/examples/stub-mcp/http-server.js [--json] [--stateless] [--port 3901]
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";

import { createStubServer } from "./stub.js";

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface HttpStubOptions {
  response?: "sse" | "json";
  sessions?: boolean;
  bearer?: string;
  hang?: boolean;
  /** Port to listen on. 0 (default) picks a free port. */
  port?: number;
}

export interface RecordedRequest {
  method: string;
  authorization: string | undefined;
  sessionId: string | undefined;
  /** JSON-RPC method of the request body, when there is one. */
  rpcMethod: string | undefined;
  status: number;
  contentType: string | undefined;
}

export interface HttpStub {
  url: string;
  requests: RecordedRequest[];
  /** Session ids the stub issued, in order. */
  issuedSessions: string[];
  close: () => Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function toWebRequest(req: IncomingMessage, body: Buffer, origin: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && body.length > 0;
  return new Request(new URL(req.url ?? "/", origin), { method: req.method ?? "GET", headers, ...(hasBody ? { body: new Uint8Array(body) } : {}) });
}

async function sendWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => void reader.cancel().catch(() => undefined));
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
}

function rpcMethodOf(body: Buffer): string | undefined {
  if (body.length === 0) return undefined;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as { method?: unknown } | Array<{ method?: unknown }>;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    return typeof first?.method === "string" ? first.method : undefined;
  } catch {
    return undefined;
  }
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function startHttpStub(options: HttpStubOptions = {}): Promise<HttpStub> {
  const enableJsonResponse = options.response === "json";
  const stateful = options.sessions !== false;
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const requests: RecordedRequest[] = [];
  const issuedSessions: string[] = [];
  const hanging = new Set<ServerResponse>();
  let origin = "";

  async function transportFor(sessionId: string | undefined): Promise<WebStandardStreamableHTTPServerTransport | undefined> {
    if (!stateful) {
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse });
      await createStubServer().connect(transport);
      return transport;
    }
    if (sessionId) {
      return sessions.get(sessionId);
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse,
      sessionIdGenerator: () => `stub-session-${randomUUID()}`,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        issuedSessions.push(id);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
      },
    });
    await createStubServer().connect(transport);
    return transport;
  }

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const record: RecordedRequest = {
        method: req.method ?? "",
        authorization: header(req, "authorization"),
        sessionId: header(req, "mcp-session-id"),
        rpcMethod: rpcMethodOf(body),
        status: 0,
        contentType: undefined,
      };
      requests.push(record);

      if (options.hang) {
        hanging.add(res);
        res.on("close", () => hanging.delete(res));
        return;
      }
      if (options.bearer !== undefined && record.authorization !== `Bearer ${options.bearer}`) {
        record.status = 401;
        res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Bearer realm="stub"' });
        res.end(JSON.stringify({ error: "unauthorised" }));
        return;
      }
      const transport = await transportFor(record.sessionId);
      if (!transport) {
        record.status = 404;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }));
        return;
      }
      const response = await transport.handleRequest(toWebRequest(req, body, origin));
      record.status = response.status;
      record.contentType = response.headers.get("content-type") ?? undefined;
      await sendWebResponse(res, response);
    })().catch((error: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
      }
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}/mcp`,
    requests,
    issuedSessions,
    close: async () => {
      for (const res of hanging) res.destroy();
      for (const transport of sessions.values()) await transport.close().catch(() => undefined);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  const stub = await startHttpStub({
    response: args.includes("--json") ? "json" : "sse",
    sessions: !args.includes("--stateless"),
    ...(portIndex >= 0 && args[portIndex + 1] ? { port: Number(args[portIndex + 1]) } : {}),
  });
  process.stdout.write(`stub MCP listening on ${stub.url}\n`);
  const stop = (): void => void stub.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
