import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ANTIGRAVITY_PROVIDER_ID, DEVIN_PROVIDER_ID } from "../src/agents.ts";
import { resolvePluginNativeRoots } from "../src/native-roots.ts";

async function scratch(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-roots-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("returns empty roots for non-Antigravity providers", async (t) => {
  const home = await scratch(t);
  const result = await resolvePluginNativeRoots({
    providerId: DEVIN_PROVIDER_ID,
    cwd: home,
    homeDir: home,
    env: {},
  });
  assert.deepEqual(result, { skills: [], commands: [] });
});

test("resolves enabled Antigravity plugin skills, honours config.json disables, and handles BOM plugin.json", async (t) => {
  const home = await scratch(t);
  const pluginsDir = path.join(home, ".gemini", "config", "plugins");
  await mkdir(path.join(pluginsDir, "science", "skills"), { recursive: true });
  await mkdir(path.join(pluginsDir, "custom-plugin", "extra-skills"), { recursive: true });
  await mkdir(path.join(pluginsDir, "disabled-plugin", "skills"), { recursive: true });
  await mkdir(path.join(pluginsDir, "no-skills-plugin"), { recursive: true });

  await writeFile(
    path.join(home, ".gemini", "config", "config.json"),
    JSON.stringify({
      plugins: {
        science: { enabled: true },
        "disabled-plugin": { enabled: false },
      },
    }),
  );

  // UTF-8 BOM + custom skills array + escaping path that must be rejected.
  await writeFile(
    path.join(pluginsDir, "custom-plugin", "plugin.json"),
    `\uFEFF${JSON.stringify({
      name: "custom-plugin",
      skills: ["extra-skills", "../disabled-plugin/skills", "/abs/outside"],
    })}`,
  );

  const result = await resolvePluginNativeRoots({
    providerId: ANTIGRAVITY_PROVIDER_ID,
    cwd: null,
    homeDir: home,
    env: {},
  });

  const paths = result.skills.map((entry) => entry.path).sort();
  assert.deepEqual(
    paths,
    [
      path.join(pluginsDir, "custom-plugin", "extra-skills"),
      path.join(pluginsDir, "science", "skills"),
    ].sort(),
  );
  assert.equal(result.skills.every((entry) => entry.origin === "user"), true);
});

test("resolves overridden GEMINI_HOME core skills and workspace plugin skills", async (t) => {
  const root = await scratch(t);
  const home = path.join(root, "home");
  const customGemini = path.join(root, "custom-gemini");
  const workspace = path.join(root, "work");

  await mkdir(path.join(customGemini, "antigravity-cli", "skills"), { recursive: true });
  await mkdir(path.join(customGemini, "config", "plugins", "gmail", "skills"), { recursive: true });
  await mkdir(path.join(workspace, ".agents", "plugins", "team-pack", "skills"), { recursive: true });

  const result = await resolvePluginNativeRoots({
    providerId: ANTIGRAVITY_PROVIDER_ID,
    cwd: workspace,
    homeDir: home,
    env: { GEMINI_HOME: customGemini },
  });

  const byOrigin = result.skills.map((entry) => [entry.origin, entry.path]);
  assert.deepEqual(
    byOrigin.sort((a, b) => a[1].localeCompare(b[1])),
    [
      ["user", path.join(customGemini, "antigravity-cli", "skills")],
      ["user", path.join(customGemini, "config", "plugins", "gmail", "skills")],
      ["project", path.join(workspace, ".agents", "plugins", "team-pack", "skills")],
    ].sort((a, b) => a[1].localeCompare(b[1])),
  );
});
