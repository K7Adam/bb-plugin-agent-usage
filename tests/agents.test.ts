import assert from "node:assert/strict";
import test from "node:test";

import { antigravityLaunchArgs, DEFAULT_ANTIGRAVITY_COMMAND } from "../src/agents.ts";

test("the default Antigravity command is the agy CLI with its acp subcommand", () => {
  assert.equal(DEFAULT_ANTIGRAVITY_COMMAND, "agy");
  assert.deepEqual(antigravityLaunchArgs(DEFAULT_ANTIGRAVITY_COMMAND), ["acp"]);
});

test("agy given as a path or with .exe also gets the acp subcommand", () => {
  assert.deepEqual(antigravityLaunchArgs("C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe"), ["acp"]);
  assert.deepEqual(antigravityLaunchArgs("/usr/local/bin/agy"), ["acp"]);
  assert.deepEqual(antigravityLaunchArgs(" AGY.EXE "), ["acp"]);
});

test("the separate ACP server and other commands start without arguments", () => {
  assert.deepEqual(antigravityLaunchArgs("agy_acp_server"), []);
  assert.deepEqual(antigravityLaunchArgs("C:/Users/me/AppData/Local/agy-acp-server/1.4.1/agy_acp_server.exe"), []);
  assert.deepEqual(antigravityLaunchArgs("agy-wrapper"), []);
});
