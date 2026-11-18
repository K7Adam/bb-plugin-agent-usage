import assert from "node:assert/strict";
import test from "node:test";

import type { AcpToolCallUpdateEvent } from "@get-bb/plugin-sdk/provider-bridge/acp";

import {
  antigravityCommandResult,
  antigravityToolIdentity,
  classifyAntigravityToolCall,
  inferAntigravityToolName,
  mapAntigravityToolKind,
  normalizeAntigravityCommandEvent,
  parseAntigravityCommandOutput,
} from "../src/antigravity-dialect.ts";

function makeEvent(overrides: Partial<AcpToolCallUpdateEvent> = {}): AcpToolCallUpdateEvent {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: "tc_1",
    ...overrides,
  };
}

test("infers canonical Antigravity tools from name, title, _meta, and rawInput", () => {
  assert.equal(inferAntigravityToolName(makeEvent({ name: "run_command" })), "run_command");
  assert.equal(inferAntigravityToolName(makeEvent({ title: "read_file: src/index.ts" })), "read_file");
  assert.equal(inferAntigravityToolName(makeEvent({ rawInput: { CommandLine: "npm test" } })), "run_command");
  assert.equal(
    inferAntigravityToolName(makeEvent({ rawInput: { TypeName: "research", Prompt: "Check docs", Role: "Researcher" } })),
    "invoke_subagent",
  );
  assert.equal(
    inferAntigravityToolName(makeEvent({ rawInput: { Action: "status", TaskId: "task-1" } })),
    "manage_task",
  );
  assert.equal(
    inferAntigravityToolName(makeEvent({ rawInput: { Prompt: "Ping", DurationSeconds: 60 } })),
    "schedule",
  );
  assert.equal(
    inferAntigravityToolName(makeEvent({ rawInput: { action: "add", name: "worker-1" } })),
    "swarm",
  );
  assert.equal(
    inferAntigravityToolName(makeEvent({ rawInput: { Script: "print(1)", Description: "Fan out" } })),
    "run_workflow",
  );
  assert.equal(inferAntigravityToolName(makeEvent({ rawInput: { Path: "a.ts", Target: "x", Replacement: "y" } })), "edit_file");
  assert.equal(inferAntigravityToolName(makeEvent({ rawInput: { Path: "a.ts", Content: "hi" } })), "write_file");
  assert.equal(inferAntigravityToolName(makeEvent({ rawInput: { Path: "a.ts", StartLine: 1 } })), "read_file");
});

test("maps Antigravity tool names to ACP kinds", () => {
  assert.equal(mapAntigravityToolKind("run_command"), "execute");
  assert.equal(mapAntigravityToolKind("read_file"), "read");
  assert.equal(mapAntigravityToolKind("edit_file"), "edit");
  assert.equal(mapAntigravityToolKind("grep_search"), "search");
  assert.equal(mapAntigravityToolKind("search_web"), "fetch");
  assert.equal(mapAntigravityToolKind("invoke_subagent"), "other");
  assert.deepEqual(antigravityToolIdentity(makeEvent({ rawInput: { CommandLine: "echo hi" } })), {
    name: "run_command",
    kind: "execute",
  });
});

test("strips wrapper timestamps, preserves sandbox diagnostics, and parses exit codes", () => {
  const raw = [
    "Created At: 2026-11-18T21:00:00+01:00",
    "Completed At: 2026-11-18T21:00:01+01:00",
    "Command exited with code 0.",
    "",
    "Command output:",
    "hello world",
  ].join("\n");
  assert.deepEqual(parseAntigravityCommandOutput(raw), {
    cleanOutput: "hello world",
    exitCode: 0,
    isBackgrounded: false,
    backgroundTaskId: null,
  });

  const failedSandbox = [
    "There were sandbox errors: blocked write",
    "Created At: 2026-11-18T21:00:00+01:00",
    "Command exited with code 1.",
    "",
    "Command output:",
    "",
  ].join("\n");
  const parsedFail = parseAntigravityCommandOutput(failedSandbox);
  assert.equal(parsedFail.exitCode, 1);
  assert.equal(parsedFail.cleanOutput, "There were sandbox errors: blocked write");

  const bg = "Tool is running as a background task with task id: conv/task-7\nLog output:\nstarted";
  const parsedBg = parseAntigravityCommandOutput(bg);
  assert.equal(parsedBg.isBackgrounded, true);
  assert.equal(parsedBg.backgroundTaskId, "conv/task-7");
});

test("normalizes command events and extracts commandResult", () => {
  const call = makeEvent({
    name: "run_command",
    rawInput: { CommandLine: "npm test", toolSummary: "Run unit tests" },
  });
  const update = makeEvent({
    rawOutput: "Created At: now\nCommand exited with code 2.\n\nCommand output:\nFAIL test",
  });
  const normalized = normalizeAntigravityCommandEvent(update, call);
  assert.equal((normalized.rawInput as Record<string, unknown>).command, "npm test");
  assert.equal(normalized.title, "npm test");
  assert.equal(normalized.rawOutput, "FAIL test");
  assert.deepEqual(antigravityCommandResult(normalized), { exitCode: 2, output: "FAIL test" });
});

test("classifies run_command with toolSummary and BypassSandbox badge", () => {
  const classified = classifyAntigravityToolCall(
    makeEvent({
      rawInput: {
        CommandLine: "git status",
        toolSummary: "Check repository status",
        BypassSandbox: true,
      },
      rawOutput: "Command exited with code 0.\n\nCommand output:\nclean",
    }),
  );
  assert.ok(classified);
  assert.equal(classified.item.type, "command");
  if (classified.item.type === "command") {
    assert.equal(classified.item.command, "git status");
    assert.equal(classified.item.exitCode, 0);
  }
  assert.equal(classified.presentation.title, "Check repository status");
  assert.equal(classified.presentation.detail, "git status");
  assert.equal(classified.presentation.badge?.label, "Outside of sandbox");
  assert.equal(classified.presentation.badge?.tone, "destructive");
});

test("classifies invoke_subagent as a native delegation item", () => {
  const classified = classifyAntigravityToolCall(
    makeEvent({
      toolCallId: "tc_sub",
      rawInput: {
        TypeName: "research",
        Role: "Codebase Explorer",
        Model: "flash",
        Workspace: "share",
        Prompt: "Inspect the ACP bridge",
      },
      rawOutput: '{"conversationId":"conv_abc"}',
    }),
  );
  assert.ok(classified);
  assert.equal(classified.item.type, "delegation");
  if (classified.item.type === "delegation") {
    assert.equal(classified.item.childRef, "conv_abc");
    assert.equal(classified.item.label, "Codebase Explorer");
    assert.equal(classified.item.summary, "research · flash · share");
    assert.equal(classified.item.background, true);
  }
  assert.equal(classified.presentation.icon.glyph, "Bot");
});

test("classifies schedule, manage_task, swarm, run_workflow, and ask_question cleanly", () => {
  const sched = classifyAntigravityToolCall(
    makeEvent({ rawInput: { Prompt: "Check build", DurationSeconds: 120 } }),
  );
  assert.equal(sched?.presentation.title, "Schedule (120s timer)");
  assert.equal(sched?.presentation.icon.glyph, "Clock");

  const task = classifyAntigravityToolCall(
    makeEvent({ rawInput: { Action: "kill", TaskId: "task-9" } }),
  );
  assert.equal(task?.presentation.label.completed, "Stopped background task");
  assert.equal(task?.presentation.title, "kill: task-9");

  const swarm = classifyAntigravityToolCall(
    makeEvent({ rawInput: { action: "add", name: "verifier" } }),
  );
  assert.equal(swarm?.presentation.title, "Swarm add");
  assert.equal(swarm?.presentation.detail, "verifier");

  const wf = classifyAntigravityToolCall(
    makeEvent({ rawInput: { Script: "pass", Description: "Parallel audit" } }),
  );
  assert.equal(wf?.presentation.title, "Parallel audit");

  const ask = classifyAntigravityToolCall(
    makeEvent({ rawInput: { questions: [{ question: "Continue?", options: ["Yes", "No"] }] } }),
  );
  assert.equal(ask?.presentation.title, "Ask question");
});
