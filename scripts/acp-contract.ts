// Contract check against the locally installed agents: starts `agy acp` and
// `devin acp`, runs only initialize and session/new (no prompt, no model cost),
// and compares what they report with contract/acp-contract.json.
//
//   npm run contract            exit 1 and print the drift when something changed
//   npm run contract -- --update  write the current contract as the new snapshot
//
// Needs both CLIs installed and signed in on this machine, so it runs locally
// (for example as a weekly bb automation), not in CI.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import {
  contractOf,
  diffContracts,
  skillNameFromFrontmatter,
  type AgentCommand,
  type AgentProbe,
  type Contract,
  type ContractAgent,
} from "./acp-contract-lib.ts";

const SNAPSHOT = path.join(import.meta.dirname, "..", "contract", "acp-contract.json");
const SHELL = process.platform === "win32";
const REQUEST_TIMEOUT_MS = 90_000;
const COMMANDS_SETTLE_MS = 5_000;

const AGENTS: Record<ContractAgent, { command: string; args: string[] }> = {
  antigravity: { command: "agy", args: ["acp"] },
  devin: { command: "devin", args: ["acp"] },
};

type JsonObject = Record<string, unknown>;

async function probeAgent(command: string, args: string[], cwd: string): Promise<AgentProbe> {
  const child = spawn([command, ...args].join(" "), { cwd, shell: SHELL, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, (message: JsonObject) => void>();
  const commands: AgentCommand[] = [];
  let buffer = "";
  let nextId = 1;

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (line === "") continue;
      let message: JsonObject;
      try {
        message = JSON.parse(line) as JsonObject;
      } catch {
        continue;
      }
      const id = message.id;
      if (typeof id === "number" && pending.has(id) && ("result" in message || "error" in message)) {
        pending.get(id)?.(message);
        pending.delete(id);
      } else if (typeof message.method === "string" && id !== undefined) {
        // Never grant anything: this probe only reads.
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "contract probe" } })}\n`);
      } else {
        const update = (message.params as JsonObject | undefined)?.update as JsonObject | undefined;
        if (update?.sessionUpdate === "available_commands_update" && Array.isArray(update.availableCommands)) {
          commands.length = 0;
          for (const entry of update.availableCommands as JsonObject[]) {
            const meta = entry._meta as JsonObject | undefined;
            const category = meta?.["cognition.ai/category"];
            if (typeof entry.name === "string") {
              commands.push({ name: entry.name, ...(typeof category === "string" ? { category } : {}) });
            }
          }
        }
      }
    }
  });

  const request = (method: string, params: JsonObject): Promise<JsonObject> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${command} ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if ("error" in message) reject(new Error(`${command} ${method}: ${JSON.stringify(message.error)}`));
        else resolve((message.result ?? {}) as JsonObject);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });

  try {
    const initialize = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const sessionNew = await request("session/new", { cwd, mcpServers: [] });
    await new Promise((resolve) => setTimeout(resolve, COMMANDS_SETTLE_MS));
    const sessionId = sessionNew.sessionId;
    const sessionCapabilities = ((initialize.agentCapabilities as JsonObject | undefined)?.sessionCapabilities ??
      {}) as JsonObject;
    if (typeof sessionId === "string") {
      if ("close" in sessionCapabilities) await request("session/close", { sessionId }).catch(() => undefined);
      if ("delete" in sessionCapabilities) await request("session/delete", { sessionId }).catch(() => undefined);
    }
    const help = spawnSync([command, ...args, "--help"].join(" "), { shell: SHELL, encoding: "utf8", timeout: 30_000 });
    return { initialize, sessionNew, commands: [...commands], helpText: `${help.stdout ?? ""}\n${help.stderr ?? ""}` };
  } finally {
    child.stdin.end();
    killTree(child.pid);
  }
}

// With a shell the child is cmd.exe on Windows; the agent below it keeps
// running unless the whole tree is ended.
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
}

function versionOf(command: string): string {
  const result = spawnSync(`${command} --version`, { shell: SHELL, encoding: "utf8", timeout: 30_000 });
  return (result.stdout ?? "").trim().split(/\r?\n/)[0] ?? "";
}

/** Names of the user's own skills, which agy lists as slash commands without marking them. */
function userSkillNames(): Set<string> {
  const home = homedir();
  const roots = [
    ".agents/skills",
    ".claude/skills",
    ".gemini/skills",
    ".gemini/config/skills",
    ".gemini/antigravity-cli/skills",
    "AppData/Roaming/devin/skills",
  ].map((root) => path.join(home, root));
  const pluginRoot = path.join(home, ".gemini/config/plugins");
  if (existsSync(pluginRoot)) {
    for (const plugin of readdirSync(pluginRoot)) roots.push(path.join(pluginRoot, plugin, "skills"));
  }
  const names = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      names.add(entry.name);
      const skillFile = path.join(root, entry.name, "SKILL.md");
      if (existsSync(skillFile)) {
        const name = skillNameFromFrontmatter(readFileSync(skillFile, "utf8"));
        if (name !== undefined) names.add(name);
      }
    }
  }
  return names;
}

async function main(): Promise<number> {
  const update = process.argv.includes("--update");
  const skills = userSkillNames();
  // One fixed, empty folder: a shared agent daemon (devin's) may keep it as
  // its working directory, so it is reused instead of deleted.
  const workspace = path.join(tmpdir(), "acp-contract-workspace");
  mkdirSync(workspace, { recursive: true });
  const current: Partial<Contract> = {};
  const versions: Record<string, string> = {};
  for (const [agent, { command, args }] of Object.entries(AGENTS) as [ContractAgent, { command: string; args: string[] }][]) {
    versions[agent] = versionOf(command);
    current[agent] = contractOf(await probeAgent(command, args, workspace), skills);
  }

  if (update || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, `${JSON.stringify({ versions, contract: current }, null, 2)}\n`);
    console.log(`Wrote ${path.relative(process.cwd(), SNAPSHOT)} (${JSON.stringify(versions)})`);
    return 0;
  }

  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as { versions?: Record<string, string>; contract: Partial<Contract> };
  const drift = diffContracts(snapshot.contract, current);
  const versionLine = `snapshot ${JSON.stringify(snapshot.versions ?? {})}, installed ${JSON.stringify(versions)}`;
  if (drift.length === 0) {
    console.log(`ACP contract unchanged (${versionLine})`);
    return 0;
  }
  console.log(`ACP contract drift (${versionLine}):`);
  for (const line of drift) console.log(`  ${line}`);
  console.log("Review the change, adapt the plugin if needed, then run `npm run contract -- --update`.");
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
