# mcp-eval-harness

Shared evaluation harness for product MCPs: deterministic contract tests, golden fixtures and a CLI with CI exit codes that gates publish across JobScout, Handoff, SourcePack and sibling MCPs.

**Status:** v1. Installed from git, pinned by commit SHA (not on npm yet). The design and acceptance checklist live in the Agentic Satellite Vault:

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

Until the package is on npm, other repos install it from git pinned to a commit SHA (see the rollout guide below) and call `mcp-eval suite.yaml` from an npm script.

```
Usage: mcp-eval <suite.yaml|suite.json> [options]

  --json             Print the full report as JSON instead of the human summary
  --update-goldens   Rewrite golden fixtures from the current results (explicit opt-in)
  --base-dir <dir>   Resolve fixture paths against this directory (default: suite file's directory)
  --report <file>    Also write the full JSON report to this file
  --summary <file>   Append a Markdown summary to this file (for example $GITHUB_STEP_SUMMARY)
```

### Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| `0` | Every contract passed. | |
| `1` | At least one contract failed. | Missing or unexpected tool, golden mismatch, schema failure, wrong error code, a call that times out after a successful connect. |
| `2` | Usage, configuration or target error: the suite never ran. | Invalid suite file, stdio command that cannot start, HTTP connection refused (`fetch failed`), HTTP 401 on initialise, no answer to initialise within `timeout_ms` (`Request timed out`). |

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
    exact: true                         # also fail on tools the contract does not name

  - name: prompts_listed
    expect_prompts: [search_brief]

  - name: resources_listed
    expect_resources: ["stub://listings/index"]

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
| `expect_prompts` | Every named prompt appears in `prompts/list`. A missing prompt fails. If the server does not advertise the `prompts` capability, the check fails with a message saying so (not a transport error). |
| `expect_resources` | Every listed resource URI appears in `resources/list` (matched on `uri`, not `name`). Same capability rule as prompts, for `resources`. |
| `exact` | Contract-level, default `false`. When `true`, each listing key in the contract (`expect_tools`, `expect_prompts`, `expect_resources`) also fails on names the server lists that the contract does not, and the failure prints both the missing and the unexpected sets. Use it to catch an unreviewed tool appearing. |
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

`examples/jobscout.suite.yaml` shows how JobScout plugs in: the exact tool list (six tools, `exact: true`), the two prompts (`jobscout_setup`, `jobscout_find_jobs`) under `expect_prompts`, the advertised `jobscout_search_jobs` input schema as a fixture, a golden for the deterministic `jobscout_classify_jobs` tool, a shape-only golden for `jobscout_list_sources` using `only_paths` (enabled state depends on environment keys and is excluded), and the over-limit deny path. `jobscout_search_jobs` contacts live job boards, so it never carries a golden.

The suite points at a sibling checkout (`../../jobscout-mcp/dist/src/stdio.js`). In the JobScout repo itself it would live at `eval/jobscout.suite.yaml` with `command: ["node", "dist/src/stdio.js"]`.

**Correction to the v0 drift note.** v0 reported that the JobScout `dist/` advertised six tools while `src/` defined eight. That was a false positive. `jobscout_setup` and `jobscout_find_jobs` are registered with `server.registerPrompt`, not as tools, and a fresh build of jobscout-mcp `main` lists exactly six tools and two prompts. The example suite had put the two prompt names under `expect_tools` because v0 could not assert prompts. With `expect_prompts` and `exact`, the suite now passes against a correct server and would fail on a real seventh tool.

## Streamable HTTP targets

```yaml
target:
  transport: http
  url: http://127.0.0.1:3000/mcp
  headers:                       # optional, sent on every request
    Authorization: "Bearer test-only-value"
timeout_ms: 5000                 # applies to initialise and to every call
```

The SDK client negotiates JSON or SSE-framed responses and carries the `mcp-session-id` the server issues on every later request; stateless servers that issue none also work. `tests/http.test.ts` proves each of these against the in-repo HTTP stub (`examples/stub-mcp/http-server.ts`): JSON responses, SSE responses, session id carried after initialise, stateless mode, a bearer header from `target.headers`, a 401 when the header is missing (exit 2), a refused connection (exit 2) and a server that never answers (exit 2 within `timeout_ms`).

Header values in a committed suite are literal. Contract suites are offline (see the rollout rules), so only synthetic values belong there.

## Portfolio rollout guide

This is how an MCP repo adopts the harness. One suite per repo, committed with the code it tests.

### 1. Install, pinned by commit SHA

```bash
npm install --save-dev github:SarutobiSasuke8/mcp-eval-harness#<harness-sha>
```

which records:

```json
"devDependencies": {
  "@sarutobi-sasuke/mcp-eval-harness": "github:SarutobiSasuke8/mcp-eval-harness#<harness-sha>"
}
```

Always pin a full 40-character commit SHA, never a branch. The package has a `prepare` script, so npm builds `dist/src` on install and the `mcp-eval` bin works straight away. Why `prepare` rather than a committed `dist/`: no generated code in git, no risk of `dist/` drifting from `src/`, and npm runs it for every git install. The cost is that a git install also installs the harness's dev dependencies (TypeScript) once, to build; that takes a few seconds and is cached. Only the five runtime dependencies end up in your `node_modules`.

npm 11 prints an `install-scripts` warning naming this package's `prepare` script ("not yet covered by allowScripts"). On npm 11.19.0 the build still runs and `mcp-eval` works; the warning is informational. npm's own suggestion, `npm install-scripts approve @sarutobi-sasuke/mcp-eval-harness`, records the approval if you want it gone. npm 10 (bundled with Node 22) does not print it.

### 2. Layout

```
eval/
  mcp.suite.yaml          the suite
  fixtures/               goldens and JSON Schemas the suite references
```

Inside `eval/mcp.suite.yaml`, paths are relative to the suite file, so a stdio target is usually `command: ["node", "../dist/src/stdio.js"]` and fixtures are `fixtures/<name>.golden.json`.

### 3. Script

```json
"scripts": {
  "eval:contract": "npm run build && mcp-eval eval/mcp.suite.yaml"
}
```

`npm run eval:contract` is the one command for local runs, private repos and CI. Optionally chain it into `prepublishOnly` so `npm publish` refuses to run on a failing contract.

### 4. Offline rules (contract suites)

- No live network. Never call a tool that contacts a third-party service; cover it with `input_schema`, deny paths and `error_code` checks instead of goldens.
- No secrets. No real tokens, API keys or credentials in the suite, its `env` or its `headers`; use synthetic values only. Never read `.env`.
- Deterministic. Goldens only for deterministic tools; drop timestamps and ids with `ignore_paths`, or compare shape with `only_paths`.
- Use `exact: true` on `expect_tools` (and on `expect_prompts` / `expect_resources` where the repo has them) so a new tool cannot ship without updating the contract.
- Never run `--update-goldens` in CI. Golden updates are reviewed code changes.

### 5. GitHub Actions (public repos)

Public repos add a new workflow file, `.github/workflows/mcp-eval.yml`, that uses the composite action at the root of this repo, pinned by the same SHA:

```yaml
name: mcp-eval

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run build
      - uses: SarutobiSasuke8/mcp-eval-harness@<harness-sha>
        with:
          suite: eval/mcp.suite.yaml
          node-version: ""        # setup-node already ran above
      - uses: actions/upload-artifact@v7
        if: always()
        with:
          name: mcp-eval-report
          path: mcp-eval-report.json
          if-no-files-found: ignore
```

Action inputs:

| Input | Default | Meaning |
| --- | --- | --- |
| `suite` | (required) | Suite path, relative to `working-directory`. |
| `working-directory` | `.` | Where `mcp-eval` runs (for a monorepo app, for example `apps/mcp`). |
| `node-version` | `22` | Passed to `actions/setup-node`. Empty string skips setup-node. |
| `args` | empty | Extra `mcp-eval` arguments, split on whitespace. |
| `report-path` | `mcp-eval-report.json` | JSON report path, relative to `working-directory`. |

Outputs: `exit-code` and `report-path`. The action checks out nothing itself and does not build your server; build it in an earlier step. It builds the harness from its own checkout, runs `mcp-eval --report <report-path> --summary $GITHUB_STEP_SUMMARY`, writes a Markdown table to the job summary (or an error block on exit 2), and fails the step on any non-zero exit.

### 6. Private repos (Actions billing-blocked)

No workflow. Run `npm run eval:contract` locally or on the VPS before any publish, and paste the output into the PR body with where it ran. The same command works from a release shell:

```bash
cd /srv/jobscout-mcp && git pull --ff-only && npm ci && npm run eval:contract
```

A non-zero exit stops the chain before any `npm publish` that follows it.

### 7. Moving the pin

To adopt a newer harness, change the SHA in both `package.json` and `mcp-eval.yml` in one PR, run `npm install`, and check `npm run eval:contract` still passes.

## v0 decisions (answers to the design's open questions)

- **Language:** TypeScript, ESM, Node 20 or newer. Matches the sibling MCP repos, so one toolchain.
- **Golden updates:** only with `--update-goldens`. Never implicit, never on CI.
- **Client:** wrap the official SDK client (`@modelcontextprotocol/client` 2.2.0, pinned to the same line as the `@modelcontextprotocol/server` 2.2.0 that JobScout uses). The harness never speaks raw JSON-RPC.
- **Distribution:** copy-paste workflow snippet in v0. v1 (#4) replaces it with the composite action in `action.yml` and a git install pinned by commit SHA, because ten portfolio repos are adopting at once and need one pinned interface.

## MVP acceptance checklist

- [x] CLI runs a suite against the in-repo stub MCP and exits 0 on pass, non-zero on fail. Proven by `tests/cli.test.ts`.
- [x] Contract: expected tools present; missing tool fails.
- [x] At least one golden fixture compare (whole result, `ignore_paths` and `only_paths` variants in `examples/stub.suite.yaml`).
- [x] At least one intentional deny or error-path assertion (`is_error` + `error_message` for `limit > 100`, `error_code: INVALID_PARAMS` for an unregistered tool).
- [x] Example suite showing how JobScout would plug in (`examples/jobscout.suite.yaml`, run against the sibling build).
- [x] Docs: GitHub Actions usage and a local or VPS command for the publish gate (now the portfolio rollout guide).
- [x] No credentials in git. The harness reads nothing from `.env`; targets inherit the environment only if `target.env` is set.
- [x] British English; no em dashes.

Deferred from v0, with reasons:

- **Reusable GitHub Action:** shipped in v1 (#4) as `action.yml`, used by commit SHA. No tags or releases.
- **Prompts and resources contracts:** added after v0 (#3) as listing contracts (`expect_prompts`, `expect_resources`, `exact`). Content goldens for prompts and resources are still deferred.
- **npm publish of the package:** still not published (Alexei decides). v1 makes the git install work through a `prepare` build.
- **Streamable HTTP end-to-end test:** shipped in v1 (#4) with the in-repo HTTP stub and `tests/http.test.ts`.
- **Parallel contract execution:** contracts run sequentially against one connection. Suites are small and deterministic, so speed is not the constraint yet.

## Layout

```
action.yml     reusable composite GitHub Action
src/           runner, CLI, suite schema, golden helpers
examples/      stub MCP (stdio, `--tools-only` drops prompts and resources; HTTP stub) and example suites
scripts/       exercise-action.mjs runs action.yml locally
fixtures/      goldens and JSON Schemas for the examples
tests/         node --test suites (compiled to dist/tests)
```

## Development

```bash
npm run check      # typecheck, lint, build and test
npm run eval:stub  # build and run the stub suite
npm run action:local  # run action.yml's steps locally with bash (pass, fail and exit 2 scenarios)
```

## Licence

MIT. See `LICENSE`.
