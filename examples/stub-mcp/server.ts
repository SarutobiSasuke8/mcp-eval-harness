#!/usr/bin/env node
/**
 * Stdio entry for the stub MCP (see `stub.ts` for the surface). `--tools-only` registers tools
 * alone, so the prompts and resources capabilities are not advertised. `--startup-delay-ms=<n>`
 * waits n milliseconds before connecting, which the concurrency tests use to make one suite
 * finish after another that started later.
 */
import { setTimeout as sleep } from "node:timers/promises";

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createStubServer } from "./stub.js";

const delayArg = process.argv.find((arg) => arg.startsWith("--startup-delay-ms="));
const startupDelayMs = delayArg ? Number(delayArg.slice("--startup-delay-ms=".length)) : 0;
if (Number.isFinite(startupDelayMs) && startupDelayMs > 0) {
  await sleep(startupDelayMs);
}

const server = createStubServer({ toolsOnly: process.argv.includes("--tools-only") });
await server.connect(new StdioServerTransport(process.stdin, process.stdout));
process.on("SIGINT", () => void server.close());
process.on("SIGTERM", () => void server.close());
