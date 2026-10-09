#!/usr/bin/env node
/**
 * Exercises the composite action in action.yml locally, without GitHub Actions.
 *
 * It parses action.yml and runs each `run:` step with bash the way the runner does: inputs and
 * `github.action_path` substituted, step `env` applied, `working-directory` honoured, and
 * GITHUB_STEP_SUMMARY and GITHUB_OUTPUT pointed at temporary files. `uses:` steps
 * (actions/setup-node) are reported and skipped; the Node running this script stands in.
 *
 * Scenarios: the stub suite (expect exit 0), a suite with a missing tool (expect 1) and an
 * invalid suite (expect 2). The first scenario also runs the "Build mcp-eval" step, which is
 * `npm ci` in this checkout.
 *
 * Usage: npm run action:local   (set MCP_EVAL_BASH to choose a bash binary)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const action = parse(readFileSync(join(repoRoot, "action.yml"), "utf8"));

function findBash() {
  if (process.env.MCP_EVAL_BASH) return process.env.MCP_EVAL_BASH;
  if (process.platform !== "win32") return "bash";
  // On Windows, use Git for Windows' bash rather than the WSL launcher in System32.
  const execPath = execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim();
  const candidate = resolve(execPath, "..", "..", "..", "bin", "bash.exe");
  if (!existsSync(candidate)) throw new Error(`Git bash not found at ${candidate}; set MCP_EVAL_BASH`);
  return candidate;
}

const bash = findBash();

function substitute(text, inputs) {
  return String(text)
    .replace(/\$\{\{\s*github\.action_path\s*\}\}/g, repoRoot.replace(/\\/g, "/"))
    .replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (_, name) => inputs[name] ?? "")
    .replace(/\$\{\{\s*steps\.[^}]*\}\}/g, "");
}

function evaluateIf(condition, inputs) {
  if (condition === undefined) return true;
  const match = /^inputs\.([\w-]+)\s*!=\s*''$/.exec(String(condition).trim());
  if (!match) throw new Error(`Unsupported if: ${condition}`);
  return (inputs[match[1]] ?? "") !== "";
}

function runAction(given, { runBuildStep }) {
  const inputs = {};
  for (const [name, spec] of Object.entries(action.inputs)) {
    inputs[name] = given[name] ?? spec.default ?? "";
    if (spec.required && !inputs[name]) throw new Error(`Missing required input ${name}`);
  }
  const temp = mkdtempSync(join(tmpdir(), "mcp-eval-action-"));
  const summary = join(temp, "step-summary.md");
  const output = join(temp, "output.txt");
  writeFileSync(summary, "");
  writeFileSync(output, "");
  let exitCode = 0;
  for (const step of action.runs.steps) {
    const label = step.name ?? step.uses;
    if (!evaluateIf(step.if, inputs)) {
      console.log(`  - ${label}: skipped (if: ${step.if})`);
      continue;
    }
    if (step.uses) {
      console.log(`  - ${label}: skipped locally (uses: ${step.uses}; running on Node ${process.version})`);
      continue;
    }
    if (step.name === "Build mcp-eval" && !runBuildStep) {
      console.log(`  - ${label}: skipped in this scenario (ran in the first one)`);
      continue;
    }
    const cwd = resolve(repoRoot, substitute(step["working-directory"] ?? ".", inputs));
    const env = { ...process.env, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: output };
    for (const [key, value] of Object.entries(step.env ?? {})) env[key] = substitute(value, inputs);
    const script = substitute(step.run, inputs);
    console.log(`  - ${label}: bash in ${cwd}`);
    const result = spawnSync(bash, ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd, env, stdio: "inherit" });
    exitCode = result.status ?? 1;
    if (exitCode !== 0) {
      console.log(`    step exited ${exitCode}; later steps skipped, as on a runner`);
      break;
    }
  }
  return { exitCode, summary: readFileSync(summary, "utf8"), output: readFileSync(output, "utf8"), temp };
}

const failingDir = mkdtempSync(join(tmpdir(), "mcp-eval-action-suite-"));
const stubServer = join(repoRoot, "dist", "examples", "stub-mcp", "server.js").replace(/\\/g, "/");
writeFileSync(
  join(failingDir, "failing.suite.yaml"),
  `version: 1\nname: failing-on-purpose\ntarget:\n  transport: stdio\n  command: ["node", "${stubServer}"]\ncontracts:\n  - name: tools\n    expect_tools: [search_jobs, delete_everything]\n`,
);
writeFileSync(join(failingDir, "invalid.suite.yaml"), "version: 2\ncontracts: []\n");

const scenarios = [
  { label: "stub suite passes", inputs: { suite: "examples/stub.suite.yaml" }, expect: 0, runBuildStep: true, summary: /### mcp-eval: stub-mcp passed/ },
  {
    label: "missing tool fails the job",
    inputs: { suite: "failing.suite.yaml", "working-directory": failingDir, "report-path": "out/report.json" },
    expect: 1,
    summary: /### mcp-eval: failing-on-purpose FAILED[\s\S]*Missing tools: delete_everything/,
  },
  { label: "invalid suite is exit 2", inputs: { suite: "invalid.suite.yaml", "working-directory": failingDir }, expect: 2, summary: /could not run \(exit 2\)/ },
];

let failures = 0;
for (const scenario of scenarios) {
  console.log(`\nScenario: ${scenario.label}`);
  const result = runAction(scenario.inputs, { runBuildStep: scenario.runBuildStep === true });
  const reportPath = resolve(repoRoot, scenario.inputs["working-directory"] ?? ".", scenario.inputs["report-path"] ?? action.inputs["report-path"].default);
  const checks = [
    [`exit code ${result.exitCode} (expected ${scenario.expect})`, result.exitCode === scenario.expect],
    [`GITHUB_OUTPUT has exit-code=${scenario.expect}`, result.output.includes(`exit-code=${scenario.expect}`)],
    [`job summary matches ${scenario.summary}`, scenario.summary.test(result.summary)],
    [scenario.expect === 2 ? "no JSON report on exit 2" : `JSON report written to ${reportPath}`, scenario.expect === 2 ? true : existsSync(reportPath)],
  ];
  for (const [text, ok] of checks) {
    console.log(`    ${ok ? "ok" : "FAILED"}  ${text}`);
    if (!ok) failures += 1;
  }
  console.log("    job summary written:");
  console.log(result.summary.trim().split("\n").map((line) => `      | ${line}`).join("\n"));
}

console.log(failures === 0 ? "\naction.yml exercised locally: all scenarios behaved as expected" : `\naction.yml exercised locally: ${failures} check(s) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
