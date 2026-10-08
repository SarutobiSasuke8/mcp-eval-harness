import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Ajv } from "ajv";

import { diff, normalise } from "./golden.js";
import { connectTarget } from "./target.js";

import type { Client, Tool } from "@modelcontextprotocol/client";
import type { Json } from "./golden.js";
import type { LoadedSuite } from "./suite.js";
import type { Assertion, CheckResult, Contract, ContractResult, GoldenOptions, RunOptions, SuiteReport } from "./types.js";

/** JSON-RPC error codes accepted by name in `assert.error_code`. */
export const ERROR_CODES: Record<string, number> = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
};

interface CallOutcome {
  kind: "result" | "rpc_error" | "thrown";
  result?: { isError: boolean; payload: Json; text: string };
  error?: { code?: number | undefined; message: string };
}

interface RunContext {
  client: Client;
  baseDir: string;
  updateGoldens: boolean;
  goldensUpdated: string[];
  /** Per-request timeout from the suite's `timeout_ms`, passed to every SDK call. */
  timeoutMs: number;
  toolsCache?: Tool[];
}

function resolveFixture(baseDir: string, path: string): string {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

async function readJson(path: string): Promise<Json | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Json;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeJson(path: string, value: Json): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function listTools(ctx: RunContext): Promise<Tool[]> {
  if (!ctx.toolsCache) {
    const listed = await ctx.client.listTools(undefined, { timeout: ctx.timeoutMs });
    ctx.toolsCache = listed.tools;
  }
  return ctx.toolsCache;
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => (block && typeof block === "object" && (block as { type?: string }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

async function callTool(ctx: RunContext, tool: string, input: Record<string, unknown>): Promise<CallOutcome> {
  try {
    const result = await ctx.client.callTool({ name: tool, arguments: input }, { timeout: ctx.timeoutMs });
    const text = extractText(result.content);
    let payload: Json;
    if (result.structuredContent !== undefined) {
      payload = toJson(result.structuredContent);
    } else {
      try {
        payload = JSON.parse(text) as Json;
      } catch {
        payload = toJson({ content: result.content });
      }
    }
    return { kind: "result", result: { isError: result.isError === true, payload, text } };
  } catch (error) {
    const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : undefined;
    const message = error instanceof Error ? error.message : String(error);
    return { kind: code === undefined ? "thrown" : "rpc_error", error: { code, message } };
  }
}

function expectedErrorCode(value: number | string): number {
  if (typeof value === "number") {
    return value;
  }
  const named = ERROR_CODES[value.toUpperCase()];
  if (named === undefined) {
    throw new Error(`Unknown error code name "${value}". Known names: ${Object.keys(ERROR_CODES).join(", ")}`);
  }
  return named;
}

function goldenOptions(golden: string | GoldenOptions): GoldenOptions {
  return typeof golden === "string" ? { path: golden } : golden;
}

async function compareGolden(ctx: RunContext, label: string, fixturePath: string, actual: Json, options: GoldenOptions): Promise<CheckResult> {
  const file = resolveFixture(ctx.baseDir, fixturePath);
  const shown = relative(process.cwd(), file) || file;
  const normalisedActual = normalise(actual, { ignore_paths: options.ignore_paths, only_paths: options.only_paths });
  const existing = await readJson(file);
  if (ctx.updateGoldens || existing === undefined) {
    if (!ctx.updateGoldens) {
      return { check: label, passed: false, message: `Golden fixture missing: ${shown}. Run with --update-goldens to create it.` };
    }
    await writeJson(file, normalisedActual);
    ctx.goldensUpdated.push(shown);
    return { check: label, passed: true, message: `Golden written: ${shown}` };
  }
  const normalisedExpected = normalise(existing, { ignore_paths: options.ignore_paths, only_paths: options.only_paths });
  const differences = diff(normalisedExpected, normalisedActual);
  if (differences.length === 0) {
    return { check: label, passed: true, message: `Matches ${shown}` };
  }
  const preview = differences
    .slice(0, 10)
    .map((d) => `${d.path}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`)
    .join("\n");
  return {
    check: label,
    passed: false,
    message: `Golden mismatch against ${shown} (${differences.length} difference${differences.length === 1 ? "" : "s"}):\n${preview}`,
    details: differences,
  };
}

async function validateSchema(ctx: RunContext, schemaPath: string, payload: Json): Promise<CheckResult> {
  const file = resolveFixture(ctx.baseDir, schemaPath);
  const shown = relative(process.cwd(), file) || file;
  const schema = await readJson(file);
  if (schema === undefined) {
    return { check: "result_schema", passed: false, message: `Schema fixture missing: ${shown}` };
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema as object);
  if (validate(payload)) {
    return { check: "result_schema", passed: true, message: `Valid against ${shown}` };
  }
  const errors = (validate.errors ?? []).map((e) => `${e.instancePath || "$"} ${e.message ?? ""}`.trim());
  return { check: "result_schema", passed: false, message: `Result does not satisfy ${shown}:\n${errors.join("\n")}`, details: validate.errors };
}

function checkErrorExpectations(assertion: Assertion, outcome: CallOutcome): CheckResult[] {
  const checks: CheckResult[] = [];
  const wantsRpcError = assertion.error_code !== undefined;
  const wantsToolError = assertion.is_error === true;
  const regex = assertion.error_message ? new RegExp(assertion.error_message) : undefined;

  if (outcome.kind === "thrown") {
    checks.push({ check: "call", passed: false, message: `Call failed: ${outcome.error?.message ?? "unknown error"}` });
    return checks;
  }

  if (outcome.kind === "rpc_error") {
    const got = outcome.error?.code;
    if (wantsRpcError) {
      const expected = expectedErrorCode(assertion.error_code as number | string);
      checks.push(
        got === expected
          ? { check: "error_code", passed: true, message: `JSON-RPC error ${expected} as expected` }
          : { check: "error_code", passed: false, message: `Expected JSON-RPC error ${expected}, got ${got}: ${outcome.error?.message ?? ""}` },
      );
    } else {
      checks.push({ check: "call", passed: false, message: `Unexpected JSON-RPC error ${got}: ${outcome.error?.message ?? ""}` });
    }
    if (regex) {
      const message = outcome.error?.message ?? "";
      checks.push(
        regex.test(message)
          ? { check: "error_message", passed: true, message: `Error message matches /${assertion.error_message}/` }
          : { check: "error_message", passed: false, message: `Error message "${message}" does not match /${assertion.error_message}/` },
      );
    }
    if (wantsToolError) {
      checks.push({ check: "is_error", passed: false, message: "Expected a tool result with isError: true, got a JSON-RPC error instead" });
    }
    return checks;
  }

  const result = outcome.result;
  if (!result) {
    checks.push({ check: "call", passed: false, message: "No result returned" });
    return checks;
  }
  if (wantsRpcError) {
    const expected = expectedErrorCode(assertion.error_code as number | string);
    checks.push({ check: "error_code", passed: false, message: `Expected JSON-RPC error ${expected}, but the call succeeded${result.isError ? " with isError: true" : ""}` });
  }
  if (wantsToolError) {
    checks.push(
      result.isError
        ? { check: "is_error", passed: true, message: "Tool returned isError: true" }
        : { check: "is_error", passed: false, message: "Expected isError: true, got a successful result" },
    );
  } else if (result.isError && assertion.is_error !== false) {
    checks.push({ check: "call", passed: false, message: `Tool returned isError: true: ${result.text}` });
  }
  if (regex) {
    checks.push(
      regex.test(result.text)
        ? { check: "error_message", passed: true, message: `Error text matches /${assertion.error_message}/` }
        : { check: "error_message", passed: false, message: `Error text "${result.text}" does not match /${assertion.error_message}/` },
    );
  }
  return checks;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Compares an expected name set against what the server listed. Missing names always fail;
 * with `exact`, names the server lists that the contract does not are reported as unexpected
 * and fail too, so an unreviewed tool, prompt or resource cannot slip in silently.
 */
export function compareListing(check: string, noun: string, expected: string[], listed: string[], exact: boolean): CheckResult {
  const listedSet = new Set(listed);
  const expectedSet = new Set(expected);
  const missing = expected.filter((name) => !listedSet.has(name));
  const unexpected = exact ? [...listedSet].filter((name) => !expectedSet.has(name)) : [];
  if (missing.length === 0 && unexpected.length === 0) {
    return {
      check,
      passed: true,
      message: exact ? `Exactly the ${plural(expectedSet.size, `expected ${noun}`)} listed` : `All ${plural(expectedSet.size, `expected ${noun}`)} listed`,
    };
  }
  const parts: string[] = [];
  parts.push(`Missing ${noun}s: ${missing.length > 0 ? missing.join(", ") : "none"}`);
  if (exact) {
    parts.push(`Unexpected ${noun}s: ${unexpected.length > 0 ? unexpected.join(", ") : "none"}`);
  }
  parts.push(`(listed: ${[...listedSet].join(", ") || "none"})`);
  return { check, passed: false, message: parts.join("; ").replace("; (listed", " (listed"), details: { missing, unexpected } };
}

function capabilityMissing(check: string, capability: "prompts" | "resources"): CheckResult {
  return {
    check,
    passed: false,
    message: `Server does not advertise the ${capability} capability, so ${capability}/list cannot be checked`,
  };
}

async function runContract(ctx: RunContext, contract: Contract): Promise<ContractResult> {
  const started = performance.now();
  const checks: CheckResult[] = [];

  if (contract.expect_tools) {
    const tools = await listTools(ctx);
    checks.push(compareListing("expect_tools", "tool", contract.expect_tools, tools.map((tool) => tool.name), contract.exact));
  }

  if (contract.expect_prompts) {
    if (!ctx.client.getServerCapabilities()?.prompts) {
      checks.push(capabilityMissing("expect_prompts", "prompts"));
    } else {
      const listed = await ctx.client.listPrompts(undefined, { timeout: ctx.timeoutMs });
      checks.push(compareListing("expect_prompts", "prompt", contract.expect_prompts, listed.prompts.map((prompt) => prompt.name), contract.exact));
    }
  }

  if (contract.expect_resources) {
    if (!ctx.client.getServerCapabilities()?.resources) {
      checks.push(capabilityMissing("expect_resources", "resources"));
    } else {
      const listed = await ctx.client.listResources(undefined, { timeout: ctx.timeoutMs });
      checks.push(compareListing("expect_resources", "resource", contract.expect_resources, listed.resources.map((resource) => resource.uri), contract.exact));
    }
  }

  if (contract.input_schema) {
    const tools = await listTools(ctx);
    for (const [toolName, fixturePath] of Object.entries(contract.input_schema)) {
      const tool = tools.find((entry) => entry.name === toolName);
      if (!tool) {
        checks.push({ check: `input_schema:${toolName}`, passed: false, message: `Tool ${toolName} is not listed, so its input schema cannot be checked` });
        continue;
      }
      checks.push(await compareGolden(ctx, `input_schema:${toolName}`, fixturePath, toJson(tool.inputSchema), { path: fixturePath }));
    }
  }

  if (contract.tool) {
    const assertion = contract.assert ?? {};
    const outcome = await callTool(ctx, contract.tool, contract.input ?? {});
    checks.push(...checkErrorExpectations(assertion, outcome));
    const payload = outcome.kind === "result" ? outcome.result?.payload : undefined;
    if (assertion.result_schema) {
      checks.push(
        payload === undefined
          ? { check: "result_schema", passed: false, message: "No result payload to validate" }
          : await validateSchema(ctx, assertion.result_schema, payload),
      );
    }
    if (assertion.golden) {
      const options = goldenOptions(assertion.golden);
      checks.push(
        payload === undefined
          ? { check: "golden", passed: false, message: "No result payload to compare against the golden" }
          : await compareGolden(ctx, "golden", options.path, payload, options),
      );
    }
    if (checks.length === 0) {
      checks.push({ check: "call", passed: true, message: "Call succeeded" });
    }
  }

  return {
    name: contract.name,
    passed: checks.every((check) => check.passed),
    checks,
    duration_ms: Math.round(performance.now() - started),
  };
}

export async function runSuite(loaded: LoadedSuite, options: RunOptions = {}): Promise<SuiteReport> {
  const started = performance.now();
  const baseDir = options.baseDir ?? loaded.baseDir;
  const { suite } = loaded;
  const connected = await connectTarget(suite.target, baseDir, suite.timeout_ms);
  const ctx: RunContext = {
    client: connected.client,
    baseDir,
    updateGoldens: options.updateGoldens === true,
    goldensUpdated: [],
    timeoutMs: suite.timeout_ms,
  };
  const contracts: ContractResult[] = [];
  try {
    for (const contract of suite.contracts) {
      try {
        contracts.push(await runContract(ctx, contract));
      } catch (error) {
        contracts.push({
          name: contract.name,
          passed: false,
          checks: [{ check: "contract", passed: false, message: error instanceof Error ? error.message : String(error) }],
          duration_ms: 0,
        });
      }
    }
  } finally {
    await connected.close();
  }
  const passed = contracts.filter((c) => c.passed).length;
  return {
    suite: suite.name ?? loaded.file,
    file: loaded.file,
    target: suite.target,
    passed: passed === contracts.length,
    contracts,
    summary: { total: contracts.length, passed, failed: contracts.length - passed },
    goldens_updated: ctx.goldensUpdated,
    duration_ms: Math.round(performance.now() - started),
  };
}
