/**
 * Stub MCP surface used by the harness's own tests and by `examples/stub.suite.yaml`.
 *
 * Deterministic by construction: the same input always yields the same output, so golden
 * fixtures captured against it never drift. It exposes a JobScout-shaped surface
 * (`search_jobs`, `get_listing`) plus intentional failure paths:
 *
 * - `search_jobs` with `limit > 100` is rejected by the input schema. SDK 2.x reports input
 *   validation failures as a tool result with `isError: true`, not as a JSON-RPC error.
 * - `get_listing` with an unknown `id` returns a tool result with `isError: true`.
 * - Calling a tool that is not registered is a protocol-level failure, which the SDK reports
 *   as JSON-RPC error `INVALID_PARAMS` (-32602). The suite uses that for the `error_code` path.
 *
 * It also registers one prompt (`search_brief`) and one static resource
 * (`stub://listings/index`), so listing contracts for prompts and resources have a target.
 * Pass `toolsOnly` (stdio: `--tools-only`) to register tools alone: the server then advertises neither the
 * prompts nor the resources capability, which exercises the "capability not advertised" path.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { CallToolResult } from "@modelcontextprotocol/server";

const listings = [
  { id: "job-001", title: "Staff Nurse", company: "Beaumont Hospital", location: "Dublin", remote: false, tags: ["nursing", "healthcare"] },
  { id: "job-002", title: "Practice Nurse", company: "Grafton Street Clinic", location: "Dublin", remote: false, tags: ["nursing", "primary-care"] },
  { id: "job-003", title: "Nurse Educator", company: "Trinity College Dublin", location: "Dublin", remote: true, tags: ["nursing", "education"] },
  { id: "job-004", title: "Senior TypeScript Engineer", company: "Astraeus Business Solutions", location: "Remote", remote: true, tags: ["typescript", "node"] },
  { id: "job-005", title: "Paediatric Nurse", company: "Children's Health Ireland", location: "Dublin", remote: false, tags: ["nursing", "paediatrics"] },
  { id: "job-006", title: "Community Nurse", company: "HSE", location: "Cork", remote: false, tags: ["nursing", "community"] },
] as const;

function ok(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function failure(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export interface StubOptions {
  /** Register tools only, so the prompts and resources capabilities are not advertised. */
  toolsOnly?: boolean;
}

export function createStubServer(options: StubOptions = {}): McpServer {
  const server = new McpServer({ name: "stub-mcp", version: "0.1.0" });

  server.registerTool(
    "search_jobs",
    {
      title: "Search jobs (stub)",
      description: "Deterministic keyword search over a fixed in-memory listing set.",
      inputSchema: z.object({
        query: z.string().trim().min(1).max(240),
        limit: z.number().int().min(1).max(100).default(25),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ query, limit }) => {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      const matches = listings.filter((job) => {
        const haystack = `${job.title} ${job.company} ${job.location} ${job.tags.join(" ")}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
      const jobs = matches.slice(0, limit).map((job) => ({ ...job, tags: [...job.tags] }));
      return ok({ query, limit, total: matches.length, jobs, generated_at: "2026-01-01T00:00:00.000Z" });
    },
  );

  server.registerTool(
    "get_listing",
    {
      title: "Get listing (stub)",
      description: "Fetch one listing by id. Unknown ids return an error result.",
      inputSchema: z.object({ id: z.string().trim().min(1).max(64) }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    ({ id }) => {
      const job = listings.find((entry) => entry.id === id);
      if (!job) {
        return failure(`Listing not found: ${id}`);
      }
      return ok({ ...job, tags: [...job.tags] });
    },
  );

  if (options.toolsOnly) {
    return server;
  }

  server.registerPrompt(
    "search_brief",
    {
      title: "Search brief (stub)",
      description: "Asks the model to run search_jobs for a role and summarise the results.",
      argsSchema: z.object({ role: z.string().max(240).optional() }),
    },
    ({ role }) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: `Run search_jobs for ${role ?? "the role I name"} and summarise the matches.` },
        },
      ],
    }),
  );

  server.registerResource(
    "listings-index",
    "stub://listings/index",
    { title: "Listing index (stub)", description: "Ids and titles of every stub listing.", mimeType: "application/json" },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(listings.map((job) => ({ id: job.id, title: job.title }))) }],
    }),
  );

  return server;
}
