// Host-side discovery of dynamic native skill roots for Google Antigravity
// (installed agy plugins and overridden GEMINI_HOME directories). Static user
// and project skill roots are declared directly on the provider in
// src/providers.ts; this resolver supplies the host-only plugin roots so every
// enabled Antigravity plugin skill appears in bb's composer and skill catalog.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  experimental_filterResolvedNativeRoots,
  type ExperimentalNativeRootsResolveAnswer,
} from "@get-bb/plugin-sdk/host";

import { ANTIGRAVITY_PROVIDER_ID } from "./agents.ts";

type SkillRoot = NonNullable<ExperimentalNativeRootsResolveAnswer["skills"]>[number];

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    // Strip optional UTF-8 BOM that some Windows editors write into plugin.json.
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Reads `~/.gemini/config/config.json` and returns plugin names explicitly disabled. */
async function readDisabledPlugins(geminiHome: string): Promise<Set<string>> {
  const disabled = new Set<string>();
  const config = await readJsonRecord(path.join(geminiHome, "config", "config.json"));
  const plugins = config?.plugins;
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return disabled;
  for (const [name, entry] of Object.entries(plugins as Record<string, unknown>)) {
    if (typeof entry === "object" && entry !== null && (entry as Record<string, unknown>).enabled === false) {
      disabled.add(name);
    }
  }
  return disabled;
}

/** Resolves a manifest-relative skill entry safely inside `pluginDir`, rejecting escapes. */
function resolveSafeChild(pluginDir: string, entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed.length === 0 || path.isAbsolute(trimmed)) return null;
  const resolved = path.resolve(pluginDir, trimmed);
  const relative = path.relative(pluginDir, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

async function collectPluginSkillDirs(
  pluginsRoot: string,
  origin: "user" | "project",
  disabled: ReadonlySet<string>,
): Promise<SkillRoot[]> {
  let entries;
  try {
    entries = await readdir(pluginsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const roots: SkillRoot[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (disabled.has(entry.name)) continue;

    const pluginDir = path.join(pluginsRoot, entry.name);
    const defaultSkillsDir = path.join(pluginDir, "skills");
    if (await isDirectory(defaultSkillsDir)) {
      roots.push({ origin, path: defaultSkillsDir, shape: "skills" });
    }

    const manifest = await readJsonRecord(path.join(pluginDir, "plugin.json"));
    const declared = manifest?.skills;
    const rawEntries =
      typeof declared === "string"
        ? [declared]
        : Array.isArray(declared)
          ? declared.filter((item): item is string => typeof item === "string")
          : [];
    for (const rawEntry of rawEntries) {
      const candidate = resolveSafeChild(pluginDir, rawEntry);
      if (candidate !== null && (await isDirectory(candidate))) {
        roots.push({ origin, path: candidate, shape: "skills" });
      }
    }
  }
  return roots;
}

export interface ResolveNativeRootsArgs {
  providerId: string;
  cwd: string | null;
  homeDir: string;
  env: Readonly<Record<string, string | undefined>>;
  warn?: (message: string) => void;
}

export async function resolvePluginNativeRoots({
  providerId,
  cwd,
  homeDir,
  env,
  warn = () => undefined,
}: ResolveNativeRootsArgs): Promise<{ skills: SkillRoot[]; commands: SkillRoot[] }> {
  if (providerId !== ANTIGRAVITY_PROVIDER_ID) {
    return { skills: [], commands: [] };
  }

  const defaultGeminiHome = path.join(homeDir, ".gemini");
  const customGeminiHome = env.GEMINI_HOME?.trim();
  const geminiHome = customGeminiHome ? path.resolve(homeDir, customGeminiHome) : defaultGeminiHome;

  const candidates: SkillRoot[] = [];

  // If GEMINI_HOME points elsewhere than ~/.gemini, expose its core skill folders too.
  if (path.resolve(geminiHome).toLowerCase() !== path.resolve(defaultGeminiHome).toLowerCase()) {
    for (const rel of [
      path.join("antigravity-cli", "skills"),
      path.join("config", "skills"),
      "skills",
      path.join("antigravity-cli", "builtin", "skills"),
    ]) {
      const dir = path.join(geminiHome, rel);
      if (await isDirectory(dir)) {
        candidates.push({ origin: "user", path: dir, shape: "skills" });
      }
    }
  }

  const disabled = await readDisabledPlugins(geminiHome);
  for (const pluginsRoot of [
    path.join(geminiHome, "config", "plugins"),
    path.join(geminiHome, "antigravity-cli", "plugins"),
  ]) {
    candidates.push(...(await collectPluginSkillDirs(pluginsRoot, "user", disabled)));
  }

  if (cwd !== null && cwd.trim().length > 0) {
    for (const workspacePlugins of [
      path.join(cwd, ".agents", "plugins"),
      path.join(cwd, ".agent", "plugins"),
    ]) {
      candidates.push(...(await collectPluginSkillDirs(workspacePlugins, "project", new Set())));
    }
  }

  // Deduplicate by resolved path (case-insensitive on Windows).
  const seen = new Set<string>();
  const unique = candidates.filter((root) => {
    const resolved = path.resolve(root.path);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return experimental_filterResolvedNativeRoots({ skills: unique, commands: [] }, { warn }).answer;
}
