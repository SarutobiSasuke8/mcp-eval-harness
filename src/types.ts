import { z } from "zod";

/**
 * Suite file shape (YAML or JSON). `version: 1` is the only supported version in v0.
 */
export const stdioTargetSchema = z.object({
  transport: z.literal("stdio"),
  command: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const httpTargetSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const targetSchema = z.discriminatedUnion("transport", [stdioTargetSchema, httpTargetSchema]);

export const goldenOptionsSchema = z.object({
  path: z.string().min(1),
  /** Dotted paths to drop before comparing, for example `generated_at` or `jobs[].posted_at`. */
  ignore_paths: z.array(z.string().min(1)).optional(),
  /** When set, only these paths are compared. Applied before `ignore_paths`. */
  only_paths: z.array(z.string().min(1)).optional(),
});

export const assertSchema = z.object({
  /** Path to a JSON Schema file validated against the tool's `structuredContent` (or parsed text content). */
  result_schema: z.string().min(1).optional(),
  /** Golden compare. A string is shorthand for `{ path }`. */
  golden: z.union([z.string().min(1), goldenOptionsSchema]).optional(),
  /** JSON-RPC error expected from the call. Accepts a numeric code or a named one such as `INVALID_PARAMS`. */
  error_code: z.union([z.number().int(), z.string().min(1)]).optional(),
  /** Expect the tool to return `isError: true`. */
  is_error: z.boolean().optional(),
  /** Regular expression that the error text (JSON-RPC message or error content) must match. */
  error_message: z.string().min(1).optional(),
});

export const contractSchema = z
  .object({
    name: z.string().min(1),
    /** Every listed tool must be present in `tools/list`. */
    expect_tools: z.array(z.string().min(1)).optional(),
    /** Every listed prompt name must be present in `prompts/list`. */
    expect_prompts: z.array(z.string().min(1)).optional(),
    /** Every listed resource URI must be present in `resources/list`. */
    expect_resources: z.array(z.string().min(1)).optional(),
    /**
     * When true, every listing key in this contract (`expect_tools`, `expect_prompts`,
     * `expect_resources`) also fails on names the server lists that the contract does not.
     */
    exact: z.boolean().default(false),
    /** Compare a listed tool's advertised `inputSchema` against a JSON Schema fixture, keyed by tool name. */
    input_schema: z.record(z.string().min(1), z.string().min(1)).optional(),
    /** Tool to call. */
    tool: z.string().min(1).optional(),
    input: z.record(z.string(), z.unknown()).optional(),
    assert: assertSchema.optional(),
  })
  .refine((contract) => contract.expect_tools || contract.expect_prompts || contract.expect_resources || contract.input_schema || contract.tool, {
    message: "A contract needs at least one of expect_tools, expect_prompts, expect_resources, input_schema or tool",
  });

export const suiteSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1).optional(),
  target: targetSchema,
  /** Per-call timeout in milliseconds. */
  timeout_ms: z.number().int().positive().default(30_000),
  contracts: z.array(contractSchema).min(1),
});

export type StdioTarget = z.infer<typeof stdioTargetSchema>;
export type HttpTarget = z.infer<typeof httpTargetSchema>;
export type Target = z.infer<typeof targetSchema>;
export type GoldenOptions = z.infer<typeof goldenOptionsSchema>;
export type Assertion = z.infer<typeof assertSchema>;
export type Contract = z.infer<typeof contractSchema>;
export type Suite = z.infer<typeof suiteSchema>;

export interface CheckResult {
  check: string;
  passed: boolean;
  message?: string;
  details?: unknown;
}

export interface ContractResult {
  name: string;
  passed: boolean;
  checks: CheckResult[];
  duration_ms: number;
}

export interface SuiteReport {
  suite: string;
  file: string;
  target: Target;
  passed: boolean;
  contracts: ContractResult[];
  summary: { total: number; passed: number; failed: number };
  goldens_updated: string[];
  duration_ms: number;
}

export interface RunOptions {
  updateGoldens?: boolean;
  /** Directory fixture paths are resolved against. Defaults to the suite file's directory. */
  baseDir?: string;
}

/** Exit codes, shared by a single suite and a multi-suite run. */
export type ExitCode = 0 | 1 | 2;

/** One suite's result inside a multi-suite run. `report` is absent when the suite never ran (exit 2). */
export interface SuiteOutcome {
  /** The suite path as given on the command line. */
  path: string;
  /** 0 every contract passed, 1 at least one contract failed, 2 the suite never ran. */
  exit_code: ExitCode;
  report?: SuiteReport;
  /** Usage, configuration or target error when `exit_code` is 2. */
  error?: string;
  duration_ms: number;
}

/** Report for a run over several suites, in the order the suites were given. */
export interface RunReport {
  passed: boolean;
  /** Highest suite exit code: 2 if any suite never ran, else 1 if any contract failed, else 0. */
  exit_code: ExitCode;
  concurrency: number;
  suites: SuiteOutcome[];
  summary: {
    suites: number;
    passed: number;
    failed: number;
    errored: number;
    contracts: { total: number; passed: number; failed: number };
  };
  /** Wall-clock time for the whole run. With concurrency above 1 this is less than the sum of suite durations. */
  duration_ms: number;
}

export interface RunSuitesOptions extends RunOptions {
  /** Maximum number of suites (each with its own server process or HTTP session) in flight. Default 1. */
  concurrency?: number;
  /**
   * Called once per suite, strictly in input order, as soon as that suite and every suite before
   * it have finished. Lets a caller stream output without losing deterministic ordering.
   */
  onOutcome?: (outcome: SuiteOutcome, index: number) => void;
}
