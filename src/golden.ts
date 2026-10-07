/**
 * Golden fixture helpers: path selection, normalisation and structural diffing.
 *
 * Paths use a small dotted syntax: `a.b` descends objects, `a[]` maps over every array
 * element, `a[2]` picks one element. `jobs[].posted_at` therefore means "the posted_at field
 * of every job".
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type Segment = { kind: "key"; key: string } | { kind: "each" } | { kind: "index"; index: number };

const SEGMENT_PATTERN = /([^.[\]]+)|\[(\d*)\]/g;

export function parsePath(path: string): Segment[] {
  const segments: Segment[] = [];
  const pattern = new RegExp(SEGMENT_PATTERN.source, "g");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(path)) !== null) {
    if (match[1] !== undefined) {
      segments.push({ kind: "key", key: match[1] });
    } else if (match[2] === "") {
      segments.push({ kind: "each" });
    } else if (match[2] !== undefined) {
      segments.push({ kind: "index", index: Number(match[2]) });
    }
  }
  if (segments.length === 0) {
    throw new Error(`Empty golden path: "${path}"`);
  }
  return segments;
}

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns a copy of `value` with the given path removed wherever it resolves. */
export function removePath(value: Json, segments: Segment[]): Json {
  const [head, ...rest] = segments;
  if (!head) {
    return value;
  }
  if (head.kind === "each") {
    if (!Array.isArray(value)) {
      return value;
    }
    return rest.length === 0 ? [] : value.map((item) => removePath(item, rest));
  }
  if (head.kind === "index") {
    if (!Array.isArray(value)) {
      return value;
    }
    if (rest.length === 0) {
      return value.filter((_, index) => index !== head.index);
    }
    return value.map((item, index) => (index === head.index ? removePath(item, rest) : item));
  }
  if (!isObject(value) || !(head.key in value)) {
    return value;
  }
  if (rest.length === 0) {
    const copy = { ...value };
    delete copy[head.key];
    return copy;
  }
  return { ...value, [head.key]: removePath(value[head.key] as Json, rest) };
}

/** Returns the subset of `value` reachable through the given path, preserving structure. */
export function pickPath(value: Json, segments: Segment[]): Json | undefined {
  const [head, ...rest] = segments;
  if (!head) {
    return value;
  }
  if (head.kind === "each") {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const picked = value.map((item) => (rest.length === 0 ? item : pickPath(item, rest)));
    if (rest.length > 0 && picked.every((item) => item === undefined)) {
      return undefined;
    }
    return picked.map((item) => item ?? null);
  }
  if (head.kind === "index") {
    if (!Array.isArray(value)) {
      return undefined;
    }
    const item = value[head.index];
    if (item === undefined) {
      return undefined;
    }
    const picked = rest.length === 0 ? item : pickPath(item, rest);
    return picked === undefined ? undefined : [picked];
  }
  if (!isObject(value) || !(head.key in value)) {
    return undefined;
  }
  const inner = value[head.key] as Json;
  const picked = rest.length === 0 ? inner : pickPath(inner, rest);
  return picked === undefined ? undefined : { [head.key]: picked };
}

function mergeJson(a: Json | undefined, b: Json | undefined): Json | undefined {
  if (a === undefined) {
    return b;
  }
  if (b === undefined) {
    return a;
  }
  // A null placeholder marks a path that did not resolve at this position; it never wins over data.
  if (b === null) {
    return a;
  }
  if (a === null) {
    return b;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    const out: Json[] = [];
    for (let i = 0; i < length; i += 1) {
      out.push(mergeJson(a[i], b[i]) ?? null);
    }
    return out;
  }
  if (isObject(a) && isObject(b)) {
    const out: { [key: string]: Json } = { ...a };
    for (const [key, val] of Object.entries(b)) {
      out[key] = mergeJson(out[key], val) ?? null;
    }
    return out;
  }
  return b;
}

export interface NormaliseOptions {
  ignore_paths?: string[] | undefined;
  only_paths?: string[] | undefined;
}

/** Sorts object keys recursively so goldens are stable regardless of insertion order. */
export function canonicalise(value: Json): Json {
  if (Array.isArray(value)) {
    return value.map(canonicalise);
  }
  if (isObject(value)) {
    const out: { [key: string]: Json } = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalise(value[key] as Json);
    }
    return out;
  }
  return value;
}

export function normalise(value: Json, options: NormaliseOptions = {}): Json {
  let result: Json = value;
  if (options.only_paths && options.only_paths.length > 0) {
    let picked: Json | undefined;
    for (const path of options.only_paths) {
      picked = mergeJson(picked, pickPath(result, parsePath(path)));
    }
    result = picked ?? null;
  }
  for (const path of options.ignore_paths ?? []) {
    result = removePath(result, parsePath(path));
  }
  return canonicalise(result);
}

export interface Difference {
  path: string;
  expected: Json | undefined;
  actual: Json | undefined;
}

export function diff(expected: Json, actual: Json, path = "$"): Difference[] {
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const out: Difference[] = [];
    const length = Math.max(expected.length, actual.length);
    for (let i = 0; i < length; i += 1) {
      const e = expected[i];
      const a = actual[i];
      if (e === undefined || a === undefined) {
        out.push({ path: `${path}[${i}]`, expected: e, actual: a });
      } else {
        out.push(...diff(e, a, `${path}[${i}]`));
      }
    }
    return out;
  }
  if (isObject(expected) && isObject(actual)) {
    const out: Difference[] = [];
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      const e = expected[key];
      const a = actual[key];
      if (e === undefined || a === undefined) {
        out.push({ path: `${path}.${key}`, expected: e, actual: a });
      } else {
        out.push(...diff(e, a, `${path}.${key}`));
      }
    }
    return out;
  }
  if (expected === actual) {
    return [];
  }
  return [{ path, expected, actual }];
}
