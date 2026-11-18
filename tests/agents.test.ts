import assert from "node:assert/strict";
import test from "node:test";

import { antigravityLaunchArgs, DEFAULT_ANTIGRAVITY_COMMAND, isAgyCliCommand } from "../src/agents.ts";

test("the default Antigravity command is the agy CLI with its acp subcommand", () => {
  assert.equal(DEFAULT_ANTIGRAVITY_COMMAND, "agy");
  assert.equal(isAgyCliCommand(DEFAULT_ANTIGRAVITY_COMMAND), true);
  assert.deepEqual(antigravityLaunchArgs(DEFAULT_ANTIGRAVITY_COMMAND), ["acp"]);
  assert.deepEqual(antigravityLaunchArgs(DEFAULT_ANTIGRAVITY_COMMAND, { sandbox: true }), ["acp", "--sandbox"]);
});

test("agy given as a path or with .exe also gets the acp subcommand", () => {
  assert.equal(isAgyCliCommand("C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe"), true);
  assert.deepEqual(antigravityLaunchArgs("C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe"), ["acp"]);
  assert.deepEqual(antigravityLaunchArgs("/usr/local/bin/agy"), ["acp"]);
  assert.deepEqual(antigravityLaunchArgs(" AGY.EXE ", { sandbox: true }), ["acp", "--sandbox"]);
});

test("the separate ACP server and other commands start without arguments", () => {
  assert.equal(isAgyCliCommand("agy_acp_server"), false);
  assert.deepEqual(antigravityLaunchArgs("agy_acp_server"), []);
  assert.deepEqual(antigravityLaunchArgs("agy_acp_server", { sandbox: true }), []);
  assert.deepEqual(antigravityLaunchArgs("C:/Users/me/AppData/Local/agy-acp-server/1.4.1/agy_acp_server.exe"), []);
  assert.deepEqual(antigravityLaunchArgs("agy-wrapper"), []);
});
