import type { BbPluginApi } from "@get-bb/plugin-sdk";

import {
  ANTIGRAVITY_DIALECT_ID,
  ANTIGRAVITY_PROVIDER_ID,
  DEVIN_DIALECT_ID,
  DEVIN_PROVIDER_ID,
  PROVIDER_LABELS,
} from "./agents.ts";

type SkillRoots = { user: string[]; project: string[] };

interface AgentDefinition {
  id: string;
  dialect: string;
  icon: string;
  command: string;
  args: string[];
  skillRoots: SkillRoots;
  signInHint: string;
  expiredHint: string;
  installUrl: string;
}

// Mirrors what bb's ACP plugin (provider-acp-next) declares for its own ACP
// agents, so these behave like built-in ones in the composer.
const ACP_CAPABILITIES = {
  supportsServiceTier: true,
  supportsNativeUserQuestion: false,
  supportsManualCompaction: false,
  supportsThreadArchive: false,
  supportsThreadRename: false,
  fork: "none",
  permissionModes: ["accept-edits", "full"],
  reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
} as const;

const REASONING_LEVELS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "xhigh", label: "Extra High" },
  { id: "max", label: "Max" },
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
    serviceTiers: [
      { id: "default", label: "Default" },
      { id: "fast", label: "Fast" },
    ],
    reasoningLevels: REASONING_LEVELS,
    experimental_visibility: "installed",
    experimental_nativeSkillRoots: agent.skillRoots,
    experimental_bridgeOptions: { acpDialect: agent.dialect, acpLaunchSpec: launch },
    models: { scope: "host" },
    maintenance: { health: true, usage: true, installation: false },
    capabilities: { ...ACP_CAPABILITIES, permissionModes: [...ACP_CAPABILITIES.permissionModes], reasoningLevels: [...ACP_CAPABILITIES.reasoningLevels] },
    composerActions: [],
  });
}

export interface AgentCommands {
  devinCommand: string;
  antigravityCommand: string;
}

export function registerProviders(bb: BbPluginApi, commands: AgentCommands): void {
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
    signInHint: "Run `devin auth login` on the machine to sign in.",
    expiredHint: "Your Devin session expired. Run `devin auth login`, then reload.",
    installUrl: "https://docs.devin.ai/cli",
  });
  register(bb, {
    id: ANTIGRAVITY_PROVIDER_ID,
    dialect: ANTIGRAVITY_DIALECT_ID,
    icon: "./assets/icons/antigravity.svg",
    command: commands.antigravityCommand,
    args: [],
    // The skill folders the Antigravity ACP server reads.
    skillRoots: { user: [".agents/skills", ".gemini/config/skills"], project: [".agents/skills"] },
    signInHint: "Start an Antigravity thread on the machine; the ACP server opens a Google sign-in.",
    expiredHint: "Your Antigravity sign-in expired. Start a thread on the machine to sign in again.",
    installUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json",
  });
}
