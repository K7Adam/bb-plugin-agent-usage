import assert from "node:assert/strict";
import test from "node:test";

import type { AcpToolCallContent, AcpToolCallUpdateEvent } from "@get-bb/plugin-sdk/provider-bridge/acp";

import {
  devinCommandResult,
  devinToolIdentity,
  isDevinCommandPreviewBlock,
  mapDevinToolKind,
  normalizeDevinCommandEvent,
  resetDevinTrackedMetaForTest,
} from "../src/devin-dialect.ts";

function makeEvent(
  overrides: Partial<AcpToolCallUpdateEvent> & { _meta?: Record<string, unknown> } = {},
): AcpToolCallUpdateEvent {
  return {
    sessionUpdate: "tool_call_update",
    toolCallId: "exec:1#abc",
    ...overrides,
  } as AcpToolCallUpdateEvent;
}

const PREVIEW_BLOCK = {
  type: "content",
  content: {
    type: "resource",
    resource: {
      mimeType: "text/x-shellscript",
      text: "echo devin-probe-ok",
      uri: "tool://preview",
    },
    _meta: {
      "cognition.ai/preview_is_shell_command": true,
    },
  },
} as unknown as AcpToolCallContent;

test("extracts Devin tool identity from _meta['cognition.ai/inferenceToolName']", () => {
  resetDevinTrackedMetaForTest();
  assert.deepEqual(
    devinToolIdentity(
      makeEvent({
        toolCallId: "exec:1",
        _meta: { "cognition.ai/inferenceToolName": "exec" },
      }),
    ),
    { name: "exec", kind: "execute" },
  );
  assert.deepEqual(
    devinToolIdentity(
      makeEvent({
        toolCallId: "read:1",
        _meta: { "cognition.ai/inferenceToolName": "read" },
      }),
    ),
    { name: "read", kind: "read" },
  );
  assert.equal(mapDevinToolKind("grep"), "search");
  assert.equal(mapDevinToolKind("apply_patch"), "edit");
  assert.equal(mapDevinToolKind("web_search"), "fetch");
});

test("preserves cwd and terminal_exit exit_code across Devin's multi-update sequence", () => {
  resetDevinTrackedMetaForTest();
  const id = "exec:0#exit2";

  // 1. Initial tool_call with tool://preview block
  devinToolIdentity(
    makeEvent({
      sessionUpdate: "tool_call",
      toolCallId: id,
      kind: "execute",
      rawInput: { command: 'node -e "process.exit(2)"' },
      content: [PREVIEW_BLOCK],
      _meta: { "cognition.ai/inferenceToolName": "exec" },
    }),
  );

  // 2. Intermediate update carrying cwd
  devinToolIdentity(
    makeEvent({
      toolCallId: id,
      status: "in_progress",
      _meta: {
        "cognition.ai/inferenceToolName": "exec",
        "cognition.ai/cwd": "C:\\Users\\me\\project",
      },
    }),
  );

  // 3. Intermediate update carrying terminal_exit
  devinToolIdentity(
    makeEvent({
      toolCallId: id,
      status: "in_progress",
      _meta: {
        "cognition.ai/inferenceToolName": "exec",
        terminal_exit: { terminal_id: "5ac388", exit_code: 2, signal: null },
      },
    }),
  );

  // 4. Final merged completed event (bb mergeAcpToolCallEvents does not carry intermediate _meta)
  const mergedCompleted = makeEvent({
    toolCallId: id,
    status: "completed",
    kind: "execute",
    rawInput: { command: 'node -e "process.exit(2)"' },
    content: [{ type: "content", content: { type: "text", text: "Exited with code 2" } }],
    _meta: { "cognition.ai/inferenceToolName": "exec" },
  });

  const normalized = normalizeDevinCommandEvent(mergedCompleted);
  assert.equal((normalized.rawInput as Record<string, unknown>).cwd, "C:\\Users\\me\\project");
  assert.equal((normalized.rawOutput as Record<string, unknown>).exitCode, 2);

  assert.deepEqual(devinCommandResult(normalized), {
    exitCode: 2,
    output: "Exited with code 2",
  });
});

test("strips Devin tool://preview blocks so silent commands do not echo their command as output", () => {
  resetDevinTrackedMetaForTest();
  const id = "exec:2#silent";
  assert.equal(isDevinCommandPreviewBlock(PREVIEW_BLOCK), true);

  devinToolIdentity(
    makeEvent({
      toolCallId: id,
      status: "in_progress",
      _meta: {
        "cognition.ai/inferenceToolName": "exec",
        terminal_exit: { terminal_id: "99", exit_code: 0, signal: null },
      },
    }),
  );

  const merged = makeEvent({
    toolCallId: id,
    status: "completed",
    kind: "execute",
    rawInput: { command: "echo devin-probe-ok" },
    content: [PREVIEW_BLOCK],
  });

  const normalized = normalizeDevinCommandEvent(merged);
  assert.deepEqual(normalized.content, []);
  assert.deepEqual(devinCommandResult(normalized), { exitCode: 0 });
});

test("appends signal tags and falls back to 'Exited with code N' text when terminal_exit is absent", () => {
  resetDevinTrackedMetaForTest();
  const sigEvent = makeEvent({
    toolCallId: "exec:3#sig",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "partial output" } }],
    _meta: { terminal_exit: { exit_code: 143, signal: "SIGTERM" } },
  });
  assert.deepEqual(devinCommandResult(sigEvent), {
    exitCode: 143,
    output: "partial output\n[signal SIGTERM]",
  });

  const fallbackEvent = makeEvent({
    toolCallId: "exec:4#fallback",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "Exited with code 127" } }],
  });
  assert.deepEqual(devinCommandResult(fallbackEvent), {
    exitCode: 127,
    output: "Exited with code 127",
  });
});
