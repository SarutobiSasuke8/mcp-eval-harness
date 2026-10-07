import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

import { suiteSchema } from "./types.js";

import type { Suite } from "./types.js";

export interface LoadedSuite {
  suite: Suite;
  file: string;
  baseDir: string;
}

export function parseSuite(raw: string, file: string): Suite {
  const ext = extname(file).toLowerCase();
  const data: unknown = ext === ".json" ? JSON.parse(raw) : parseYaml(raw);
  const parsed = suiteSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("\n  ");
    throw new Error(`Invalid suite ${file}:\n  ${issues}`);
  }
  return parsed.data;
}

export async function loadSuite(path: string): Promise<LoadedSuite> {
  const file = resolve(path);
  const raw = await readFile(file, "utf8");
  return { suite: parseSuite(raw, file), file, baseDir: dirname(file) };
}
