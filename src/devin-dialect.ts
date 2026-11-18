// ACP dialect hooks for Devin CLI (`devin acp`). Uses only the public
// `AcpDialect` surface (`toolIdentity`, `normalizeCommandEvent`, `commandResult`)
// to preserve Devin's `_meta` tool names, working directories, and
// `terminal_exit` exit codes/signals across bb's ACP event merge, while
// filtering Devin's synthetic `tool://preview` shell-command preview blocks.

import type {
  AcpDialect,
  AcpToolCallContent,
  AcpToolCallUpdateEvent,
  AcpToolIdentity,
  AcpToolKind,
} from "@get-bb/plugin-sdk/provider-bridge/acp";

const MAX_TRACKED_CALLS = 256;

interface TrackedDevinCallMeta {
  cwd?: string;
  exitCode?: number;
  signal?: string;
}

const trackedCallMeta = new Map<string, TrackedDevinCallMeta>();

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function setTrackedMeta(toolCallId: string, patch: TrackedDevinCallMeta): void {
  const existing = trackedCallMeta.get(toolCallId);
  if (existing !== undefined) {
    trackedCallMeta.delete(toolCallId);
  } else if (trackedCallMeta.size >= MAX_TRACKED_CALLS) {
    const oldestKey = trackedCallMeta.keys().next().value;
    if (oldestKey !== undefined) trackedCallMeta.delete(oldestKey);
  }
  trackedCallMeta.set(toolCallId, { ...existing, ...patch });
}

export function resetDevinTrackedMetaForTest(): void {
  trackedCallMeta.clear();
}

export function mapDevinToolKind(toolName: string, fallbackKind?: AcpToolKind): AcpToolKind | undefined {
  switch (toolName.trim().toLowerCase()) {
    case "exec":
    case "shell":
    case "bash":
    case "run_command":
      return "execute";
    case "read":
    case "read_file":
    case "view":
      return "read";
    case "edit":
    case "write":
    case "write_file":
    case "apply_patch":
    case "str_replace":
      return "edit";
    case "delete":
    case "remove":
      return "delete";
    case "grep":
    case "glob":
    case "search":
    case "find":
      return "search";
    case "web_search":
    case "fetch":
    case "web_fetch":
      return "fetch";
    default:
      return fallbackKind;
  }
}

function readMetaFromEvent(event: AcpToolCallUpdateEvent): TrackedDevinCallMeta {
  const meta = recordOf((event as Record<string, unknown>)._meta);
  if (meta === null) return {};

  const out: TrackedDevinCallMeta = {};
  const cwd = nonEmptyString(meta["cognition.ai/cwd"]);
  if (cwd !== undefined) out.cwd = cwd;

  const terminalExit = recordOf(meta.terminal_exit);
  if (terminalExit !== null) {
    if (typeof terminalExit.exit_code === "number" && Number.isInteger(terminalExit.exit_code)) {
      out.exitCode = terminalExit.exit_code;
    } else if (typeof terminalExit.exitCode === "number" && Number.isInteger(terminalExit.exitCode)) {
      out.exitCode = terminalExit.exitCode;
    }
    const signal = nonEmptyString(terminalExit.signal);
    if (signal !== undefined) out.signal = signal;
  }
  return out;
}

export function isDevinCommandPreviewBlock(block: AcpToolCallContent): boolean {
  if (block.type !== "content") return false;
  const inner = recordOf(block.content);
  if (inner === null) return false;
  const innerMeta = recordOf(inner._meta);
  if (innerMeta?.["cognition.ai/preview_is_shell_command"] === true) return true;
  if (inner.type === "resource") {
    const resource = recordOf(inner.resource);
    if (resource?.uri === "tool://preview") return true;
  }
  return false;
}

function extractDevinCommandText(event: AcpToolCallUpdateEvent): string | undefined {
  const parts: string[] = [];
  for (const block of event.content ?? []) {
    if (isDevinCommandPreviewBlock(block)) continue;
    if (block.type === "content" && block.content.type === "text" && typeof block.content.text === "string") {
      parts.push(block.content.text);
    }
  }
  if (parts.length > 0) {
    const joined = parts.join("\n").trim();
    return joined.length > 0 ? joined : undefined;
  }
  if (typeof event.rawOutput === "string") {
    const trimmed = event.rawOutput.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  const rawOut = recordOf(event.rawOutput);
  if (rawOut !== null) {
    const streams = [rawOut.stdout, rawOut.stderr, rawOut.output].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (streams.length > 0) {
      const joined = streams.join("\n").trim();
      return joined.length > 0 ? joined : undefined;
    }
  }
  return undefined;
}

export function devinToolIdentity(event: AcpToolCallUpdateEvent): AcpToolIdentity | undefined {
  const metaPatch = readMetaFromEvent(event);
  if (
    event.toolCallId &&
    (metaPatch.cwd !== undefined || metaPatch.exitCode !== undefined || metaPatch.signal !== undefined)
  ) {
    setTrackedMeta(event.toolCallId, metaPatch);
  }

  const meta = recordOf((event as Record<string, unknown>)._meta);
  const inferenceName = meta !== null ? nonEmptyString(meta["cognition.ai/inferenceToolName"]) : undefined;
  const name = inferenceName ?? nonEmptyString(event.name);
  if (name !== undefined) {
    const kind = event.kind ?? mapDevinToolKind(name);
    return kind !== undefined ? { name, kind } : { name };
  }
  return event.kind !== undefined ? { kind: event.kind } : undefined;
}

export function normalizeDevinCommandEvent(
  event: AcpToolCallUpdateEvent,
  call?: AcpToolCallUpdateEvent,
): AcpToolCallUpdateEvent {
  const normalized: AcpToolCallUpdateEvent = { ...event };
  const tracked = event.toolCallId ? trackedCallMeta.get(event.toolCallId) : undefined;
  const direct = readMetaFromEvent(event);
  const cwd = direct.cwd ?? tracked?.cwd;
  const exitCode = direct.exitCode ?? tracked?.exitCode;
  const signal = direct.signal ?? tracked?.signal;

  if (Array.isArray(normalized.content)) {
    const filtered = normalized.content.filter((block) => !isDevinCommandPreviewBlock(block));
    if (filtered.length !== normalized.content.length) {
      normalized.content = filtered;
    }
  }

  const rawInput = recordOf(normalized.rawInput) ?? recordOf(call?.rawInput);
  if (cwd !== undefined && rawInput !== null && nonEmptyString(rawInput.cwd) === undefined) {
    normalized.rawInput = { ...rawInput, cwd };
  }

  if (exitCode !== undefined || signal !== undefined) {
    const rawOut = recordOf(normalized.rawOutput) ?? {};
    const hasExit = typeof rawOut.exitCode === "number" || typeof rawOut.exit_code === "number";
    const hasSignal = typeof rawOut.signal === "string" && rawOut.signal.length > 0;
    if ((!hasExit && exitCode !== undefined) || (!hasSignal && signal !== undefined)) {
      normalized.rawOutput = {
        ...rawOut,
        ...(!hasExit && exitCode !== undefined ? { exitCode } : {}),
        ...(!hasSignal && signal !== undefined ? { signal } : {}),
      };
    }
  }

  return normalized;
}

export function devinCommandResult(
  event: AcpToolCallUpdateEvent,
): { exitCode?: number; output?: string } | undefined {
  const tracked = event.toolCallId ? trackedCallMeta.get(event.toolCallId) : undefined;
  if (event.toolCallId) trackedCallMeta.delete(event.toolCallId);

  const direct = readMetaFromEvent(event);
  const rawOut = recordOf(event.rawOutput);

  let exitCode = direct.exitCode ?? tracked?.exitCode;
  if (exitCode === undefined && rawOut !== null) {
    if (typeof rawOut.exitCode === "number") exitCode = rawOut.exitCode;
    else if (typeof rawOut.exit_code === "number") exitCode = rawOut.exit_code;
  }

  const signal = direct.signal ?? tracked?.signal ?? (rawOut !== null ? nonEmptyString(rawOut.signal) : undefined);
  let output = extractDevinCommandText(event);

  if (exitCode === undefined && output !== undefined) {
    const match = /^Exited with code (-?\d+)\b/m.exec(output);
    if (match) exitCode = Number.parseInt(match[1], 10);
  }

  if (signal !== undefined) {
    const tag = `[signal ${signal}]`;
    output = output !== undefined && !output.includes(tag) ? `${output}\n${tag}` : (output ?? tag);
  }

  if (exitCode === undefined && output === undefined) return undefined;
  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

export const devinDialectHooks: Omit<AcpDialect, "id" | "maintenance"> = {
  toolIdentity: devinToolIdentity,
  normalizeCommandEvent: normalizeDevinCommandEvent,
  commandResult: devinCommandResult,
};
