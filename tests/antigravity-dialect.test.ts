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
  normalizeAntigravityPath,
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
    makeEvent({ rawInput: { action: "add", name: "verifier", brief: "Check the parser diff." } }),
  );
  assert.equal(swarm?.presentation.label.completed, "Added worker");
  assert.equal(swarm?.presentation.title, "verifier");
  assert.equal(swarm?.presentation.detail, "Check the parser diff.");

  const wf = classifyAntigravityToolCall(
    makeEvent({ rawInput: { Script: "pass", Description: "Parallel audit" } }),
  );
  assert.equal(wf?.presentation.title, "Parallel audit");

  const ask = classifyAntigravityToolCall(
    makeEvent({ rawInput: { questions: [{ question: "Continue?", options: ["Yes", "No"] }] } }),
  );
  assert.equal(ask?.presentation.title, "Ask question");
});

test("normalizes Windows leading-slash drive paths and classifies read_file, search, and search_web", () => {
  assert.equal(
    normalizeAntigravityPath("/C:/Users/me/project/package.json"),
    "C:/Users/me/project/package.json",
  );
  assert.equal(normalizeAntigravityPath("/etc/hosts"), "/etc/hosts");

  const read = classifyAntigravityToolCall(
    makeEvent({
      name: "read_file",
      kind: "read",
      title: "File /C:/Users/me/project/package.json",
      locations: [{ path: "/C:/Users/me/project/package.json" }],
      rawInput: { Path: "/C:/Users/me/project/package.json" },
    }),
  );
  assert.ok(read);
  assert.equal(read.item.type, "fileRead");
  if (read.item.type === "fileRead") {
    assert.equal(read.item.path, "C:/Users/me/project/package.json");
  }
  assert.equal(read.presentation.title, "package.json");
  assert.equal(read.presentation.icon.glyph, "FileText");

  const grep = classifyAntigravityToolCall(
    makeEvent({
      name: "grep_search",
      rawInput: { Query: "registerAcpDialect", SearchPath: "/C:/Users/me/project/src" },
    }),
  );
  assert.ok(grep);
  assert.equal(grep.item.type, "search");
  if (grep.item.type === "search") {
    assert.equal(grep.item.mode, "content");
    assert.equal(grep.item.query, "registerAcpDialect");
    assert.equal(grep.item.path, "C:/Users/me/project/src");
  }

  const find = classifyAntigravityToolCall(
    makeEvent({
      name: "find_by_name",
      rawInput: { Pattern: "*.test.ts", SearchDirectory: "/C:/Users/me/project" },
    }),
  );
  assert.ok(find);
  assert.equal(find.item.type, "search");
  if (find.item.type === "search") {
    assert.equal(find.item.mode, "path");
    assert.equal(find.item.query, "*.test.ts");
    assert.equal(find.item.path, "C:/Users/me/project");
  }

  const web = classifyAntigravityToolCall(
    makeEvent({
      name: "search_web",
      rawInput: { query: "bb plugin sdk", domain: "getbb.app" },
    }),
  );
  assert.ok(web);
  assert.equal(web.item.type, "webSearch");
  if (web.item.type === "webSearch") {
    assert.deepEqual(web.item.queries, ["bb plugin sdk"]);
  }
  assert.equal(web.presentation.title, "bb plugin sdk");
  assert.equal(web.presentation.detail, "getbb.app");
});

test("classifies /boost invoke_subagent events cleanly even when rawOutput is omitted", () => {
  const classified = classifyAntigravityToolCall(
    makeEvent({
      toolCallId: "call_boost_1",
      name: "invoke_subagent",
      title: "Run invoke_subagent",
      kind: "other",
      rawInput: {
        Model: "inherit",
        Prompt: "Inspect package.json and report name and version.",
        Role: "Package JSON Reader",
        TypeName: "research",
        Workspace: "inherit",
      },
    }),
  );
  assert.ok(classified);
  assert.equal(classified.item.type, "delegation");
  if (classified.item.type === "delegation") {
    assert.equal(classified.item.childRef, "call_boost_1");
    assert.equal(classified.item.label, "Package JSON Reader");
    assert.equal(classified.item.summary, "research");
  }
  assert.equal(classified.presentation.title, "Package JSON Reader");
  assert.equal(classified.presentation.detail, "research");
});

test("labels each swarm action by what it does", () => {
  const swarm = (rawInput: Record<string, unknown>) => classifyAntigravityToolCall(makeEvent({ rawInput }));

  const titled = swarm({ action: "title", title: "the parser rewrite" });
  assert.deepEqual(titled?.presentation.label, { pending: "Naming swarm", completed: "Named swarm" });
  assert.equal(titled?.presentation.title, "the parser rewrite");

  const killed = swarm({ action: "kill", name: "py" });
  assert.deepEqual(killed?.presentation.label, { pending: "Stopping worker", completed: "Stopped worker" });
  assert.equal(killed?.presentation.title, "py");

  const status = swarm({ action: "status" });
  assert.deepEqual(status?.presentation.label, { pending: "Checking swarm", completed: "Checked swarm" });
  assert.equal(status?.presentation.title, "Swarm status");

  // agy names the tool, so an action this plugin does not know still reads as swarm.
  const unknown = classifyAntigravityToolCall(makeEvent({ name: "swarm", rawInput: { action: "rebalance" } }));
  assert.deepEqual(unknown?.presentation.label, { pending: "Coordinating swarm", completed: "Updated swarm" });
  assert.equal(unknown?.presentation.title, "Swarm rebalance");
});

test("classifies the swarm board tools instead of the generic tool row", () => {
  assert.equal(inferAntigravityToolName(makeEvent({ name: "read_board" })), "read_board");
  assert.equal(inferAntigravityToolName(makeEvent({ name: "post_message" })), "post_message");
  assert.equal(inferAntigravityToolName(makeEvent({ name: "swarm_wait" })), "swarm_wait");

  const read = classifyAntigravityToolCall(makeEvent({ name: "read_board", rawInput: {} }));
  assert.deepEqual(read?.presentation.label, { pending: "Reading swarm board", completed: "Read swarm board" });
  assert.equal(read?.presentation.title, "Swarm board");
  assert.equal(read?.item.type, "tool");

  const post = classifyAntigravityToolCall(
    makeEvent({ name: "post_message", rawInput: { message: "@py please also add a test" } }),
  );
  assert.deepEqual(post?.presentation.label, { pending: "Posting to swarm board", completed: "Posted to swarm board" });
  assert.equal(post?.presentation.detail, "@py please also add a test");

  const wait = classifyAntigravityToolCall(makeEvent({ name: "swarm_wait", rawInput: {} }));
  assert.deepEqual(wait?.presentation.label, { pending: "Waiting for the swarm", completed: "Swarm replied" });
});

// Recorded from agy 1.5.16 `acp` on Windows: the completed update of write_file
// reports `locations` and the diff path with a leading slash before the drive.
test("reports agy file writes with a usable Windows path", () => {
  const completed = classifyAntigravityToolCall(
    makeEvent({
      name: "write_file",
      kind: "edit",
      status: "completed",
      title: "File /C:/Users/me/project/probe.txt",
      locations: [{ path: "/C:/Users/me/project/probe.txt" }],
      rawInput: { Content: "hi", Path: "C:\Users\me\project\probe.txt" },
      content: [{ type: "diff", path: "/C:/Users/me/project/probe.txt", newText: "hi" }],
    } as Partial<AcpToolCallUpdateEvent>),
  );
  assert.ok(completed);
  assert.equal(completed.item.type, "fileChange");
  if (completed.item.type === "fileChange") {
    assert.deepEqual(completed.item.changes, [{ path: "C:/Users/me/project/probe.txt", kind: "add", newText: "hi" }]);
  }
  assert.equal(completed.presentation.title, "probe.txt");

  const edited = classifyAntigravityToolCall(
    makeEvent({
      name: "replace_file_content",
      kind: "edit",
      content: [{ type: "diff", path: "/C:/Users/me/project/a.ts", oldText: "let a = 1", newText: "let a = 2" }],
    } as Partial<AcpToolCallUpdateEvent>),
  );
  assert.ok(edited);
  if (edited.item.type === "fileChange") {
    assert.deepEqual(edited.item.changes, [
      { path: "C:/Users/me/project/a.ts", kind: "update", oldText: "let a = 1", newText: "let a = 2" },
    ]);
  }

  // The tool_call that starts the write has no diff yet: its path comes from rawInput.
  const started = classifyAntigravityToolCall(
    makeEvent({
      sessionUpdate: "tool_call",
      name: "write_file",
      kind: "edit",
      rawInput: { Content: "hi", Path: "/C:/Users/me/project/probe.txt" },
    }),
  );
  assert.ok(started);
  if (started.item.type === "fileChange") {
    assert.deepEqual(started.item.changes, [{ path: "C:/Users/me/project/probe.txt", kind: "update" }]);
  }

  // POSIX paths stay as they are.
  const posix = classifyAntigravityToolCall(
    makeEvent({
      name: "write_file",
      content: [{ type: "diff", path: "/home/me/project/probe.txt", newText: "hi" }],
    } as Partial<AcpToolCallUpdateEvent>),
  );
  if (posix?.item.type === "fileChange") {
    assert.equal(posix.item.changes[0]?.path, "/home/me/project/probe.txt");
  }
});
