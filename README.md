# mcp-eval-harness

Shared evaluation harness for product MCPs: deterministic contract tests, golden fixtures and a CLI with CI exit codes that gates publish across JobScout, Handoff, SourcePack and sibling MCPs.

**Status:** v0. The design and acceptance checklist live in the Agentic Satellite Vault:

`Workspace/Grok/Use Cases/MCP Eval Harness.md`

in [SarutobiSasuke8/agentic-satellite-vault](https://github.com/SarutobiSasuke8/agentic-satellite-vault) (private).

## What it is, and is not

`mcp-eval` loads a suite file (YAML or JSON), starts the target MCP (a stdio command or a Streamable HTTP URL), runs each contract through the official `@modelcontextprotocol/client`, compares results against golden fixtures and JSON Schemas, and exits non-zero on any failure.

It is not a hosted service, not an LLM-as-judge, not a replacement for each repo's unit tests, and not the host gateway. It answers one question: does this MCP still honour the contract we published?

## Quick start

```bash
npm install
npm run build
node dist/src/cli.js examples/stub.suite.yaml
```

The stub suite runs against the in-repo stub MCP (`examples/stub-mcp/`) and exits 0. Try breaking it: change a value in `fixtures/stub/get_listing.golden.json` and run again. The exit code becomes 1 and the output names the differing path.

Once published, the same command is `npx mcp-eval suite.yaml`.

```
Usage: mcp-eval <suite.yaml|suite.json> [options]

  --json             Print the full report as JSON instead of the human summary
  --update-goldens   Rewrite golden fixtures from the current results (explicit opt-in)
  --base-dir <dir>   Resolve fixture paths against this directory (default: suite file's directory)

Exit codes: 0 pass, 1 at least one contract failed, 2 usage or configuration error
```

## Suite format

```yaml
version: 1
name: jobscout-mcp
target:
  transport: stdio                      # or: transport: http, url: http://127.0.0.1:3000/mcp
  command: ["node", "dist/index.js"]
  # cwd, env (stdio) and headers (http) are optional
timeout_ms: 30000
contracts:
  - name: tools_listed
    expect_tools: [search_jobs, get_listing]

  - name: search_jobs_input_schema
    input_schema:
      search_jobs: fixtures/search_jobs.input.schema.json

  - name: search_jobs_schema
    tool: search_jobs
    input: { query: "nurse dublin", limit: 5 }
    assert:
      result_schema: fixtures/search_jobs.result.schema.json
      golden:
        path: fixtures/search_jobs.golden.json
        ignore_paths: [generated_at, "jobs[].posted_at"]

  - name: deny_over_limit
    tool: search_jobs
    input: { query: "x", limit: 9999 }
    assert:
      is_error: true
      error_message: "limit"

  - name: unknown_tool
    tool: not_a_tool
    assert:
      error_code: INVALID_PARAMS
```

Fixture paths resolve relative to the suite file unless `--base-dir` is given. Stdio commands run with the suite file's directory as working directory unless `target.cwd` is set.

### Contract types

| Key | What it checks |
| --- | --- |
| `expect_tools` | Every named tool appears in `tools/list`. A missing tool fails. |
| `input_schema` | The listed tool's advertised `inputSchema` equals the JSON Schema fixture (treated as a golden). |
| `tool` + `input` | Calls the tool. With no `assert`, a successful non-error result passes. |

### Assertions

| Key | What it checks |
| --- | --- |
| `result_schema` | The result payload validates against the JSON Schema file (via `ajv`). |
| `golden` | The result payload equals the fixture. A string is shorthand for `{ path }`. |
| `golden.only_paths` | Compare only these paths. Applied first. |
| `golden.ignore_paths` | Drop these paths before comparing (timestamps, request ids). |
| `is_error` | The tool returned `isError: true`. An unexpected `isError: true` fails any contract. |
| `error_message` | Regular expression the error text must match (tool error content or JSON-RPC message). |
| `error_code` | A JSON-RPC error with this code. Accepts a number or `PARSE_ERROR`, `INVALID_REQUEST`, `METHOD_NOT_FOUND`, `INVALID_PARAMS`, `INTERNAL_ERROR`. |

The result payload is the tool's `structuredContent` when present, otherwise the first text block parsed as JSON, otherwise `{ content: [...] }`.

Path syntax for `only_paths` and `ignore_paths`: `a.b` descends objects, `a[]` maps over every array element, `a[2]` picks one element. Keys are sorted before comparison, so goldens are insensitive to property order.

### Where errors land with SDK 2.x

The MCP SDK reports input validation failures and exceptions thrown inside a tool handler as a tool result with `isError: true`, not as a JSON-RPC error. Assert those with `is_error` and `error_message`. Protocol-level failures, such as calling a tool that is not registered, do arrive as JSON-RPC errors; assert those with `error_code`. The stub suite shows both.

## Goldens

Goldens are written only when you pass `--update-goldens`. Without the flag, a missing golden is a failure with a message telling you how to create it, and a mismatch is a failure with the differing paths. There is no auto-heal. Review the diff of a golden update like any other code change.

## JobScout example

`examples/jobscout.suite.yaml` shows how JobScout plugs in: expected tool list, the advertised `jobscout_search_jobs` input schema as a fixture, a golden for the deterministic `jobscout_classify_jobs` tool, a shape-only golden for `jobscout_list_sources` using `only_paths` (enabled state depends on environment keys and is excluded), and the over-limit deny path. `jobscout_search_jobs` contacts live job boards, so it never carries a golden.

The suite points at a sibling checkout (`../../jobscout-mcp/dist/src/stdio.js`). In the JobScout repo itself it would live at `eval/jobscout.suite.yaml` with `command: ["node", "dist/src/stdio.js"]`.

First run on this machine caught a real drift: the JobScout `dist/` was stale against `src/` and advertised six tools, not eight. That is the harness doing its job.

## Adding the harness as a publish gate

### GitHub Actions (copy-paste snippet)

Add a job to the target repo's workflow. It runs after build and before any publish step.

```yaml
  mcp-eval:
    runs-on: ubuntu-latest
    needs: check
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx --yes @sarutobi-sasuke/mcp-eval-harness@0.1.0 eval/jobscout.suite.yaml --json > mcp-eval-report.json
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: mcp-eval-report
          path: mcp-eval-report.json
```

Make the publish job `needs: [check, mcp-eval]`. A non-zero exit from `mcp-eval` blocks it.

Until the package is on npm, install it from git instead: `npm install --save-dev github:SarutobiSasuke8/mcp-eval-harness#v0-harness` and call `npx mcp-eval`.

### Local or VPS gate (when Actions billing is blocked)

Actions billing is blocked on some repos, so the gate must also run without GitHub. Wire it into the publish script of the target repo:

```json
{
  "scripts": {
    "verify": "npm run check && mcp-eval eval/jobscout.suite.yaml",
    "prepublishOnly": "npm run verify"
  }
}
```

`npm publish` then refuses to run if any contract fails. The same one-liner works from a VPS cron or a release shell:

```bash
cd /srv/jobscout-mcp && git pull --ff-only && npm ci && npm run build && npx mcp-eval eval/jobscout.suite.yaml --json > /var/log/mcp-eval/jobscout-$(date +%F).json
```

A non-zero exit stops the shell chain before any `npm publish` that follows it.

## v0 decisions (answers to the design's open questions)

- **Language:** TypeScript, ESM, Node 20 or newer. Matches the sibling MCP repos, so one toolchain.
- **Golden updates:** only with `--update-goldens`. Never implicit, never on CI.
- **Client:** wrap the official SDK client (`@modelcontextprotocol/client` 2.2.0, pinned to the same line as the `@modelcontextprotocol/server` 2.2.0 that JobScout uses). The harness never speaks raw JSON-RPC.
- **Distribution:** copy-paste workflow snippet in v0. No reusable GitHub Action yet; that waits until two or more repos have adopted the snippet and the shape is stable.

## MVP acceptance checklist

- [x] CLI runs a suite against the in-repo stub MCP and exits 0 on pass, non-zero on fail. Proven by `tests/cli.test.ts`.
- [x] Contract: expected tools present; missing tool fails.
- [x] At least one golden fixture compare (whole result, `ignore_paths` and `only_paths` variants in `examples/stub.suite.yaml`).
- [x] At least one intentional deny or error-path assertion (`is_error` + `error_message` for `limit > 100`, `error_code: INVALID_PARAMS` for an unregistered tool).
- [x] Example suite showing how JobScout would plug in (`examples/jobscout.suite.yaml`, run against the sibling build).
- [x] Docs: GitHub Actions YAML snippet and a local or VPS command for the publish gate.
- [x] No credentials in git. The harness reads nothing from `.env`; targets inherit the environment only if `target.env` is set.
- [x] British English; no em dashes.

Deferred from v0, with reasons:

- **Reusable GitHub Action** (`uses: SarutobiSasuke8/mcp-eval-harness@v1`): deferred until the snippet has been adopted by at least two repos, so the action wraps a known-stable interface.
- **Prompts and resources contracts:** v0 covers tools only. Sibling MCPs expose prompts, but the publish-gate risk is in tool results, which is where goldens pay off first.
- **npm publish of the package:** the package is shaped for publishing (`bin`, `files`, exact pins) but not yet published. Install from git until then.
- **Streamable HTTP end-to-end test:** the transport is wired through the SDK client and typed in the suite schema, but the test suite only exercises stdio because the stub is stdio-only. An HTTP stub is a small follow-up.
- **Parallel contract execution:** contracts run sequentially against one connection. Suites are small and deterministic, so speed is not the constraint yet.

## Layout

```
src/           runner, CLI, suite schema, golden helpers
examples/      stub MCP (stdio) and example suites
fixtures/      goldens and JSON Schemas for the examples
tests/         node --test suites (compiled to dist/tests)
```

## Development

```bash
npm run check      # typecheck, lint, build and test
npm run eval:stub  # build and run the stub suite
```

## Licence

MIT. See `LICENSE`.
