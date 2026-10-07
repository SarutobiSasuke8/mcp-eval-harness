import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { SuiteReport } from "../src/types.js";

const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "..", "..");
const cli = join(repoRoot, "dist", "src", "cli.js");
const stub = join(repoRoot, "dist", "examples", "stub-mcp", "server.js");
const stubSuite = join(repoRoot, "examples", "stub.suite.yaml");

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

async function mcpEval(...args: string[]): Promise<CliRun> {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { cwd: repoRoot });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof failed.code === "number" ? failed.code : -1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

async function tempSuite(contracts: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-eval-"));
  const file = join(dir, "suite.yaml");
  const command = JSON.stringify([process.execPath, stub]);
  await writeFile(file, `version: 1\nname: temp\ntarget:\n  transport: stdio\n  command: ${command}\ncontracts:\n${contracts}`, "utf8");
  return { dir, file };
}

void describe("mcp-eval CLI", () => {
  void it("exits 0 when the stub suite passes and emits a JSON report", async () => {
    const result = await mcpEval(stubSuite, "--json");
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as SuiteReport;
    assert.equal(report.passed, true);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.total, 8);
    assert.deepEqual(report.goldens_updated, []);
  });

  void it("prints a readable human summary", async () => {
    const result = await mcpEval(stubSuite);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /PASS {2}tools_listed/);
    assert.match(result.stdout, /PASSED: 8\/8 contracts passed/);
  });

  void it("exits non-zero when an expected tool is missing", async () => {
    const { file } = await tempSuite(`  - name: tools\n    expect_tools: [search_jobs, get_listing, delete_everything]\n`);
    const result = await mcpEval(file, "--json");
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout) as SuiteReport;
    assert.equal(report.passed, false);
    assert.match(report.contracts[0]?.checks[0]?.message ?? "", /Missing tools: delete_everything/);
  });

  void it("exits non-zero on a golden mismatch and names the differing path", async () => {
    const { dir, file } = await tempSuite(
      `  - name: listing\n    tool: get_listing\n    input: { id: job-004 }\n    assert:\n      golden: listing.golden.json\n`,
    );
    await writeFile(join(dir, "listing.golden.json"), JSON.stringify({ id: "job-004", title: "Wrong Title", company: "Astraeus Business Solutions", location: "Remote", remote: true, tags: ["typescript", "node"] }), "utf8");
    const result = await mcpEval(file);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Golden mismatch/);
    assert.match(result.stdout, /\$\.title: expected "Wrong Title", got "Senior TypeScript Engineer"/);
  });

  void it("fails when a golden is missing and only writes it under --update-goldens", async () => {
    const { dir, file } = await tempSuite(
      `  - name: listing\n    tool: get_listing\n    input: { id: job-001 }\n    assert:\n      golden: fresh.golden.json\n`,
    );
    const missing = await mcpEval(file);
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /Golden fixture missing/);

    const updated = await mcpEval(file, "--update-goldens", "--json");
    assert.equal(updated.code, 0, updated.stderr || updated.stdout);
    const report = JSON.parse(updated.stdout) as SuiteReport;
    assert.equal(report.goldens_updated.length, 1);
    const written = JSON.parse(await readFile(join(dir, "fresh.golden.json"), "utf8")) as { id: string };
    assert.equal(written.id, "job-001");

    const rerun = await mcpEval(file);
    assert.equal(rerun.code, 0, rerun.stdout);
  });

  void it("asserts the deny path: isError with a message pattern", async () => {
    const { file } = await tempSuite(
      `  - name: deny\n    tool: search_jobs\n    input: { query: x, limit: 9999 }\n    assert:\n      is_error: true\n      error_message: "limit.*(100|Too big)"\n`,
    );
    const result = await mcpEval(file);
    assert.equal(result.code, 0, result.stdout);
  });

  void it("fails the deny assertion when the tool unexpectedly succeeds", async () => {
    const { file } = await tempSuite(
      `  - name: deny\n    tool: search_jobs\n    input: { query: nurse, limit: 5 }\n    assert:\n      is_error: true\n`,
    );
    const result = await mcpEval(file);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Expected isError: true, got a successful result/);
  });

  void it("treats an unexpected isError result as a failure", async () => {
    const { file } = await tempSuite(`  - name: unknown\n    tool: get_listing\n    input: { id: job-999 }\n`);
    const result = await mcpEval(file);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Tool returned isError: true: Listing not found/);
  });

  void it("asserts JSON-RPC error codes by name and by number", async () => {
    const { file } = await tempSuite(
      `  - name: by_name\n    tool: nope\n    input: {}\n    assert:\n      error_code: INVALID_PARAMS\n` +
        `  - name: by_number\n    tool: nope\n    input: {}\n    assert:\n      error_code: -32602\n` +
        `  - name: wrong_code\n    tool: nope\n    input: {}\n    assert:\n      error_code: INTERNAL_ERROR\n`,
    );
    const result = await mcpEval(file, "--json");
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout) as SuiteReport;
    assert.deepEqual(report.contracts.map((c) => c.passed), [true, true, false]);
  });

  void it("fails result_schema validation when the payload does not match", async () => {
    const { dir, file } = await tempSuite(
      `  - name: schema\n    tool: get_listing\n    input: { id: job-001 }\n    assert:\n      result_schema: strict.schema.json\n`,
    );
    await writeFile(join(dir, "strict.schema.json"), JSON.stringify({ type: "object", required: ["id", "salary"] }), "utf8");
    const result = await mcpEval(file);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /must have required property 'salary'/);
  });

  void it("exits 2 on an invalid suite file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-eval-"));
    const file = join(dir, "bad.yaml");
    await writeFile(file, "version: 2\ncontracts: []\n", "utf8");
    const result = await mcpEval(file);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Invalid suite/);
  });

  void it("exits 2 when the target cannot be started", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-eval-"));
    const file = join(dir, "suite.yaml");
    await writeFile(file, `version: 1\ntarget:\n  transport: stdio\n  command: [${JSON.stringify(process.execPath)}, "does-not-exist.js"]\ncontracts:\n  - name: t\n    expect_tools: [x]\n`, "utf8");
    const result = await mcpEval(file);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Could not connect to target/);
  });

  void it("exits 2 with usage when no suite is given", async () => {
    const result = await mcpEval();
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Usage: mcp-eval/);
  });
});
