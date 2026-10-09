import type { SuiteReport } from "./types.js";

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
