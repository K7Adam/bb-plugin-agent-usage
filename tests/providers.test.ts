import assert from "node:assert/strict";
import test from "node:test";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { ANTIGRAVITY_PROVIDER_ID, DEVIN_PROVIDER_ID } from "../src/agents.ts";
import { registerProviders } from "../src/providers.ts";

type Declaration = Parameters<BbPluginApi["providers"]["register"]>[0];
type DeriveContext = Parameters<NonNullable<Declaration["deriveProviderOptions"]>>[0];

function registered(commands: Parameters<typeof registerProviders>[1] = { devinCommand: "devin", antigravityCommand: "agy" }) {
  const declarations = new Map<string, Declaration>();
  const bb = {
    providers: {
      register(declaration: Declaration) {
        declarations.set(declaration.id, declaration);
      },
    },
  } as unknown as BbPluginApi;
  registerProviders(bb, commands);
  return declarations;
}

function derive(declaration: Declaration | undefined, settings: DeriveContext["settings"]) {
  assert.ok(declaration?.deriveProviderOptions, `${declaration?.id} derives provider options`);
  return declaration.deriveProviderOptions({
    threadId: "thr_test",
    projectId: "proj_test",
    model: "model",
    permissionMode: "accept-edits",
    settings,
  }) as { acpDialect: string; acpLaunchSpec: { command: string; args: string[]; env: Record<string, string> } };
}

test("both providers offer bb's plan and goal composer actions", () => {
  for (const declaration of registered().values()) {
    assert.deepEqual([...declaration.composerActions].sort(), ["goal", "plan"], declaration.id);
  }
});

test("only Antigravity allows manual compaction, which the bridge sends as /compact", () => {
  const declarations = registered();
  // agy compacts inside the /compact turn.
  assert.equal(declarations.get(ANTIGRAVITY_PROVIDER_ID)?.capabilities.supportsManualCompaction, true);
  // devin ends the /compact turn at once and compacts afterwards; a prompt sent
  // in the meantime cancels it, and bb would already show it as finished.
  assert.equal(declarations.get(DEVIN_PROVIDER_ID)?.capabilities.supportsManualCompaction, false);
});

test("capabilities that neither ACP agent advertises stay off", () => {
  for (const declaration of registered().values()) {
    assert.equal(declaration.capabilities.fork, "none", declaration.id);
    assert.equal(declaration.capabilities.supportsServiceTier, false, declaration.id);
    assert.equal(declaration.capabilities.supportsThreadRename, false, declaration.id);
    assert.equal(declaration.capabilities.supportsThreadArchive, false, declaration.id);
  }
});

test("reasoning ladders list only the thought levels each agent offers over ACP", () => {
  const declarations = registered();
  const antigravity = declarations.get(ANTIGRAVITY_PROVIDER_ID);
  const devin = declarations.get(DEVIN_PROVIDER_ID);
  // agy 1.5.16 session/new: thought_level low|medium|high|xhigh.
  assert.deepEqual(antigravity?.capabilities.reasoningLevels, ["low", "medium", "high", "xhigh"]);
  // devin 3000.14 across its 170 models: none (13 models) and low..max.
  assert.deepEqual(devin?.capabilities.reasoningLevels, ["none", "low", "medium", "high", "xhigh", "max"]);
  for (const declaration of [antigravity, devin]) {
    assert.deepEqual(
      declaration?.reasoningLevels?.map((level) => level.id),
      declaration?.capabilities.reasoningLevels,
      declaration?.id,
    );
  }
});

test("Devin starts as `devin acp` with default settings", () => {
  const devin = registered().get(DEVIN_PROVIDER_ID);
  const options = derive(devin, {});
  assert.equal(options.acpDialect, "devin-cli");
  assert.equal(options.acpLaunchSpec.command, "devin");
  assert.deepEqual(options.acpLaunchSpec.args, ["acp"]);
  assert.deepEqual(options.acpLaunchSpec.env, {});
});

test("Devin settings become acp flags at call time", () => {
  const devin = registered().get(DEVIN_PROVIDER_ID);
  const options = derive(devin, {
    devinCommand: " C:\\tools\\devin.exe ",
    devinProcessModel: "in-process",
    devinRefusalFallback: " opus, sonnet ,,gpt-6 ",
  });
  assert.equal(options.acpLaunchSpec.command, "C:\\tools\\devin.exe");
  assert.deepEqual(options.acpLaunchSpec.args, [
    "acp",
    "--process-model",
    "in-process",
    "--refusal-fallback",
    "opus",
    "--refusal-fallback",
    "sonnet",
    "--refusal-fallback",
    "gpt-6",
  ]);
});

test("Devin ignores an unknown process model and the default choice", () => {
  const devin = registered().get(DEVIN_PROVIDER_ID);
  for (const devinProcessModel of ["default", "bogus", "", undefined]) {
    assert.deepEqual(derive(devin, { devinProcessModel }).acpLaunchSpec.args, ["acp"], String(devinProcessModel));
  }
});

test("a blank Devin command setting falls back to the command registered at load", () => {
  const devin = registered({ devinCommand: "devin-custom", antigravityCommand: "agy" }).get(DEVIN_PROVIDER_ID);
  assert.equal(derive(devin, { devinCommand: "   " }).acpLaunchSpec.command, "devin-custom");
});

test("Antigravity keeps deriving its sandbox flag", () => {
  const antigravity = registered().get(ANTIGRAVITY_PROVIDER_ID);
  assert.deepEqual(derive(antigravity, { antigravitySandbox: true }).acpLaunchSpec.args, ["acp", "--sandbox"]);
  assert.deepEqual(derive(antigravity, {}).acpLaunchSpec.args, ["acp"]);
});
