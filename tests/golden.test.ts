import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonicalise, diff, normalise, parsePath, pickPath, removePath } from "../src/golden.js";

import type { Json } from "../src/golden.js";

const sample: Json = {
  total: 2,
  generated_at: "2026-01-01T00:00:00Z",
  jobs: [
    { id: "a", title: "A", posted_at: "x", tags: ["t1"] },
    { id: "b", title: "B", posted_at: "y", tags: [] },
  ],
};

void describe("parsePath", () => {
  void it("parses keys, each-markers and indexes", () => {
    assert.deepEqual(parsePath("jobs[].posted_at"), [{ kind: "key", key: "jobs" }, { kind: "each" }, { kind: "key", key: "posted_at" }]);
    assert.deepEqual(parsePath("jobs[1].id"), [{ kind: "key", key: "jobs" }, { kind: "index", index: 1 }, { kind: "key", key: "id" }]);
  });

  void it("rejects an empty path", () => {
    assert.throws(() => parsePath(""), /Empty golden path/);
  });
});

void describe("removePath", () => {
  void it("drops a top-level key", () => {
    const out = removePath(sample, parsePath("generated_at")) as { generated_at?: unknown };
    assert.equal("generated_at" in out, false);
  });

  void it("drops a key from every array element", () => {
    const out = removePath(sample, parsePath("jobs[].posted_at")) as { jobs: Array<Record<string, Json>> };
    assert.deepEqual(out.jobs.map((job) => Object.keys(job).sort()), [["id", "tags", "title"], ["id", "tags", "title"]]);
  });

  void it("leaves missing paths untouched", () => {
    assert.deepEqual(removePath(sample, parsePath("nope.deeper")), sample);
  });
});

void describe("pickPath", () => {
  void it("keeps only the selected subset, preserving structure", () => {
    assert.deepEqual(pickPath(sample, parsePath("jobs[].id")), { jobs: [{ id: "a" }, { id: "b" }] });
  });

  void it("returns undefined when nothing resolves", () => {
    assert.equal(pickPath(sample, parsePath("jobs[].missing")), undefined);
    assert.equal(pickPath(sample, parsePath("missing")), undefined);
  });
});

void describe("normalise", () => {
  void it("applies only_paths then ignore_paths and sorts keys", () => {
    const out = normalise(sample, { only_paths: ["total", "jobs[].id", "jobs[].title", "jobs[].missing"], ignore_paths: ["jobs[].title"] });
    assert.deepEqual(out, { jobs: [{ id: "a" }, { id: "b" }], total: 2 });
    assert.deepEqual(Object.keys(out as object), ["jobs", "total"]);
  });

  void it("canonicalises key order recursively", () => {
    assert.equal(JSON.stringify(canonicalise({ b: { z: 1, a: 2 }, a: [{ y: 1, x: 2 }] })), JSON.stringify({ a: [{ x: 2, y: 1 }], b: { a: 2, z: 1 } }));
  });
});

void describe("diff", () => {
  void it("reports no differences for equal values", () => {
    assert.deepEqual(diff(sample, structuredClone(sample)), []);
  });

  void it("reports changed, missing and extra entries with paths", () => {
    const actual = structuredClone(sample) as { total: number; jobs: Array<Record<string, Json>> };
    actual.total = 3;
    actual.jobs.pop();
    actual.jobs[0] = { ...actual.jobs[0], extra: true };
    const differences = diff(sample, actual);
    assert.deepEqual(
      differences.map((d) => d.path),
      ["$.jobs[0].extra", "$.jobs[1]", "$.total"],
    );
  });
});
