import type { RunReport, SuiteOutcome, SuiteReport } from "./types.js";

function indent(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}

export function formatHuman(report: SuiteReport): string {
  const lines: string[] = [];
  const targetLabel = report.target.transport === "stdio" ? report.target.command.join(" ") : report.target.url;
  lines.push(`mcp-eval: ${report.suite}`);
  lines.push(`target: ${report.target.transport} ${targetLabel}`);
  lines.push("");
  for (const contract of report.contracts) {
    lines.push(`${contract.passed ? "PASS" : "FAIL"}  ${contract.name} (${contract.duration_ms} ms)`);
    for (const check of contract.checks) {
      const marker = check.passed ? "ok" : "failed";
      const message = check.message ? `: ${check.message}` : "";
      lines.push(indent(`${marker}  ${check.check}${message}`, "      "));
    }
  }
  lines.push("");
  if (report.goldens_updated.length > 0) {
    lines.push(`goldens updated: ${report.goldens_updated.join(", ")}`);
  }
  const { total, passed, failed } = report.summary;
  lines.push(`${report.passed ? "PASSED" : "FAILED"}: ${passed}/${total} contracts passed, ${failed} failed (${report.duration_ms} ms)`);
  return lines.join("\n");
}

export function formatJson(report: SuiteReport): string {
  return JSON.stringify(report, null, 2);
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/** Markdown summary for a CI job summary (for example `$GITHUB_STEP_SUMMARY`). */
export function formatMarkdown(report: SuiteReport): string {
  const { total, passed, failed } = report.summary;
  const lines: string[] = [];
  lines.push(`### mcp-eval: ${report.suite} ${report.passed ? "passed" : "FAILED"}`);
  lines.push("");
  lines.push(`${passed}/${total} contracts passed, ${failed} failed (${report.duration_ms} ms). Target: \`${report.target.transport}\`.`);
  lines.push("");
  lines.push("| Result | Contract | Checks |");
  lines.push("| --- | --- | --- |");
  for (const contract of report.contracts) {
    const checks = contract.checks
      .map((check) => `${check.passed ? "ok" : "**failed**"} ${check.check}${check.passed || !check.message ? "" : `: ${check.message}`}`)
      .join("\n");
    lines.push(`| ${contract.passed ? "PASS" : "**FAIL**"} | ${escapeCell(contract.name)} | ${escapeCell(checks)} |`);
  }
  if (report.goldens_updated.length > 0) {
    lines.push("");
    lines.push(`Goldens updated: ${report.goldens_updated.map((g) => `\`${g}\``).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Markdown block for a usage or configuration error (exit code 2), when no report exists. */
export function formatMarkdownError(suitePath: string, message: string): string {
  return [`### mcp-eval: ${suitePath} could not run (exit 2)`, "", "Usage, configuration or target error:", "", "```", message, "```", ""].join("\n");
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? "";
}

function outcomeLabel(outcome: SuiteOutcome): string {
  return outcome.exit_code === 0 ? "PASS" : outcome.exit_code === 1 ? "FAIL" : "ERROR";
}

function outcomeDetail(outcome: SuiteOutcome): string {
  if (!outcome.report) {
    return `could not run (exit 2): ${firstLine(outcome.error ?? "unknown error")}`;
  }
  const { total, passed } = outcome.report.summary;
  const failedNames = outcome.report.contracts.filter((contract) => !contract.passed).map((contract) => contract.name);
  return `${passed}/${total} contracts passed${failedNames.length > 0 ? `; failed: ${failedNames.join(", ")}` : ""}`;
}

/**
 * Run summary printed after the per-suite blocks of a multi-suite run: one line per suite, in the
 * order the suites were given, with its timing, then the totals.
 */
export function formatRunHuman(run: RunReport): string {
  const lines: string[] = [];
  lines.push(`mcp-eval run: ${run.summary.suites} suites, concurrency ${run.concurrency}`);
  for (const outcome of run.suites) {
    const name = outcome.report?.suite ?? outcome.path;
    lines.push(`  ${outcomeLabel(outcome).padEnd(5)}  ${name} (${outcome.duration_ms} ms): ${outcomeDetail(outcome)}`);
  }
  const { suites, passed, failed, errored, contracts } = run.summary;
  lines.push(
    `${run.passed ? "PASSED" : "FAILED"}: ${passed}/${suites} suites passed, ${failed} failed, ${errored} could not run; ` +
      `${contracts.passed}/${contracts.total} contracts passed (${run.duration_ms} ms wall clock, exit ${run.exit_code})`,
  );
  return lines.join("\n");
}

export function formatRunJson(run: RunReport): string {
  return JSON.stringify(run, null, 2);
}

/** Markdown for a multi-suite run: a suite table first, then each suite's own block in order. */
export function formatRunMarkdown(run: RunReport): string {
  const { suites, passed, failed, errored, contracts } = run.summary;
  const lines: string[] = [];
  lines.push(`## mcp-eval run ${run.passed ? "passed" : "FAILED"}`);
  lines.push("");
  lines.push(
    `${passed}/${suites} suites passed, ${failed} failed, ${errored} could not run; ${contracts.passed}/${contracts.total} contracts passed ` +
      `(${run.duration_ms} ms wall clock, concurrency ${run.concurrency}, exit ${run.exit_code}).`,
  );
  lines.push("");
  lines.push("| Result | Suite | Time | Detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const outcome of run.suites) {
    const label = outcomeLabel(outcome);
    const result = outcome.exit_code === 0 ? label : `**${label}**`;
    lines.push(`| ${result} | ${escapeCell(outcome.report?.suite ?? outcome.path)} | ${outcome.duration_ms} ms | ${escapeCell(outcomeDetail(outcome))} |`);
  }
  lines.push("");
  const blocks = run.suites.map((outcome) => (outcome.report ? formatMarkdown(outcome.report) : formatMarkdownError(outcome.path, outcome.error ?? "unknown error")));
  return `${lines.join("\n")}\n${blocks.join("\n")}`;
}
