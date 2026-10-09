import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import { startHttpStub } from "../examples/stub-mcp/http-server.js";

import type { AddressInfo } from "node:net";
import type { HttpStub, HttpStubOptions } from "../examples/stub-mcp/http-server.js";
import type { SuiteReport } from "../src/types.js";

const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..", "..");
const cli = join(repoRoot, "dist", "src", "cli.js");

/** Synthetic bearer value for the header test. Not a credential. */
const SYNTHETIC_BEARER = "mcp-eval-test-bearer-not-a-secret";

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

async function mcpEval(...args: string[]): Promise<CliRun> {
  const started = performance.now();
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { cwd: repoRoot });
    return { code: 0, stdout, stderr, elapsedMs: performance.now() - started };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "", elapsedMs: performance.now() - started };
  }
}

const LISTING_AND_CALL_CONTRACTS = `  - name: tools
    expect_tools: [search_jobs, get_listing]
    exact: true
  - name: prompts
    expect_prompts: [search_brief]
  - name: listing
    tool: get_listing
    input: { id: job-004 }
    assert:
      golden: ${JSON.stringify(join(repoRoot, "fixtures", "stub", "get_listing.golden.json"))}
  - name: deny
    tool: get_listing
    input: { id: job-999 }
    assert:
      is_error: true
      error_message: "Listing not found"
`;

async function httpSuite(url: string, contracts: string, extra = ""): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-eval-http-"));
  const file = join(dir, "suite.yaml");
  await writeFile(file, `version: 1\nname: http-stub\n${extra}target:\n  transport: http\n  url: ${url}\ncontracts:\n${contracts}`, "utf8");
  return file;
}

async function withStub<T>(options: HttpStubOptions, fn: (stub: HttpStub) => Promise<T>): Promise<T> {
  const stub = await startHttpStub(options);
  try {
    return await fn(stub);
  } finally {
    await stub.close();
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

void describe("mcp-eval over Streamable HTTP", () => {
  void it("passes a suite against JSON responses (enableJsonResponse)", async () => {
    await withStub({ response: "json" }, async (stub) => {
      const file = await httpSuite(stub.url, LISTING_AND_CALL_CONTRACTS);
      const result = await mcpEval(file, "--json");
      assert.equal(result.code, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout) as SuiteReport;
      assert.equal(report.summary.passed, 4);
      const posts = stub.requests.filter((r) => r.method === "POST" && r.rpcMethod !== "notifications/initialized");
      assert.ok(posts.length >= 4);
      for (const post of posts) {
        assert.match(post.contentType ?? "", /^application\/json/, `${post.rpcMethod} answered with ${post.contentType}`);
      }
    });
  });

  void it("passes a suite against SSE-framed responses", async () => {
    await withStub({ response: "sse" }, async (stub) => {
      const file = await httpSuite(stub.url, LISTING_AND_CALL_CONTRACTS);
      const result = await mcpEval(file);
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /PASSED: 4\/4 contracts passed/);
      const calls = stub.requests.filter((r) => r.method === "POST" && (r.rpcMethod === "tools/call" || r.rpcMethod === "tools/list"));
      assert.ok(calls.length >= 3);
      for (const call of calls) {
        assert.match(call.contentType ?? "", /^text\/event-stream/, `${call.rpcMethod} answered with ${call.contentType}`);
      }
    });
  });

  void it("carries the issued session id on every request after initialise", async () => {
    await withStub({ response: "json", sessions: true }, async (stub) => {
      const file = await httpSuite(stub.url, LISTING_AND_CALL_CONTRACTS);
      const result = await mcpEval(file);
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(stub.issuedSessions.length, 1);
      const issued = stub.issuedSessions[0];
      const [initialise, ...rest] = stub.requests;
      assert.equal(initialise?.rpcMethod, "initialize");
      assert.equal(initialise?.sessionId, undefined);
      assert.ok(rest.length > 0);
      for (const request of rest) {
        assert.equal(request.sessionId, issued, `${request.method} ${request.rpcMethod ?? ""} carried ${request.sessionId}`);
      }
    });
  });

  void it("works against a stateless server that issues no session id", async () => {
    await withStub({ response: "json", sessions: false }, async (stub) => {
      const file = await httpSuite(stub.url, LISTING_AND_CALL_CONTRACTS);
      const result = await mcpEval(file);
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.equal(stub.issuedSessions.length, 0);
      assert.ok(stub.requests.every((r) => r.sessionId === undefined));
    });
  });

  void it("sends custom headers (bearer) from target.headers on every request", async () => {
    await withStub({ response: "json", bearer: SYNTHETIC_BEARER }, async (stub) => {
      const dir = await mkdtemp(join(tmpdir(), "mcp-eval-http-"));
      const file = join(dir, "suite.yaml");
      await writeFile(
        file,
        `version: 1\ntarget:\n  transport: http\n  url: ${stub.url}\n  headers:\n    Authorization: "Bearer ${SYNTHETIC_BEARER}"\ncontracts:\n${LISTING_AND_CALL_CONTRACTS}`,
        "utf8",
      );
      const result = await mcpEval(file);
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.ok(stub.requests.length > 0);
      assert.ok(stub.requests.every((r) => r.authorization === `Bearer ${SYNTHETIC_BEARER}` && r.status !== 401));
    });
  });

  void it("exits 2 when the server rejects a missing bearer with 401", async () => {
    await withStub({ response: "json", bearer: SYNTHETIC_BEARER }, async (stub) => {
      const file = await httpSuite(stub.url, `  - name: tools\n    expect_tools: [search_jobs]\n`);
      const result = await mcpEval(file);
      assert.equal(result.code, 2, result.stdout);
      assert.match(result.stderr, /Could not connect to target: .*unauthorised/);
      assert.equal(stub.requests[0]?.status, 401);
      assert.ok(result.elapsedMs < 15_000, `a 401 should fail fast, took ${Math.round(result.elapsedMs)} ms`);
    });
  });

  void it("exits 2 when the connection is refused", async () => {
    const port = await freePort();
    const file = await httpSuite(`http://127.0.0.1:${port}/mcp`, `  - name: tools\n    expect_tools: [search_jobs]\n`);
    const result = await mcpEval(file);
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stderr, /Could not connect to target: fetch failed/);
  });

  void it("exits 2 within timeout_ms when the server never answers", async () => {
    await withStub({ hang: true }, async (stub) => {
      const file = await httpSuite(stub.url, `  - name: tools\n    expect_tools: [search_jobs]\n`, "timeout_ms: 750\n");
      const result = await mcpEval(file);
      assert.equal(result.code, 2, result.stdout);
      assert.match(result.stderr, /Could not connect to target/);
      assert.match(result.stderr, /Could not connect to target: Request timed out/);
      assert.ok(result.elapsedMs < 15_000, `took ${Math.round(result.elapsedMs)} ms`);
      assert.equal(stub.requests[0]?.rpcMethod, "initialize");
    });
  });

  void it("writes --report JSON and appends a --summary Markdown table", async () => {
    await withStub({ response: "json" }, async (stub) => {
      const dir = await mkdtemp(join(tmpdir(), "mcp-eval-http-"));
      const file = await httpSuite(stub.url, `  - name: tools\n    expect_tools: [search_jobs]\n    exact: true\n`);
      const reportFile = join(dir, "out", "report.json");
      const summaryFile = join(dir, "summary.md");
      await writeFile(summaryFile, "existing line\n", "utf8");
      const result = await mcpEval(file, "--report", reportFile, "--summary", summaryFile);
      assert.equal(result.code, 1);
      const report = JSON.parse(await readFile(reportFile, "utf8")) as SuiteReport;
      assert.equal(report.passed, false);
      const summary = await readFile(summaryFile, "utf8");
      assert.match(summary, /^existing line\n### mcp-eval: http-stub FAILED/);
      assert.match(summary, /\| \*\*FAIL\*\* \| tools \| \*\*failed\*\* expect_tools: Missing tools: none; Unexpected tools: get_listing/);
    });
  });

  void it("appends an error block to --summary on exit 2", async () => {
    const port = await freePort();
    const dir = await mkdtemp(join(tmpdir(), "mcp-eval-http-"));
    const file = await httpSuite(`http://127.0.0.1:${port}/mcp`, `  - name: tools\n    expect_tools: [search_jobs]\n`);
    const summaryFile = join(dir, "summary.md");
    const result = await mcpEval(file, "--summary", summaryFile);
    assert.equal(result.code, 2);
    assert.match(await readFile(summaryFile, "utf8"), /could not run \(exit 2\)[\s\S]*Could not connect to target/);
  });
});
