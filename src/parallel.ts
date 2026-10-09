import { runSuite } from "./runner.js";
import { loadSuite } from "./suite.js";

import type { ExitCode, RunReport, RunSuitesOptions, SuiteOutcome } from "./types.js";

/** Parses a `--concurrency` value. Only whole numbers from 1 upwards are accepted. */
export function parseConcurrency(value: string | number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  const text = String(value).trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`--concurrency must be a whole number of 1 or more, got "${text}"`);
  }
  return parsed;
}

/**
 * Runs `worker` over `items` with at most `concurrency` calls in flight and resolves with the
 * results in input order, whatever order they finish in.
 *
 * `onResult` is called once per item, strictly in input order: item i is reported as soon as
 * items 0..i have all finished. That keeps streamed output deterministic.
 *
 * Fail-fast: if a worker rejects, no further items are started and the returned promise rejects
 * with that error once the calls already in flight have settled.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onResult?: (result: R, index: number) => void,
): Promise<R[]> {
  const limit = parseConcurrency(concurrency);
  const results = new Array<R>(items.length);
  const finished = new Array<boolean>(items.length).fill(false);
  let nextToStart = 0;
  let nextToReport = 0;
  let failure: { error: unknown } | undefined;

  const flush = (): void => {
    while (nextToReport < items.length && finished[nextToReport]) {
      onResult?.(results[nextToReport] as R, nextToReport);
      nextToReport += 1;
    }
  };

  const lane = async (): Promise<void> => {
    while (failure === undefined && nextToStart < items.length) {
      const index = nextToStart;
      nextToStart += 1;
      try {
        results[index] = await worker(items[index] as T, index);
      } catch (error) {
        failure ??= { error };
        return;
      }
      finished[index] = true;
      flush();
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => lane()));
  if (failure !== undefined) {
    throw failure.error;
  }
  return results;
}

async function runOne(path: string, options: RunSuitesOptions): Promise<SuiteOutcome> {
  const started = performance.now();
  try {
    const loaded = await loadSuite(path);
    const report = await runSuite(loaded, {
      ...(options.updateGoldens !== undefined ? { updateGoldens: options.updateGoldens } : {}),
      ...(options.baseDir !== undefined ? { baseDir: options.baseDir } : {}),
    });
    return { path, exit_code: report.passed ? 0 : 1, report, duration_ms: Math.round(performance.now() - started) };
  } catch (error) {
    return {
      path,
      exit_code: 2,
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Math.round(performance.now() - started),
    };
  }
}

/**
 * Runs several suites, at most `concurrency` at a time. Each suite connects its own target, so a
 * stdio suite gets its own server process and an HTTP suite its own session. Contracts inside a
 * suite still run one after another over that suite's single connection.
 *
 * A suite that cannot load or connect is recorded with exit code 2 and does not stop the others.
 * Outcomes are returned (and passed to `onOutcome`) in the order the paths were given.
 */
export async function runSuites(paths: readonly string[], options: RunSuitesOptions = {}): Promise<RunReport> {
  const concurrency = parseConcurrency(options.concurrency);
  if (options.updateGoldens && concurrency > 1) {
    throw new Error("--update-goldens rewrites fixtures that suites may share, so it runs with --concurrency 1 only");
  }
  const started = performance.now();
  const suites = await mapWithConcurrency(paths, concurrency, (path) => runOne(path, options), options.onOutcome);
  const exitCode = Math.max(0, ...suites.map((outcome) => outcome.exit_code)) as ExitCode;
  const contracts = { total: 0, passed: 0, failed: 0 };
  for (const outcome of suites) {
    if (outcome.report) {
      contracts.total += outcome.report.summary.total;
      contracts.passed += outcome.report.summary.passed;
      contracts.failed += outcome.report.summary.failed;
    }
  }
  return {
    passed: exitCode === 0,
    exit_code: exitCode,
    concurrency,
    suites,
    summary: {
      suites: suites.length,
      passed: suites.filter((outcome) => outcome.exit_code === 0).length,
      failed: suites.filter((outcome) => outcome.exit_code === 1).length,
      errored: suites.filter((outcome) => outcome.exit_code === 2).length,
      contracts,
    },
    duration_ms: Math.round(performance.now() - started),
  };
}
