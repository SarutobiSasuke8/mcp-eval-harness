#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { formatHuman, formatJson, formatMarkdown, formatMarkdownError } from "./report.js";
import { runSuite } from "./runner.js";
import { loadSuite } from "./suite.js";

import type { SuiteReport } from "./types.js";

export const EXIT_PASS = 0;
export const EXIT_FAIL = 1;
export const EXIT_USAGE = 2;

const USAGE = `Usage: mcp-eval <suite.yaml|suite.json> [options]

Runs contract checks and golden fixture compares against an MCP server and exits
non-zero on any failure, so it can gate publish in CI or a local verify step.

Options:
  --json             Print the full report as JSON instead of the human summary
  --update-goldens   Rewrite golden fixtures from the current results (explicit opt-in)
  --base-dir <dir>   Resolve fixture paths against this directory (default: suite file's directory)
  --report <file>    Also write the full JSON report to this file
  --summary <file>   Append a Markdown summary to this file (for example $GITHUB_STEP_SUMMARY)
  -h, --help         Show this help

Exit codes:
  0  every contract passed
  1  at least one contract failed
  2  usage or configuration error (bad suite, unreachable or refused target,
     connection timeout, HTTP 401 or other transport failure while connecting)
`;

const CLI_OPTIONS = {
  json: { type: "boolean", default: false },
  "update-goldens": { type: "boolean", default: false },
  "base-dir": { type: "string" },
  report: { type: "string" },
  summary: { type: "string" },
  help: { type: "boolean", short: "h", default: false },
} as const;

export async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof CLI_OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, options: CLI_OPTIONS, allowPositionals: true });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return EXIT_USAGE;
  }
  if (parsed.values.help) {
    process.stdout.write(USAGE);
    return EXIT_PASS;
  }
  const suitePath = parsed.positionals[0];
  if (!suitePath || parsed.positionals.length !== 1) {
    process.stderr.write(USAGE);
    return EXIT_USAGE;
  }

  let report: SuiteReport;
  try {
    const loaded = await loadSuite(suitePath);
    report = await runSuite(loaded, {
      updateGoldens: parsed.values["update-goldens"] === true,
      ...(parsed.values["base-dir"] ? { baseDir: parsed.values["base-dir"] } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mcp-eval: ${message}\n`);
    if (parsed.values.summary) {
      await writeOutput(parsed.values.summary, formatMarkdownError(suitePath, message), "append");
    }
    return EXIT_USAGE;
  }

  process.stdout.write(`${parsed.values.json ? formatJson(report) : formatHuman(report)}\n`);
  if (parsed.values.report) {
    await writeOutput(parsed.values.report, `${formatJson(report)}\n`, "write");
  }
  if (parsed.values.summary) {
    await writeOutput(parsed.values.summary, formatMarkdown(report), "append");
  }
  return report.passed ? EXIT_PASS : EXIT_FAIL;
}

async function writeOutput(path: string, content: string, mode: "write" | "append"): Promise<void> {
  const file = resolve(path);
  await mkdir(dirname(file), { recursive: true });
  await (mode === "append" ? appendFile(file, content, "utf8") : writeFile(file, content, "utf8"));
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`mcp-eval: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = EXIT_USAGE;
    });
}
