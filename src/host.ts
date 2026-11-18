// The plugin's `bb.host` entry:
// - `experimental_providerBridge`: bb's ACP bridge (`provider-bridge/acp`) runs
//   both agents; two dialects add `provider/health`, `provider/usage`, and
//   Antigravity's native tool presentation (`src/antigravity-dialect.ts`). The
//   wrapper only isolates `TEMP`/`TMP` and skips `--version` for the legacy
//   PyInstaller `agy_acp_server`, leaving built-in `agy acp` untouched.
// - default export (`experimental_defineHostEntry`): resolves installed
//   Antigravity plugin skill roots on each host so bb lists them in the composer.

import { homedir, tmpdir } from "node:os";

import {
  experimental_defineHostEntry,
  experimental_nativeRootsHostContract,
} from "@get-bb/plugin-sdk/host";
import { experimental_resolveExecutablePath } from "@get-bb/plugin-sdk/provider-bridge";
import {
  experimental_acpProviderBridge,
  experimental_registerAcpDialect,
} from "@get-bb/plugin-sdk/provider-bridge/acp";

import { ANTIGRAVITY_DIALECT_ID, DEVIN_DIALECT_ID } from "./agents.ts";
import { createAntigravityBridge } from "./antigravity-bridge.ts";
import { antigravityDialectHooks } from "./antigravity-dialect.ts";
import {
  readAntigravityAccount,
  readAntigravityUsage,
  setPreferredAgyCommand,
} from "./collectors/antigravity.ts";
import { readDevinAccount, readDevinUsage } from "./collectors/devin.ts";
import { resolvePluginNativeRoots } from "./native-roots.ts";

const ANTIGRAVITY_LOGIN_COMMAND = "agy acp --login";

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
  ...antigravityDialectHooks,
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
  onAgyCommand: setPreferredAgyCommand,
  write: (line) => {
    process.stdout.write(line);
  },
  log: (message) => {
    process.stderr.write(`[agent-usage] ${message}\n`);
  },
});

export default experimental_defineHostEntry({
  contract: experimental_nativeRootsHostContract,
  handlers: {
    resolveNativeRoots: ({ providerId, cwd }) =>
      resolvePluginNativeRoots({
        providerId,
        cwd,
        homeDir: homedir(),
        env: process.env,
        warn: (message) => process.stderr.write(`[agent-usage] ${message}\n`),
      }),
  },
});
