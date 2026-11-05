// The plugin's `bb.host` entry: bb's ACP bridge (acp-next) runs both agents,
// and two dialects add the maintenance hooks the bridge calls for
// `provider/health` and `provider/usage`. The exported bridge wraps the ACP
// bridge so the Antigravity server unpacks into its own temp folder
// (src/antigravity-bridge.ts).

import { tmpdir } from "node:os";

import { experimental_resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_acpProviderBridge,
  experimental_registerAcpDialect,
} from "@get-bb/plugin-sdk/provider-bridge/acp-next";

import { ANTIGRAVITY_DIALECT_ID, DEVIN_DIALECT_ID } from "./agents.ts";
import { createAntigravityBridge } from "./antigravity-bridge.ts";
import { readAntigravityAccount, readAntigravityUsage } from "./collectors/antigravity.ts";
import { readDevinAccount, readDevinUsage } from "./collectors/devin.ts";

const ANTIGRAVITY_LOGIN_COMMAND = "agy";

// `installation` is not declared for either provider, so bb never runs these
// installers; the bridge's dialect type requires one.
experimental_registerAcpDialect({
  id: DEVIN_DIALECT_ID,
  maintenance: {
    loginCommand: "devin auth login",
    installer: () => ({ command: "devin", args: ["update"], displayCommand: "devin update" }),
    readAccount: readDevinAccount,
    readUsage: () => readDevinUsage(),
  },
});

experimental_registerAcpDialect({
  id: ANTIGRAVITY_DIALECT_ID,
  maintenance: {
    loginCommand: ANTIGRAVITY_LOGIN_COMMAND,
    installer: () => ({ command: "agy", args: ["update"], displayCommand: "agy update" }),
    readAccount: readAntigravityAccount,
    readUsage: readAntigravityUsage,
  },
});

export const experimental_providerBridge = createAntigravityBridge(experimental_acpProviderBridge, {
  health: {
    loginCommand: ANTIGRAVITY_LOGIN_COMMAND,
    resolveExecutable: experimental_resolveExecutablePath,
    readAccount: () => readAntigravityAccount(),
  },
  sharedTempDir: tmpdir,
  write: (line) => {
    process.stdout.write(line);
  },
  log: (message) => {
    process.stderr.write(`[agent-usage] ${message}\n`);
  },
});
