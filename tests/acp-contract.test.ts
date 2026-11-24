import assert from "node:assert/strict";
import test from "node:test";

import {
  builtinCommands,
  contractOf,
  diffContracts,
  keyPaths,
  parseHelpFlags,
  skillNameFromFrontmatter,
  type AgentContract,
} from "../scripts/acp-contract-lib.ts";

// Trimmed from what agy 1.5.16 answered on 2026-11-24.
const agyProbe = {
  initialize: {
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} },
      _meta: { antigravity: { tier: true, systemPrompt: { append: true } } },
    },
    authMethods: [{ id: "oauth-personal" }, { id: "gemini-api-key" }],
  },
  sessionNew: {
    configOptions: [
      { id: "model", category: "model", type: "select", options: [{ value: "gemini-4-neon" }] },
      { id: "thought_level", category: "thought_level", type: "select" },
      { id: "mode", category: "mode", type: "select" },
    ],
    modes: { currentModeId: "default", availableModes: [{ id: "default" }, { id: "plan" }] },
  },
  commands: [{ name: "swarm" }, { name: "compact" }, { name: "my-own-skill" }],
  helpText: "Flags:\n  --agent      Agent\n  --sandbox    Sandbox\n  -h, --help   Show help\n",
};

test("keyPaths names every leaf and empty object", () => {
  assert.deepEqual(keyPaths({ a: true, b: { c: {}, d: 1 } }), ["a", "b.c", "b.d"]);
  assert.deepEqual(keyPaths(undefined), []);
});

test("parseHelpFlags reads long flags from agy and devin help", () => {
  assert.deepEqual(parseHelpFlags(agyProbe.helpText), ["--agent", "--help", "--sandbox"]);
  assert.deepEqual(parseHelpFlags("      --refusal-fallback <MODEL>\n      --cloud\n"), ["--cloud", "--refusal-fallback"]);
});

test("builtinCommands drops Devin skills by category and agy skills by name", () => {
  const devin = [{ name: "compact", category: "Session" }, { name: "research", category: "Skills" }];
  assert.deepEqual(builtinCommands(devin, new Set()), ["/compact"]);
  assert.deepEqual(builtinCommands(agyProbe.commands, new Set(["my-own-skill"])), ["/compact", "/swarm"]);
});

test("contractOf keeps agent facts and leaves account data out", () => {
  const contract = contractOf(agyProbe, new Set(["my-own-skill"]));
  assert.deepEqual(contract.authMethods, ["gemini-api-key", "oauth-personal"]);
  assert.deepEqual(contract.configOptions, ["mode (mode, select)", "model (model, select)", "thought_level (thought_level, select)"]);
  assert.deepEqual(contract.modes, ["default", "plan"]);
  assert.ok(contract.capabilities.includes("sessionCapabilities.resume"));
  assert.ok(!contract.capabilities.some((path) => path.includes("gemini-4-neon")));
  assert.ok(!JSON.stringify(contract).includes("gemini-4-neon"));
});

test("diffContracts reports what appeared and disappeared per agent and field", () => {
  const base = contractOf(agyProbe, new Set(["my-own-skill"]));
  const withFork: AgentContract = {
    ...base,
    capabilities: [...base.capabilities, "sessionCapabilities.fork"],
    flags: base.flags.filter((flag) => flag !== "--sandbox"),
  };
  assert.deepEqual(diffContracts({ antigravity: base, devin: base }, { antigravity: base, devin: base }), []);
  assert.deepEqual(diffContracts({ antigravity: base, devin: base }, { antigravity: withFork, devin: base }), [
    "+ antigravity.capabilities: sessionCapabilities.fork",
    "- antigravity.flags: --sandbox",
  ]);
  assert.deepEqual(diffContracts({}, { antigravity: base }), ["+ antigravity: whole contract"]);
});

test("skillNameFromFrontmatter reads the name of a SKILL.md", () => {
  assert.equal(skillNameFromFrontmatter("---\nname: swarm\ndescription: x\n---\n# body"), "swarm");
  assert.equal(skillNameFromFrontmatter('---\r\nname: "bb-cli"\r\n---\r\n'), "bb-cli");
  assert.equal(skillNameFromFrontmatter("# no frontmatter"), undefined);
});
