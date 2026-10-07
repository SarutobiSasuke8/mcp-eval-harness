import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import type { Transport } from "@modelcontextprotocol/client";
import type { Target } from "./types.js";

export interface ConnectedTarget {
  client: Client;
  close: () => Promise<void>;
}

function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function buildTransport(target: Target, baseDir: string): Transport {
  if (target.transport === "stdio") {
    const [command, ...args] = target.command;
    if (!command) {
      throw new Error("stdio target needs a command");
    }
    return new StdioClientTransport({
      command,
      args,
      cwd: target.cwd ?? baseDir,
      ...(target.env ? { env: { ...inheritedEnv(), ...target.env } } : {}),
      stderr: "pipe",
    });
  }
  return new StreamableHTTPClientTransport(new URL(target.url), {
    ...(target.headers ? { requestInit: { headers: target.headers } } : {}),
  });
}

/**
 * Wraps the official SDK client. The harness never speaks raw JSON-RPC: every call goes
 * through `Client`, so protocol handling and version negotiation stay with the SDK.
 */
export async function connectTarget(target: Target, baseDir: string, timeoutMs: number): Promise<ConnectedTarget> {
  const client = new Client({ name: "mcp-eval", version: "0.1.0" });
  const transport = buildTransport(target, baseDir);
  const stderrChunks: string[] = [];
  if (transport instanceof StdioClientTransport && transport.stderr) {
    transport.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });
  }
  try {
    await client.connect(transport, { timeout: timeoutMs });
  } catch (error) {
    const stderr = stderrChunks.join("").trim();
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not connect to target: ${detail}${stderr ? `\n--- target stderr ---\n${stderr}` : ""}`);
  }
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}
