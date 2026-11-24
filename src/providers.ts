import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  antigravityLaunchArgs,
  ANTIGRAVITY_DIALECT_ID,
  ANTIGRAVITY_PROVIDER_ID,
  devinLaunchArgs,
  DEVIN_DIALECT_ID,
  DEVIN_PROVIDER_ID,
  PROVIDER_LABELS,
} from "./agents.ts";

type SkillRoots = { user: string[]; project: string[] };
type ReasoningLevelId = "none" | "low" | "medium" | "high" | "xhigh" | "max";
type ReasoningLevelOption = { id: ReasoningLevelId; label: string };
type ProviderDeclaration = Parameters<BbPluginApi["providers"]["register"]>[0];
type ProviderSettings = Parameters<NonNullable<ProviderDeclaration["deriveProviderOptions"]>>[0]["settings"];

interface AgentLaunch {
  command: string;
  args: string[];
}

interface AgentDefinition {
  id: string;
  dialect: string;
  icon: string;
  skillRoots: SkillRoots;
  resolvesNativeRoots?: boolean;
  reasoningLevels: readonly ReasoningLevelOption[];
  /** The agent compacts inside its `/compact` turn, so bb's compact action finishes when the work does. */
  supportsManualCompaction: boolean;
  signInHint: string;
  expiredHint: string;
  installUrl: string;
  /** Builds the launch from the plugin's settings: once at load (empty settings) and for every command. */
  launch(settings: ProviderSettings): AgentLaunch;
}

// Mirrors what bb's ACP plugin (provider-acp) declares for its own ACP agents,
// so these behave like built-in ones in the composer. Neither Devin nor
// Antigravity uses ACP's boolean `fast` service-tier option (Devin exposes
// `speed` as a per-model config option, which bb lists as a session option;
// Antigravity has no tiers), so `supportsServiceTier` stays false. Neither
// advertises `session/fork`, so fork stays "none". The bridge runs a manual
// compaction as a `/compact` prompt, which each agent declares separately.
const BASE_ACP_CAPABILITIES = {
  supportsServiceTier: false,
  supportsNativeUserQuestion: false,
  supportsThreadArchive: false,
  supportsThreadRename: false,
  fork: "none",
  permissionModes: ["accept-edits", "full"],
} as const;

// Both agents answer `/plan` and `/goal` as their own slash commands, and bb
// passes the composer's command text through to them unchanged.
const COMPOSER_ACTIONS = ["plan", "goal"] as const;

// agy 1.5.16 offers `thought_level` low|medium|high|xhigh (none for Orchestrator models).
const ANTIGRAVITY_REASONING_LEVELS: readonly ReasoningLevelOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
];

// devin 3000.14 offers none..max depending on the model (`none` on 13 of 170,
// no thinking level at all on `adaptive` and a few others).
const DEVIN_REASONING_LEVELS: readonly ReasoningLevelOption[] = [
  { id: "none", label: "None" },
  ...ANTIGRAVITY_REASONING_LEVELS,
  { id: "max", label: "Max" },
];

function stringSetting(settings: ProviderSettings, key: string, fallback: string): string {
  const value = settings[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function register(bb: BbPluginApi, agent: AgentDefinition): void {
  const displayName = PROVIDER_LABELS[agent.id as keyof typeof PROVIDER_LABELS];
  const bridgeOptions = (settings: ProviderSettings) => ({
    acpDialect: agent.dialect,
    acpLaunchSpec: {
      displayName,
      ...agent.launch(settings),
      env: {},
      nativeSkillRoots: agent.skillRoots,
    },
  });
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
    // The static options serve sessionless requests (health, usage, model list).
    // deriveProviderOptions replaces the launch spec for every session and turn
    // command, so a changed setting reaches new sessions without a plugin reload.
    experimental_bridgeOptions: bridgeOptions({}),
    deriveProviderOptions: ({ settings }) => bridgeOptions(settings),
    models: { scope: "host" },
    maintenance: { health: true, usage: true, installation: false },
    capabilities: {
      ...BASE_ACP_CAPABILITIES,
      supportsManualCompaction: agent.supportsManualCompaction,
      permissionModes: [...BASE_ACP_CAPABILITIES.permissionModes],
      reasoningLevels: agent.reasoningLevels.map((level) => level.id),
    },
    composerActions: [...COMPOSER_ACTIONS],
  });
}

export interface AgentCommands {
  devinCommand: string;
  devinProcessModel?: string;
  devinRefusalFallback?: string;
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
    // `devin skills paths`
    skillRoots: {
      user: ["AppData/Roaming/devin/skills", "AppData/Roaming/cognition/skills", ".local/share/devin/skills", ".agents/skills"],
      project: [".devin/skills", ".cognition/skills", ".agents/skills"],
    },
    reasoningLevels: DEVIN_REASONING_LEVELS,
    // devin 3000.14 ends the `/compact` turn at once and compacts afterwards
    // (`_cognition.ai/compaction` started/completed, about 13 s later). bb would
    // show it finished early, and a prompt sent in between cancels it.
    supportsManualCompaction: false,
    signInHint: "Run `devin auth login` on the machine to sign in.",
    expiredHint: "Your Devin session expired. Run `devin auth login`, then reload.",
    installUrl: "https://docs.devin.ai/cli",
    launch: (settings) => ({
      command: stringSetting(settings, "devinCommand", commands.devinCommand),
      args: devinLaunchArgs({
        processModel: settings.devinProcessModel ?? commands.devinProcessModel,
        refusalFallback: settings.devinRefusalFallback ?? commands.devinRefusalFallback,
      }),
    }),
  });

  register(bb, {
    id: ANTIGRAVITY_PROVIDER_ID,
    dialect: ANTIGRAVITY_DIALECT_ID,
    icon: "./assets/icons/antigravity.svg",
    skillRoots: antigravitySkillRoots,
    resolvesNativeRoots: true,
    reasoningLevels: ANTIGRAVITY_REASONING_LEVELS,
    // agy 1.5.16 compacts inside the `/compact` turn.
    supportsManualCompaction: true,
    signInHint: "Run `agy acp --login` on the machine to sign in.",
    expiredHint: "Your Antigravity sign-in expired. Run `agy acp --login`, then reload.",
    installUrl: "https://antigravity.google/docs/getting-started?tab=cli",
    launch: (settings) => {
      const command = stringSetting(settings, "antigravityCommand", commands.antigravityCommand);
      const sandbox =
        settings.antigravitySandbox === undefined ? commands.antigravitySandbox : settings.antigravitySandbox === true;
      return { command, args: antigravityLaunchArgs(command, { sandbox }) };
    },
  });
}
