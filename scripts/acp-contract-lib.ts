// Pure helpers for the ACP contract check (scripts/acp-contract.ts): reduce
// what `agy acp` and `devin acp` report into a stable shape, and diff it
// against the committed snapshot. Account-specific data (models, thought
// levels, user skills) stays out so the snapshot only moves when the agent does.

export const CONTRACT_AGENTS = ["antigravity", "devin"] as const;
export type ContractAgent = (typeof CONTRACT_AGENTS)[number];

export interface AgentCommand {
  name: string;
  category?: string;
}

export interface AgentProbe {
  initialize: Record<string, unknown>;
  sessionNew: Record<string, unknown>;
  commands: AgentCommand[];
  helpText: string;
}

export interface AgentContract {
  capabilities: string[];
  authMethods: string[];
  configOptions: string[];
  modes: string[];
  commands: string[];
  flags: string[];
}

export type Contract = Record<ContractAgent, AgentContract>;

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Every key path of an object, so a capability that appears or disappears shows up by name. */
export function keyPaths(value: unknown, prefix = ""): string[] {
  if (!isObject(value)) return prefix === "" ? [] : [prefix];
  const entries = Object.entries(value);
  if (entries.length === 0) return prefix === "" ? [] : [prefix];
  return entries.flatMap(([key, child]) => keyPaths(child, prefix === "" ? key : `${prefix}.${key}`));
}

export function parseHelpFlags(helpText: string): string[] {
  return sorted([...helpText.matchAll(/(?:^|[\s,])(--[a-z][a-z0-9_-]*)/gim)].map((match) => match[1] as string));
}

function idsOf(value: unknown, key: string): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => (isObject(entry) && typeof entry[key] === "string" ? [entry[key] as string] : []))
    : [];
}

/**
 * Devin tags user skills with the category "Skills". agy does not tag them, so
 * its user skills are passed in by name and left out.
 */
export function builtinCommands(commands: AgentCommand[], userSkillNames: ReadonlySet<string>): string[] {
  return sorted(
    commands
      .filter((command) => command.category !== "Skills" && !userSkillNames.has(command.name))
      .map((command) => `/${command.name}`),
  );
}

export function contractOf(probe: AgentProbe, userSkillNames: ReadonlySet<string>): AgentContract {
  const configOptions = Array.isArray(probe.sessionNew.configOptions) ? probe.sessionNew.configOptions : [];
  const modes = isObject(probe.sessionNew.modes) ? probe.sessionNew.modes.availableModes : undefined;
  return {
    capabilities: sorted(keyPaths(probe.initialize.agentCapabilities)),
    authMethods: sorted(idsOf(probe.initialize.authMethods, "id")),
    configOptions: sorted(
      configOptions.flatMap((option) =>
        isObject(option) && typeof option.id === "string"
          ? [`${option.id} (${typeof option.category === "string" ? option.category : "-"}, ${String(option.type)})`]
          : [],
      ),
    ),
    modes: sorted(idsOf(modes, "id")),
    commands: builtinCommands(probe.commands, userSkillNames),
    flags: parseHelpFlags(probe.helpText),
  };
}

/** Lines like `+ devin.flags: --cloud`, empty when nothing changed. */
export function diffContracts(previous: Partial<Contract>, current: Partial<Contract>): string[] {
  const lines: string[] = [];
  for (const agent of CONTRACT_AGENTS) {
    const before = previous[agent];
    const after = current[agent];
    if (before === undefined || after === undefined) {
      if (before !== after) lines.push(`${after === undefined ? "-" : "+"} ${agent}: whole contract`);
      continue;
    }
    for (const field of Object.keys(after) as (keyof AgentContract)[]) {
      const old = new Set(before[field] ?? []);
      const now = new Set(after[field]);
      for (const value of now) if (!old.has(value)) lines.push(`+ ${agent}.${field}: ${value}`);
      for (const value of old) if (!now.has(value)) lines.push(`- ${agent}.${field}: ${value}`);
    }
  }
  return lines;
}

/** `name:` from a SKILL.md frontmatter, or undefined. */
export function skillNameFromFrontmatter(text: string): string | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  const name = frontmatter === undefined ? undefined : /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(frontmatter)?.[1];
  return name?.trim() || undefined;
}
