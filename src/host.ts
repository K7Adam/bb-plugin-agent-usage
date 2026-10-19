// The plugin's `bb.host` entry: bb's ACP bridge (acp-next) runs both agents,
// and two dialects add the maintenance hooks the bridge calls for
// `provider/health` and `provider/usage`.

import { experimental_registerAcpDialect } from "@get-bb/plugin-sdk/provider-bridge/acp-next";

import { ANTIGRAVITY_DIALECT_ID, DEVIN_DIALECT_ID } from "./agents.ts";
import { readAntigravityAccount, readAntigravityUsage } from "./collectors/antigravity.ts";
import { readDevinAccount, readDevinUsage } from "./collectors/devin.ts";

export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp-next";

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
    loginCommand: "agy_acp_server",
    installer: () => ({ command: "agy", args: ["update"], displayCommand: "agy update" }),
    readAccount: readAntigravityAccount,
    readUsage: readAntigravityUsage,
  },
});
