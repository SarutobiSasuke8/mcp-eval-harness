import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

import type { RunReport, SuiteReport } from "../src/types.js";

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

/** Writes a one-off suite against the stdio stub. `delayMs` holds the server back before it connects. */
async function suite(name: string, contracts: string, delayMs = 0): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcp-eval-par-"));
  const file = join(dir, `${name}.suite.yaml`);
  const command = JSON.stringify([process.execPath, stub, ...(delayMs > 0 ? [`--startup-delay-ms=${delayMs}`] : [])]);
  await writeFile(file, `version: 1\nname: ${name}\ntarget:\n  transport: stdio\n  command: ${command}\ncontracts:\n${contracts}`, "utf8");
  return file;
}

const PASSING = `  - name: tools
    expect_tools: [search_jobs, get_listing]
    exact: true
  - name: listing
    tool: get_listing
    input: { id: job-004 }
`;

const FAILING = `  - name: tools_ok
    expect_tools: [search_jobs]
  - name: tools_missing
    expect_tools: [search_jobs, delete_everything]
`;

void describe("mcp-eval --concurrency", () => {
  void it("keeps input order when a slow first suite finishes last, and really overlaps", async () => {
    const slow = await suite("slow", PASSING, 1500);
    const fast = await suite("fast", PASSING);
    const result = await mcpEval(slow, fast, "--concurrency", "2", "--json");
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as RunReport;
    assert.equal(report.concurrency, 2);
    assert.deepEqual(report.suites.map((s) => s.report?.suite), ["slow", "fast"]);
    const [slowOutcome, fastOutcome] = report.suites;
    assert.ok(slowOutcome && fastOutcome);
    assert.ok(slowOutcome.duration_ms > fastOutcome.duration_ms, `slow ${slowOutcome.duration_ms} ms, fast ${fastOutcome.duration_ms} ms`);
    // Sequential runs take at least the sum of the suite durations; overlapping runs take less.
    assert.ok(report.duration_ms < slowOutcome.duration_ms + fastOutcome.duration_ms, `wall ${report.duration_ms} ms`);
  });

  void it("prints human blocks in input order, then a per-suite timing summary", async () => {
    const slow = await suite("alpha", PASSING, 1000);
    const fast = await suite("bravo", PASSING);
    const result = await mcpEval(slow, fast, "--concurrency", "2");
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const alpha = result.stdout.indexOf("mcp-eval: alpha");
    const bravo = result.stdout.indexOf("mcp-eval: bravo");
    const summary = result.stdout.indexOf("mcp-eval run: 2 suites, concurrency 2");
    assert.ok(alpha >= 0 && bravo > alpha && summary > bravo, result.stdout);
    assert.match(result.stdout, /\n {2}PASS {3}alpha \(\d+ ms\): 2\/2 contracts passed\n {2}PASS {3}bravo \(\d+ ms\): 2\/2 contracts passed\n/);
    assert.match(result.stdout, /PASSED: 2\/2 suites passed, 0 failed, 0 could not run; 4\/4 contracts passed \(\d+ ms wall clock, exit 0\)/);
  });

  void it("exits 1 for a failing suite among passing ones and names it in the summary", async () => {
    const first = await suite("first", PASSING);
    const broken = await suite("broken", FAILING, 300);
    const last = await suite("last", PASSING);
    const result = await mcpEval(first, broken, last, "--concurrency", "3", "--json");
    assert.equal(result.code, 1, result.stderr);
    const report = JSON.parse(result.stdout) as RunReport;
    assert.equal(report.passed, false);
    assert.equal(report.exit_code, 1);
    assert.deepEqual(report.suites.map((s) => [s.report?.suite, s.exit_code]), [["first", 0], ["broken", 1], ["last", 0]]);
    assert.deepEqual(report.summary, { suites: 3, passed: 2, failed: 1, errored: 0, contracts: { total: 6, passed: 5, failed: 1 } });
    assert.deepEqual(report.suites[1]?.report?.contracts.map((c) => c.passed), [true, false]);

    const human = await mcpEval(first, broken, last, "--concurrency", "3");
    assert.equal(human.code, 1);
    assert.match(human.stdout, / {2}FAIL {3}broken \(\d+ ms\): 1\/2 contracts passed; failed: tools_missing/);
    assert.match(human.stdout, /FAILED: 2\/3 suites passed, 1 failed, 0 could not run; 5\/6 contracts passed/);
  });

  void it("gives the same result with concurrency 1 and concurrency 3", async () => {
    const files = [await suite("one", PASSING, 400), await suite("two", FAILING), await suite("three", PASSING)];
    const strip = (r: RunReport): unknown =>
      r.suites.map((s) => ({ suite: s.report?.suite, exit: s.exit_code, contracts: s.report?.contracts.map((c) => ({ name: c.name, passed: c.passed, checks: c.checks })) }));
    const serial = JSON.parse((await mcpEval(...files, "--json")).stdout) as RunReport;
    const parallel = JSON.parse((await mcpEval(...files, "--json", "--concurrency", "3")).stdout) as RunReport;
    assert.equal(serial.concurrency, 1);
    assert.deepEqual(strip(parallel), strip(serial));
  });

  void it("exits 2 when one suite cannot run, still reporting the others", async () => {
    const good = await suite("good", PASSING);
    const failing = await suite("failing", FAILING);
    const dir = await mkdtemp(join(tmpdir(), "mcp-eval-par-"));
    const invalid = join(dir, "invalid.yaml");
    await writeFile(invalid, "version: 2\ncontracts: []\n", "utf8");
    const result = await mcpEval(good, invalid, failing, "--concurrency", "2", "--json");
    assert.equal(result.code, 2, result.stdout);
    assert.match(result.stderr, /invalid\.yaml: Invalid suite/);
    const report = JSON.parse(result.stdout) as RunReport;
    assert.deepEqual(report.suites.map((s) => s.exit_code), [0, 2, 1]);
    assert.equal(report.suites[1]?.report, undefined);
    assert.match(report.suites[1]?.error ?? "", /Invalid suite/);
    assert.equal(report.summary.errored, 1);
  });

  void it("writes a run report and a Markdown summary with a suite table", async () => {
    const pass = await suite("pass", PASSING);
    const fail = await suite("fail", FAILING);
    const dir = await mkdtemp(join(tmpdir(), "mcp-eval-par-"));
    const reportFile = join(dir, "report.json");
    const summaryFile = join(dir, "summary.md");
    const result = await mcpEval(pass, fail, "--concurrency", "2", "--report", reportFile, "--summary", summaryFile);
    assert.equal(result.code, 1);
    const report = JSON.parse(await readFile(reportFile, "utf8")) as RunReport;
    assert.equal(report.suites.length, 2);
    const summary = await readFile(summaryFile, "utf8");
    assert.match(summary, /^## mcp-eval run FAILED\n/);
    assert.match(summary, /\| PASS \| pass \| \d+ ms \| 2\/2 contracts passed \|/);
    assert.match(summary, /\| \*\*FAIL\*\* \| fail \| \d+ ms \| 1\/2 contracts passed; failed: tools_missing \|/);
    assert.ok(summary.indexOf("### mcp-eval: pass passed") < summary.indexOf("### mcp-eval: fail FAILED"));
  });

  void it("keeps the single-suite report shape when one suite is given with --concurrency", async () => {
    const result = await mcpEval(stubSuite, "--concurrency", "4", "--json");
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout) as SuiteReport;
    assert.equal(report.suite, "stub-mcp");
    assert.equal(report.summary.total, 10);
  });

  void it("rejects a bad --concurrency value and --update-goldens with concurrency above 1", async () => {
    for (const bad of ["0", "-1", "two", "1.5"]) {
      const result = await mcpEval(stubSuite, `--concurrency=${bad}`);
      assert.equal(result.code, 2, bad);
      assert.match(result.stderr, /--concurrency must be a whole number of 1 or more/);
    }
    const goldens = await mcpEval(stubSuite, stubSuite, "--concurrency", "2", "--update-goldens");
    assert.equal(goldens.code, 2);
    assert.match(goldens.stderr, /--update-goldens .* --concurrency 1 only/);
  });
});
