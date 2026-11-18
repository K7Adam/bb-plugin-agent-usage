import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  antigravityLaunchArgs,
  ANTIGRAVITY_DIALECT_ID,
  ANTIGRAVITY_PROVIDER_ID,
  DEVIN_DIALECT_ID,
  DEVIN_PROVIDER_ID,
  PROVIDER_LABELS,
} from "./agents.ts";

type SkillRoots = { user: string[]; project: string[] };
type ReasoningLevelId = "none" | "low" | "medium" | "high" | "xhigh" | "max";
type ReasoningLevelOption = { id: ReasoningLevelId; label: string };

interface AgentDefinition {
  id: string;
  dialect: string;
  icon: string;
  command: string;
  args: string[];
  skillRoots: SkillRoots;
  resolvesNativeRoots?: boolean;
  reasoningLevels: readonly ReasoningLevelOption[];
  signInHint: string;
  expiredHint: string;
  installUrl: string;
  deriveProviderOptions?: Parameters<BbPluginApi["providers"]["register"]>[0]["deriveProviderOptions"];
}

// Mirrors what bb's ACP plugin (provider-acp) declares for its own ACP agents,
// so these behave like built-in ones in the composer. Neither Devin nor
// Antigravity uses ACP's boolean `fast` service-tier option (Devin exposes
// `speed` as a model_config option; Antigravity has no tiers), so
// `supportsServiceTier` stays false.
const BASE_ACP_CAPABILITIES = {
  supportsServiceTier: false,
  supportsNativeUserQuestion: false,
  supportsManualCompaction: false,
  supportsThreadArchive: false,
  supportsThreadRename: false,
  fork: "none",
  permissionModes: ["accept-edits", "full"],
} as const;

const ANTIGRAVITY_REASONING_LEVELS: readonly ReasoningLevelOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
];

const DEVIN_REASONING_LEVELS: readonly ReasoningLevelOption[] = [
  { id: "none", label: "None" },
  ...ANTIGRAVITY_REASONING_LEVELS,
];

function register(bb: BbPluginApi, agent: AgentDefinition): void {
  const displayName = PROVIDER_LABELS[agent.id as keyof typeof PROVIDER_LABELS];
  const launch = {
    displayName,
    command: agent.command,
    args: agent.args,
    env: {},
    nativeSkillRoots: agent.skillRoots,
  };
  bb.providers.register({
    id: agent.id,
    displayName,
    family: "acp",
    icon: agent.icon,
    strings: { signInHint: agent.signInHint, expiredHint: agent.expiredHint, installUrl: agent.installUrl },
    reasoningLevels: [...agent.reasoningLevels],
    experimental_visibility: "installed",
    experimental_nativeSkillRoots: agent.skillRoots,
    ...(agent.resolvesNativeRoots ? { experimental_resolvesNativeRoots: true } : {}),
    experimental_bridgeOptions: { acpDialect: agent.dialect, acpLaunchSpec: launch },
    ...(agent.deriveProviderOptions ? { deriveProviderOptions: agent.deriveProviderOptions } : {}),
    models: { scope: "host" },
    maintenance: { health: true, usage: true, installation: false },
    capabilities: {
      ...BASE_ACP_CAPABILITIES,
      permissionModes: [...BASE_ACP_CAPABILITIES.permissionModes],
      reasoningLevels: agent.reasoningLevels.map((level) => level.id),
    },
    composerActions: [],
  });
}

export interface AgentCommands {
  devinCommand: string;
  antigravityCommand: string;
  antigravitySandbox?: boolean;
}

export function registerProviders(bb: BbPluginApi, commands: AgentCommands): void {
  const antigravitySkillRoots: SkillRoots = {
    // Matches agy CLI's user, global config, Gemini, built-in, and shared skill roots.
    // Enabled agy plugin skills are resolved dynamically via `resolveNativeRoots`.
    user: [
      ".gemini/antigravity-cli/skills",
      ".gemini/config/skills",
      ".gemini/skills",
      ".gemini/antigravity-cli/builtin/skills",
      ".agents/skills",
    ],
    project: [".agents/skills", ".agent/skills", ".gemini/skills", ".gemini/antigravity-cli/skills"],
  };

  register(bb, {
    id: DEVIN_PROVIDER_ID,
    dialect: DEVIN_DIALECT_ID,
    icon: "./assets/icons/devin.svg",
    command: commands.devinCommand,
    args: ["acp"],
    // `devin skills paths`
    skillRoots: {
      user: ["AppData/Roaming/devin/skills", "AppData/Roaming/cognition/skills", ".local/share/devin/skills", ".agents/skills"],
      project: [".devin/skills", ".cognition/skills", ".agents/skills"],
    },
    reasoningLevels: DEVIN_REASONING_LEVELS,
    signInHint: "Run `devin auth login` on the machine to sign in.",
    expiredHint: "Your Devin session expired. Run `devin auth login`, then reload.",
    installUrl: "https://docs.devin.ai/cli",
  });

  register(bb, {
    id: ANTIGRAVITY_PROVIDER_ID,
    dialect: ANTIGRAVITY_DIALECT_ID,
    icon: "./assets/icons/antigravity.svg",
    command: commands.antigravityCommand,
    args: antigravityLaunchArgs(commands.antigravityCommand, { sandbox: commands.antigravitySandbox }),
    skillRoots: antigravitySkillRoots,
    resolvesNativeRoots: true,
    reasoningLevels: ANTIGRAVITY_REASONING_LEVELS,
    signInHint: "Run `agy acp --login` on the machine to sign in.",
    expiredHint: "Your Antigravity sign-in expired. Run `agy acp --login`, then reload.",
    installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
    deriveProviderOptions({ settings }) {
      const cmd =
        typeof settings.antigravityCommand === "string" && settings.antigravityCommand.trim().length > 0
          ? settings.antigravityCommand.trim()
          : commands.antigravityCommand;
      const sandbox = settings.antigravitySandbox === true;
      return {
        acpDialect: ANTIGRAVITY_DIALECT_ID,
        acpLaunchSpec: {
          displayName: PROVIDER_LABELS[ANTIGRAVITY_PROVIDER_ID],
          command: cmd,
          args: antigravityLaunchArgs(cmd, { sandbox }),
          env: {},
          nativeSkillRoots: antigravitySkillRoots,
        },
      };
    },
  });
}
