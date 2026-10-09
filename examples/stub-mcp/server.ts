#!/usr/bin/env node
/**
 * Stdio entry for the stub MCP (see `stub.ts` for the surface). `--tools-only` registers tools
 * alone, so the prompts and resources capabilities are not advertised.
 */
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { createStubServer } from "./stub.js";

const server = createStubServer({ toolsOnly: process.argv.includes("--tools-only") });
await server.connect(new StdioServerTransport(process.stdin, process.stdout));
process.on("SIGINT", () => void server.close());
process.on("SIGTERM", () => void server.close());
