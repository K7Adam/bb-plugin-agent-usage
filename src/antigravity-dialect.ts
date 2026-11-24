// ACP dialect hooks for Google Antigravity (`agy acp`). Uses only the public
// `AcpDialect` surface (`toolIdentity`, `classifyToolCall`,
// `normalizeCommandEvent`, `commandResult`) so Antigravity's native commands,
// subagents, background task controls, and sandbox bypasses render cleanly in
// bb without intercepting the bridge's stdio stream.

import type {
  AcpClassifiedToolCall,
  AcpDialect,
  AcpToolCallUpdateEvent,
  AcpToolIdentity,
  AcpToolKind,
} from "@get-bb/plugin-sdk/provider-bridge/acp";

const PRESENTATION_DETAIL_MAX_LENGTH = 280;

export const CANONICAL_ANTIGRAVITY_TOOLS: ReadonlySet<string> = new Set([
  // Execution
  "run_command",
  // File reading
  "read_file",
  "view_file",
  "view_file_outline",
  "view_code_item",
  "list_dir",
  "list_resources",
  "read_resource",
  // File editing
  "write_file",
  "edit_file",
  "replace_file_content",
  "multi_replace_file_content",
  // Search
  "grep_search",
  "code_search",
  "find_by_name",
  // Web / Fetch
  "search_web",
  "read_url_content",
  // Subagents & swarms
  "invoke_subagent",
  "define_subagent",
  "manage_subagents",
  "send_message",
  "swarm",
  "read_board",
  "post_message",
  "swarm_wait",
  "run_workflow",
  // Background tasks & scheduling
  "manage_task",
  "schedule",
  // User interaction
  "ask_question",
]);

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function truncateDetail(text: string): string {
  return text.length > PRESENTATION_DETAIL_MAX_LENGTH
    ? `${text.slice(0, PRESENTATION_DETAIL_MAX_LENGTH - 3)}...`
    : text;
}

// Antigravity ACP on Windows occasionally serializes file URL pathnames with a
// leading slash (e.g. `/C:/Users/...`). Strip only that drive-letter prefix
// while leaving POSIX absolute paths untouched.
export function normalizeAntigravityPath(raw: string): string {
  const trimmed = raw.trim();
  return /^\/[A-Za-z]:[\\/]/.test(trimmed) ? trimmed.slice(1) : trimmed;
}

function pathBasename(filePath: string): string {
  const stripped = filePath.replace(/[\\/]+$/, "");
  const sepIndex = Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"));
  return sepIndex >= 0 && sepIndex < stripped.length - 1 ? stripped.slice(sepIndex + 1) : stripped || filePath;
}

function firstEventLocationPath(event: AcpToolCallUpdateEvent): string | undefined {
  for (const loc of event.locations ?? []) {
    const path = nonEmptyString(loc?.path);
    if (path !== undefined) return path;
  }
  return undefined;
}

function normalizeToolCandidate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (CANONICAL_ANTIGRAVITY_TOOLS.has(trimmed)) return trimmed;
  const underscored = trimmed.replace(/\s+/g, "_");
  return CANONICAL_ANTIGRAVITY_TOOLS.has(underscored) ? underscored : null;
}

function extractEventOutputText(event: AcpToolCallUpdateEvent): string {
  const parts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      parts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collect(entry);
      return;
    }
    const obj = recordOf(value);
    if (obj === null) return;
    for (const key of ["text", "output", "stdout", "stderr"]) {
      if (typeof obj[key] === "string") parts.push(obj[key] as string);
    }
    if (typeof obj.content === "string") {
      parts.push(obj.content);
    } else if (obj.content !== undefined && obj.content !== null) {
      collect(obj.content);
    }
  };
  if (event.content !== undefined) collect(event.content);
  if (event.rawOutput !== undefined) collect(event.rawOutput);
  return parts.join("\n");
}

export function inferAntigravityToolName(event: AcpToolCallUpdateEvent): string | null {
  const meta = recordOf((event as Record<string, unknown>)._meta);
  if (meta !== null) {
    const metaName =
      normalizeToolCandidate(meta.tool) ??
      normalizeToolCandidate(meta.name) ??
      normalizeToolCandidate(meta.toolName) ??
      normalizeToolCandidate(meta.tool_name);
    if (metaName !== null) return metaName;
  }

  const directName = normalizeToolCandidate(event.name);
  if (directName !== null) return directName;

  if (typeof event.title === "string") {
    const directTitle = normalizeToolCandidate(event.title);
    if (directTitle !== null) return directTitle;
    const colon = event.title.indexOf(":");
    if (colon > 0) {
      const prefix = normalizeToolCandidate(event.title.slice(0, colon));
      if (prefix !== null) return prefix;
    }
  }

  const rawInput = recordOf(event.rawInput);
  if (rawInput === null) return null;

  if (typeof rawInput.CommandLine === "string" || typeof rawInput.command === "string") return "run_command";
  if (typeof rawInput.TypeName === "string" && typeof rawInput.Prompt === "string") return "invoke_subagent";
  if (typeof rawInput.SystemPrompt === "string" && typeof rawInput.Name === "string" && typeof rawInput.Description === "string") {
    return "define_subagent";
  }
  if (typeof rawInput.Action === "string" && (Array.isArray(rawInput.ConversationIds) || rawInput.Action === "kill_all")) {
    return "manage_subagents";
  }
  if (typeof rawInput.Recipient === "string" && typeof rawInput.Message === "string") return "send_message";
  if (
    typeof rawInput.Action === "string" &&
    (typeof rawInput.TaskId === "string" ||
      rawInput.Input !== undefined ||
      ["list", "kill", "status", "send_input"].includes(rawInput.Action))
  ) {
    return "manage_task";
  }
  if (
    typeof rawInput.Prompt === "string" &&
    (typeof rawInput.DurationSeconds === "number" || typeof rawInput.CronExpression === "string")
  ) {
    return "schedule";
  }
  if (typeof rawInput.Script === "string" || typeof rawInput.ScriptPath === "string") return "run_workflow";
  if (
    typeof rawInput.action === "string" &&
    ["status", "models", "add", "model", "kill", "title"].includes(rawInput.action)
  ) {
    return "swarm";
  }
  if (Array.isArray(rawInput.questions)) return "ask_question";
  if (typeof rawInput.Path === "string" && (rawInput.Target !== undefined || rawInput.Replacement !== undefined)) {
    return "edit_file";
  }
  if (typeof rawInput.Path === "string" && rawInput.Content !== undefined) return "write_file";
  if (
    typeof rawInput.Path === "string" &&
    (rawInput.StartLine !== undefined ||
      rawInput.EndLine !== undefined ||
      rawInput.ByteOffset !== undefined ||
      event.kind === "read")
  ) {
    return "read_file";
  }
  return null;
}

export function mapAntigravityToolKind(toolName: string | null, fallbackKind?: AcpToolKind): AcpToolKind {
  switch (toolName) {
    case "run_command":
      return "execute";
    case "read_file":
    case "view_file":
    case "view_file_outline":
    case "view_code_item":
    case "list_dir":
    case "list_resources":
    case "read_resource":
      return "read";
    case "write_file":
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
      return "edit";
    case "grep_search":
    case "code_search":
    case "find_by_name":
      return "search";
    case "search_web":
    case "read_url_content":
      return "fetch";
    default:
      return fallbackKind ?? "other";
  }
}

export interface ParsedCommandOutput {
  cleanOutput: string;
  exitCode: number | null;
  isBackgrounded: boolean;
  backgroundTaskId: string | null;
}

export function parseAntigravityCommandOutput(rawText: string): ParsedCommandOutput {
  const exitCodeMatch = /^(?:The c|C)ommand exited with code (-?\d+)\b\.?/m.exec(rawText);
  const exitCode = exitCodeMatch ? Number.parseInt(exitCodeMatch[1], 10) : null;

  const bgMatch = /Tool is running as a background task with task id:[ \t]*([^\s\r\n][^\r\n]*)/i.exec(rawText);
  const isBackgrounded = bgMatch !== null;
  const backgroundTaskId = bgMatch ? bgMatch[1].trim() : null;

  // Preserve sandbox diagnostic headers before stripping Antigravity's timestamp boilerplate.
  const diagnosticLines: string[] = [];
  const body = rawText.replace(/^There were sandbox errors[^\r\n]*(?:\r?\n)?/gm, (line) => {
    diagnosticLines.push(line.replace(/\r?\n$/, ""));
    return "";
  });

  const headerSplit =
    /^(?:(?:Created At:[^\r\n]*|Completed At:[^\r\n]*|(?:The c|C)ommand exited with code -?\d+\b[^\r\n]*|The user changed the command to be run to:[^\r\n]*|This command includes call\(s\) to[^\r\n]*|[ \t]*)\r?\n)*(?:Command output|Output):\r?\n/i.exec(
      body,
    );

  let cleanOutput = headerSplit
    ? body.slice(headerSplit[0].length)
    : body
        .replace(/^Created At:[^\r\n]*(?:\r?\n)?/gm, "")
        .replace(/^Completed At:[^\r\n]*(?:\r?\n)?/gm, "")
        .replace(/^(?:The c|C)ommand exited with code -?\d+\b\.?[^\r\n]*(?:\r?\n)?/gm, "")
        .replace(/^\r?\n+/, "");

  if (cleanOutput.trim() === "" && (diagnosticLines.length > 0 || (exitCode !== null && exitCode !== 0))) {
    cleanOutput = diagnosticLines.length > 0 ? diagnosticLines.join("\n") : (exitCodeMatch?.[0].trim() ?? "");
  } else if (diagnosticLines.length > 0) {
    cleanOutput = `${diagnosticLines.join("\n")}\n${cleanOutput}`;
  }

  return { cleanOutput, exitCode, isBackgrounded, backgroundTaskId };
}

const normalizedExitCodes = new WeakMap<object, number>();

export function antigravityToolIdentity(event: AcpToolCallUpdateEvent): AcpToolIdentity | undefined {
  const toolName = inferAntigravityToolName(event);
  if (toolName !== null) {
    return { name: toolName, kind: mapAntigravityToolKind(toolName, event.kind) };
  }
  const direct = nonEmptyString(event.name);
  if (direct !== undefined) {
    return { name: direct, kind: mapAntigravityToolKind(direct, event.kind) };
  }
  return event.kind !== undefined ? { kind: event.kind } : undefined;
}

export function normalizeAntigravityCommandEvent(
  event: AcpToolCallUpdateEvent,
  call?: AcpToolCallUpdateEvent,
): AcpToolCallUpdateEvent {
  const normalized: AcpToolCallUpdateEvent = { ...event };
  const rawInput = recordOf(event.rawInput) ?? recordOf(call?.rawInput);

  if (rawInput !== null) {
    const updatedInput: Record<string, unknown> = { ...rawInput };
    if (typeof updatedInput.CommandLine === "string" && typeof updatedInput.command !== "string") {
      updatedInput.command = updatedInput.CommandLine;
    }
    normalized.rawInput = updatedInput;

    const command = nonEmptyString(updatedInput.CommandLine) ?? nonEmptyString(updatedInput.command);
    if (command !== undefined && (!normalized.title || normalized.title.trim().toLowerCase() === "run_command")) {
      normalized.title = command;
    }
  }

  let detectedExitCode: number | null = null;
  if (typeof normalized.rawOutput === "string") {
    const parsed = parseAntigravityCommandOutput(normalized.rawOutput);
    if (parsed.exitCode !== null) detectedExitCode = parsed.exitCode;
    normalized.rawOutput = parsed.cleanOutput;
  } else {
    const rawOut = recordOf(normalized.rawOutput);
    if (rawOut !== null) {
      const updated = { ...rawOut };
      for (const key of ["output", "stdout"] as const) {
        if (typeof updated[key] === "string") {
          const parsed = parseAntigravityCommandOutput(updated[key] as string);
          if (parsed.exitCode !== null) detectedExitCode = parsed.exitCode;
          updated[key] = parsed.cleanOutput;
        }
      }
      normalized.rawOutput = updated;
    }
  }

  if (Array.isArray(normalized.content)) {
    normalized.content = normalized.content.map((block) => {
      if (block.type === "content" && block.content.type === "text" && typeof block.content.text === "string") {
        const parsed = parseAntigravityCommandOutput(block.content.text);
        if (parsed.exitCode !== null) detectedExitCode = parsed.exitCode;
        return {
          ...block,
          content: {
            ...block.content,
            text: parsed.cleanOutput,
          },
        };
      }
      return block;
    });
  }

  if (detectedExitCode !== null) {
    normalizedExitCodes.set(normalized, detectedExitCode);
  }
  return normalized;
}

export function antigravityCommandResult(
  event: AcpToolCallUpdateEvent,
): { exitCode?: number; output?: string } | undefined {
  let exitCode = normalizedExitCodes.get(event);
  const rawOut = recordOf(event.rawOutput);
  if (exitCode === undefined && rawOut !== null) {
    if (typeof rawOut.exitCode === "number") exitCode = rawOut.exitCode;
    else if (typeof rawOut.exit_code === "number") exitCode = rawOut.exit_code;
  }

  const outputText = extractEventOutputText(event);
  let cleanOutput: string | undefined;
  if (outputText.length > 0) {
    const parsed = parseAntigravityCommandOutput(outputText);
    if (exitCode === undefined && parsed.exitCode !== null) exitCode = parsed.exitCode;
    if (parsed.cleanOutput.length > 0) cleanOutput = parsed.cleanOutput;
  }

  if (exitCode === undefined && cleanOutput === undefined) return undefined;
  return {
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(cleanOutput !== undefined ? { output: cleanOutput } : {}),
  };
}

type ToolLabel = { pending: string; completed: string };

// The `swarm` tool of agy's /swarm coordinator: one label per action, with the
// worker (or the swarm title) as the row title and a worker's brief as detail.
const SWARM_ACTION_LABELS: Record<string, ToolLabel> = {
  add: { pending: "Adding worker", completed: "Added worker" },
  kill: { pending: "Stopping worker", completed: "Stopped worker" },
  model: { pending: "Switching worker model", completed: "Switched worker model" },
  models: { pending: "Listing worker models", completed: "Listed worker models" },
  status: { pending: "Checking swarm", completed: "Checked swarm" },
  title: { pending: "Naming swarm", completed: "Named swarm" },
};

function classifySwarmAction(event: AcpToolCallUpdateEvent, rawInput: Record<string, unknown>): AcpClassifiedToolCall {
  const action = nonEmptyString(rawInput.action);
  const label = (action !== undefined ? SWARM_ACTION_LABELS[action] : undefined) ?? {
    pending: "Coordinating swarm",
    completed: "Updated swarm",
  };
  const subject = action === "title" ? nonEmptyString(rawInput.title) : nonEmptyString(rawInput.name);
  const brief = action === "add" ? nonEmptyString(rawInput.brief) : undefined;
  return {
    item: { type: "tool", tool: "swarm", args: event.rawInput },
    presentation: {
      label,
      icon: { glyph: "Bot" },
      title: subject ?? (action ? `Swarm ${action}` : "Swarm"),
      ...(brief !== undefined ? { detail: truncateDetail(brief) } : {}),
    },
  };
}

function swarmBoardTool(
  event: AcpToolCallUpdateEvent,
  tool: string,
  label: ToolLabel,
  detail?: string,
): AcpClassifiedToolCall {
  return {
    item: { type: "tool", tool, args: event.rawInput },
    presentation: {
      label,
      icon: { glyph: "Bot" },
      title: "Swarm board",
      ...(detail !== undefined ? { detail: truncateDetail(detail) } : {}),
    },
  };
}

type FileChange = { path: string; kind: "add" | "update"; oldText?: string; newText?: string };

// agy reports the finished write with `/C:/...` in its diff and locations, which
// bb cannot open on Windows. Mirrors the bridge's own diff handling with the
// drive-letter slash removed.
function antigravityFileChanges(event: AcpToolCallUpdateEvent, rawInput: Record<string, unknown>): FileChange[] {
  const fromDiffs: FileChange[] = [];
  for (const entry of event.content ?? []) {
    const block = recordOf(entry);
    const path = nonEmptyString(block?.path);
    if (block?.type !== "diff" || path === undefined) continue;
    const oldText = typeof block.oldText === "string" ? block.oldText : undefined;
    const newText = typeof block.newText === "string" ? block.newText : undefined;
    fromDiffs.push({
      path: normalizeAntigravityPath(path),
      kind: oldText === undefined ? "add" : "update",
      ...(oldText !== undefined ? { oldText } : {}),
      ...(newText !== undefined ? { newText } : {}),
    });
  }
  if (fromDiffs.length > 0) return fromDiffs;
  const rawPath =
    nonEmptyString(rawInput.Path) ??
    nonEmptyString(rawInput.AbsolutePath) ??
    nonEmptyString(rawInput.TargetFile) ??
    nonEmptyString(rawInput.path) ??
    firstEventLocationPath(event);
  return rawPath === undefined ? [] : [{ path: normalizeAntigravityPath(rawPath), kind: "update" }];
}

function classifyAntigravityFileChange(
  event: AcpToolCallUpdateEvent,
  rawInput: Record<string, unknown>,
): AcpClassifiedToolCall | undefined {
  const changes = antigravityFileChanges(event, rawInput);
  const [first] = changes;
  if (first === undefined) return undefined;
  return {
    item: { type: "fileChange", changes },
    presentation: {
      label: { pending: "Writing file", completed: "Wrote file" },
      icon: { glyph: "EditFile" },
      title: changes.length === 1 ? pathBasename(first.path) : `${changes.length} files`,
    },
  };
}

export function classifyAntigravityToolCall(event: AcpToolCallUpdateEvent): AcpClassifiedToolCall | undefined {
  const toolName = inferAntigravityToolName(event);
  if (toolName === null) return undefined;
  const rawInput = recordOf(event.rawInput) ?? {};

  switch (toolName) {
    case "read_file":
    case "view_file":
    case "view_file_outline":
    case "view_code_item": {
      const rawPath =
        nonEmptyString(rawInput.Path) ??
        nonEmptyString(rawInput.AbsolutePath) ??
        nonEmptyString(rawInput.path) ??
        firstEventLocationPath(event);
      if (rawPath === undefined) return undefined;
      const path = normalizeAntigravityPath(rawPath);
      return {
        item: { type: "fileRead", path },
        presentation: {
          label: { pending: "Reading file", completed: "Read file" },
          icon: { glyph: "FileText" },
          title: pathBasename(path),
        },
      };
    }

    case "grep_search":
    case "code_search": {
      const query =
        nonEmptyString(rawInput.Query) ??
        nonEmptyString(rawInput.query) ??
        nonEmptyString(rawInput.Pattern) ??
        nonEmptyString(rawInput.pattern);
      if (query === undefined) return undefined;
      const rawPath =
        nonEmptyString(rawInput.SearchPath) ??
        nonEmptyString(rawInput.path) ??
        nonEmptyString(rawInput.Directory);
      const path = rawPath !== undefined ? normalizeAntigravityPath(rawPath) : undefined;
      return {
        item: {
          type: "search",
          mode: "content",
          query,
          ...(path !== undefined ? { path } : {}),
        },
        presentation: {
          label: { pending: "Searching files", completed: "Searched files" },
          icon: { glyph: "Search" },
          title: truncateDetail(query),
        },
      };
    }

    case "find_by_name": {
      const query =
        nonEmptyString(rawInput.Pattern) ??
        nonEmptyString(rawInput.pattern) ??
        nonEmptyString(rawInput.glob);
      if (query === undefined) return undefined;
      const rawPath = nonEmptyString(rawInput.SearchDirectory) ?? nonEmptyString(rawInput.path);
      const path = rawPath !== undefined ? normalizeAntigravityPath(rawPath) : undefined;
      return {
        item: {
          type: "search",
          mode: "path",
          query,
          ...(path !== undefined ? { path } : {}),
        },
        presentation: {
          label: { pending: "Finding files", completed: "Found files" },
          icon: { glyph: "FolderOpen" },
          title: truncateDetail(query),
        },
      };
    }

    case "search_web": {
      const query = nonEmptyString(rawInput.query) ?? nonEmptyString(rawInput.Query);
      if (query === undefined) return undefined;
      const domain = nonEmptyString(rawInput.domain) ?? nonEmptyString(rawInput.Domain);
      return {
        item: { type: "webSearch", queries: [query] },
        presentation: {
          label: { pending: "Searching web", completed: "Searched web" },
          icon: { glyph: "Search" },
          title: truncateDetail(query),
          ...(domain !== undefined ? { detail: domain } : {}),
        },
      };
    }

    case "run_command": {
      const commandLine = nonEmptyString(rawInput.CommandLine) ?? nonEmptyString(rawInput.command);
      const summary = nonEmptyString(rawInput.toolSummary) ?? nonEmptyString(rawInput.description);
      const bypassSandbox = rawInput.BypassSandbox === true;
      const parsed = parseAntigravityCommandOutput(extractEventOutputText(event));

      return {
        item: {
          type: "command",
          command: commandLine ?? "",
          cwd: nonEmptyString(rawInput.Cwd) ?? "",
          ...(summary !== undefined ? { description: summary } : {}),
          ...(parsed.exitCode !== null ? { exitCode: parsed.exitCode } : {}),
        },
        presentation: {
          label: {
            pending: "Running command",
            completed: parsed.isBackgrounded ? "Started background command" : "Ran command",
          },
          icon: { glyph: "Terminal" },
          title: summary ?? commandLine ?? event.title ?? "Command",
          ...(summary !== undefined && commandLine !== undefined ? { detail: truncateDetail(commandLine) } : {}),
          ...(bypassSandbox
            ? {
                badge: {
                  glyph: "ShieldAlert",
                  label: "Outside of sandbox",
                  hint: "Command runs outside the sandbox",
                  tone: "destructive" as const,
                },
              }
            : {}),
        },
      };
    }

    case "invoke_subagent": {
      const role = nonEmptyString(rawInput.Role);
      const typeName = nonEmptyString(rawInput.TypeName);
      const model = nonEmptyString(rawInput.Model);
      const workspace = nonEmptyString(rawInput.Workspace);
      const prompt = nonEmptyString(rawInput.Prompt);

      const outputText = extractEventOutputText(event);
      const rawOut = recordOf(event.rawOutput);
      const conversationId =
        nonEmptyString(rawOut?.conversationId) ??
        /"conversationId"\s*:\s*"([^"]+)"/.exec(outputText)?.[1] ??
        (/\bSubagent spawned\b/i.test(outputText) ? /\bconversationId:[ \t]*([^\s,]+)/i.exec(outputText)?.[1] : undefined);

      const label = role ?? typeName ?? "Subagent";
      const metaParts = [
        role && typeName && typeName !== role ? typeName : undefined,
        model && model !== "inherit" ? model : undefined,
        workspace && workspace !== "inherit" ? workspace : undefined,
      ].filter((part): part is string => part !== undefined);

      const detail =
        metaParts.length > 0
          ? metaParts.join(" · ")
          : prompt !== undefined
            ? prompt.length > 120
              ? `${prompt.slice(0, 117)}...`
              : prompt
            : undefined;

      return {
        item: {
          type: "delegation",
          childRef: conversationId ?? event.toolCallId,
          label,
          ...(detail !== undefined ? { summary: detail } : {}),
          background: true,
        },
        presentation: {
          label: { pending: "Running subagent", completed: "Subagent launched" },
          icon: { glyph: "Bot" },
          title: label,
          ...(detail !== undefined ? { detail: truncateDetail(detail) } : {}),
        },
      };
    }

    case "define_subagent": {
      const name = nonEmptyString(rawInput.Name);
      const description = nonEmptyString(rawInput.Description);
      return {
        item: { type: "tool", tool: "define_subagent", args: event.rawInput },
        presentation: {
          label: { pending: "Defining subagent", completed: "Defined subagent" },
          icon: { glyph: "Bot" },
          title: name ? `Define subagent ${name}` : "Define subagent",
          ...(description !== undefined ? { detail: truncateDetail(description) } : {}),
        },
      };
    }

    case "manage_subagents": {
      const action = nonEmptyString(rawInput.Action);
      const ids = Array.isArray(rawInput.ConversationIds)
        ? rawInput.ConversationIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).join(", ")
        : undefined;
      const isList = action === "list";
      const isStop = action === "kill" || action === "kill_all";
      return {
        item: { type: "tool", tool: "manage_subagents", args: event.rawInput },
        presentation: {
          label: {
            pending: isList ? "Listing subagents" : isStop ? "Stopping subagents" : "Managing subagents",
            completed: isList ? "Listed subagents" : isStop ? "Stopped subagents" : "Managed subagents",
          },
          icon: { glyph: "Bot" },
          title: isList ? "List subagents" : isStop ? "Stop subagents" : "Manage subagents",
          ...(ids ? { detail: truncateDetail(ids) } : {}),
        },
      };
    }

    case "send_message": {
      const recipient = nonEmptyString(rawInput.Recipient);
      const message = nonEmptyString(rawInput.Message);
      return {
        item: { type: "tool", tool: "send_message", args: event.rawInput },
        presentation: {
          label: { pending: "Messaging subagent", completed: "Messaged subagent" },
          icon: { glyph: "Bot" },
          title: recipient ? `Message ${recipient}` : "Message subagent",
          ...(message !== undefined ? { detail: truncateDetail(message.slice(0, 120)) } : {}),
        },
      };
    }

    case "manage_task": {
      const action = nonEmptyString(rawInput.Action);
      const taskId = nonEmptyString(rawInput.TaskId);
      const labels: Record<string, { pending: string; completed: string }> = {
        list: { pending: "Listing background tasks", completed: "Listed background tasks" },
        status: { pending: "Checking background task", completed: "Checked background task" },
        kill: { pending: "Stopping background task", completed: "Stopped background task" },
        send_input: { pending: "Sending input to task", completed: "Sent input to task" },
      };
      return {
        item: { type: "tool", tool: "manage_task", args: event.rawInput },
        presentation: {
          label: (action ? labels[action] : undefined) ?? {
            pending: "Managing background task",
            completed: "Managed background task",
          },
          icon: { glyph: "Terminal" },
          title: taskId ? `${action ?? "Task"}: ${taskId}` : action ? `Task ${action}` : "Manage task",
        },
      };
    }

    case "schedule": {
      const duration = typeof rawInput.DurationSeconds === "number" ? rawInput.DurationSeconds : undefined;
      const cron = nonEmptyString(rawInput.CronExpression);
      const prompt = nonEmptyString(rawInput.Prompt);
      const scheduleDesc = cron ? `cron: ${cron}` : duration !== undefined ? `${duration}s timer` : undefined;
      return {
        item: { type: "tool", tool: "schedule", args: event.rawInput },
        presentation: {
          label: { pending: "Scheduling task", completed: "Scheduled task" },
          icon: { glyph: "Clock" },
          title: scheduleDesc ? `Schedule (${scheduleDesc})` : "Schedule task",
          ...(prompt !== undefined ? { detail: truncateDetail(prompt.slice(0, 120)) } : {}),
        },
      };
    }

    case "swarm":
      return classifySwarmAction(event, rawInput);

    case "read_board":
      return swarmBoardTool(event, "read_board", { pending: "Reading swarm board", completed: "Read swarm board" });

    case "post_message": {
      const message =
        nonEmptyString(rawInput.message) ?? nonEmptyString(rawInput.text) ?? nonEmptyString(rawInput.Message);
      return swarmBoardTool(event, "post_message", { pending: "Posting to swarm board", completed: "Posted to swarm board" }, message);
    }

    case "swarm_wait":
      return swarmBoardTool(event, "swarm_wait", { pending: "Waiting for the swarm", completed: "Swarm replied" });

    case "write_file":
    case "edit_file":
    case "replace_file_content":
    case "multi_replace_file_content":
      return classifyAntigravityFileChange(event, rawInput);

    case "run_workflow": {
      const description = nonEmptyString(rawInput.Description);
      return {
        item: { type: "tool", tool: "run_workflow", args: event.rawInput },
        presentation: {
          label: { pending: "Running workflow", completed: "Ran workflow" },
          icon: { glyph: "Workflow" },
          title: description ?? "Run workflow",
        },
      };
    }

    case "ask_question":
      return {
        item: { type: "tool", tool: "ask_question", args: event.rawInput },
        presentation: {
          label: { pending: "Asking question", completed: "Asked question" },
          icon: { glyph: "HelpCircle" },
          title: "Ask question",
        },
      };

    default:
      return undefined;
  }
}

export const antigravityDialectHooks: Omit<AcpDialect, "id" | "maintenance"> = {
  toolIdentity: antigravityToolIdentity,
  classifyToolCall: classifyAntigravityToolCall,
  normalizeCommandEvent: normalizeAntigravityCommandEvent,
  commandResult: antigravityCommandResult,
};
