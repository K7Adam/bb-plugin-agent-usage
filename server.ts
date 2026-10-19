import type { BbPluginApi } from "@get-bb/plugin-sdk";

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
      label: "Antigravity ACP server command",
      description:
        "The Antigravity ACP server (agy_acp_server.exe on Windows, agy_acp_server.par elsewhere) from the ACP registry: a name on PATH or an absolute path.",
      default: "agy_acp_server",
    },
  });
  const { devinCommand, antigravityCommand } = await settings.get();

  registerProviders(bb, {
    devinCommand: devinCommand.trim() || "devin",
    antigravityCommand: antigravityCommand.trim() || "agy_acp_server",
  });
  registerUsageSource(bb);
}
