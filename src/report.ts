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
