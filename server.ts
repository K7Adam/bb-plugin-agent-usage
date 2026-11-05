import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { DEFAULT_ANTIGRAVITY_COMMAND } from "./src/agents.ts";
import { registerProviders } from "./src/providers.ts";
import { registerUsageSource } from "./src/usage-source.ts";

export default async function plugin(bb: BbPluginApi) {
  // Settings are read once per load: reload the plugin after changing one.
  const settings = bb.settings.define({
    devinCommand: {
      type: "string",
      label: "Devin CLI command",
      description: "The `devin` executable: a name on PATH or an absolute path. bb runs `<command> acp`.",
      default: "devin",
    },
    antigravityCommand: {
      type: "string",
      label: "Antigravity command",
      description:
        "The agy CLI (1.5.1 or newer), started as `<command> acp`: a name on PATH or an absolute path. Any other command, such as the older agy_acp_server from the ACP registry, is started without arguments.",
      default: DEFAULT_ANTIGRAVITY_COMMAND,
    },
    overlayEnabled: {
      type: "boolean",
      label: "Usage pill overlay",
      description:
        "Show a floating pill with the remaining plan quota of every provider that reports usage to bb.",
      default: true,
    },
    overlayRefreshMinutes: {
      type: "number",
      label: "Usage pill refresh interval (minutes)",
      description:
        "How often the pill polls provider usage. 0 disables background polling; the popup's refresh button always works.",
      default: 2,
    },
    overlayPosition: {
      type: "select",
      label: "Usage pill position",
      options: [
        "top-left",
        "top-center",
        "top-right",
        "bottom-left",
        "bottom-center",
        "bottom-right",
      ],
      experimental_optionLabels: {
        "top-left": "Top left",
        "top-center": "Top center",
        "top-right": "Top right",
        "bottom-left": "Bottom left",
        "bottom-center": "Bottom center",
        "bottom-right": "Bottom right",
      },
      default: "bottom-right",
    },
    overlayOrientation: {
      type: "select",
      label: "Usage pill orientation",
      options: ["horizontal", "vertical"],
      experimental_optionLabels: {
        horizontal: "Horizontal",
        vertical: "Vertical",
      },
      default: "horizontal",
    },
    overlaySize: {
      type: "select",
      label: "Usage pill size",
      options: ["compact", "comfortable", "large"],
      experimental_optionLabels: {
        compact: "Compact",
        comfortable: "Comfortable",
        large: "Large (shows provider names)",
      },
      default: "comfortable",
    },
    overlayColorMode: {
      type: "select",
      label: "Usage pill ring color",
      description:
        "adaptive: green→amber→red by remaining quota · monochrome: always neutral · severity: neutral until warn · accent: theme primary · custom: your own color. Warn/critical overrides apply except in monochrome.",
      options: ["adaptive", "monochrome", "severity", "accent", "custom"],
      experimental_optionLabels: {
        adaptive: "Adaptive (green → amber → red)",
        monochrome: "Monochrome (always neutral)",
        severity: "Severity only",
        accent: "Theme accent",
        custom: "Custom color",
      },
      default: "adaptive",
    },
    overlayCustomColor: {
      type: "string",
      label: "Custom ring color (hex)",
      description:
        "Used when ring color is 'Custom color', e.g. #8b5cf6, #34d399, #f472b6.",
      default: "#8b5cf6",
    },
    overlayIconTone: {
      type: "select",
      label: "Usage pill icon color",
      description:
        "auto: monochrome icons only when rings are monochrome · color: brand colors · mono: neutral · ring: icon takes the ring's status color.",
      options: ["auto", "color", "mono", "ring"],
      experimental_optionLabels: {
        auto: "Auto (follow ring)",
        color: "Brand colors",
        mono: "Monochrome",
        ring: "Match ring tone",
      },
      default: "auto",
    },
    overlayIconMode: {
      type: "select",
      label: "Usage pill chip content",
      description: "What sits inside each usage ring.",
      options: ["icon", "dot", "none"],
      experimental_optionLabels: {
        icon: "Provider icon",
        dot: "Colored dot",
        none: "Bare ring",
      },
      default: "icon",
    },
    overlayShowPercent: {
      type: "boolean",
      label: "Show percent next to rings",
      description: "Display the remaining quota as a number beside each ring.",
      default: false,
    },
    overlayHeadline: {
      type: "select",
      label: "Usage pill headline window",
      description: "Which limit window drives each chip.",
      options: ["weekly", "tightest", "first"],
      experimental_optionLabels: {
        weekly: "Weekly window (or first)",
        tightest: "Tightest window",
        first: "First window",
      },
      default: "weekly",
    },
    overlayWarnBelow: {
      type: "number",
      label: "Warn below (% remaining)",
      description: "Windows at or below this show amber.",
      default: 20,
    },
    overlayCritBelow: {
      type: "number",
      label: "Critical below (% remaining)",
      description: "Windows at or below this show red and can pulse.",
      default: 5,
    },
    overlayOpacity: {
      type: "select",
      label: "Usage pill opacity",
      options: ["100", "85", "70", "55"],
      experimental_optionLabels: {
        "100": "Solid (100%)",
        "85": "85%",
        "70": "70%",
        "55": "Ghost (55%)",
      },
      default: "100",
    },
    overlayPulseCritical: {
      type: "boolean",
      label: "Pulse critical chips",
      description: "Chips at or below the critical threshold pulse gently.",
      default: false,
    },
    overlayMobileCompact: {
      type: "boolean",
      label: "Compact on small screens",
      description:
        "Shrink the pill to its compact size on viewports ≤ 520px (phones, narrow windows).",
      default: true,
    },
    overlayDock: {
      type: "string",
      label: "Custom dock position",
      description:
        "Written automatically when you drag the pill — format edge:fraction (e.g. right:0.62). Clear to return to the preset position.",
      default: "",
    },
    overlayProviders: {
      type: "string",
      label: "Providers shown in the pill",
      description:
        "Comma-separated provider ids to show; empty shows every provider that reports usage.",
      default: "",
    },
  });
  const { devinCommand, antigravityCommand } = await settings.get();

  registerProviders(bb, {
    devinCommand: devinCommand.trim() || "devin",
    antigravityCommand: antigravityCommand.trim() || DEFAULT_ANTIGRAVITY_COMMAND,
  });
  registerUsageSource(bb);
}
