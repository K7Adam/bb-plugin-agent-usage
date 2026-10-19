# Devin & Antigravity for bb

A [bb](https://getbb.app) plugin that adds **Devin** and **Google Antigravity** as
providers over ACP and shows each plan's quota in bb's usage panel
(Settings → Usage limits, the sidebar usage card, and `bb settings usage`).

| Provider id | Agent | Usage windows |
| --- | --- | --- |
| `devin-cli` | Devin CLI (`devin acp`) | Daily and weekly quota, plan name |
| `antigravity-cli` | Antigravity ACP server (`agy_acp_server`) | 5-hour and weekly quota per model group (Gemini, Claude/GPT, Gemini 4 Argon) |

Both providers run on bb's own ACP bridge (`@get-bb/plugin-sdk/provider-bridge/acp-next`),
the same one bb uses for its built-in ACP agents: models, reasoning levels, session modes and
skills come from the agent itself.

## Requirements

On every bb machine that runs these agents:

- **Devin:** the [Devin CLI](https://docs.devin.ai/cli), signed in with `devin auth login`.
- **Antigravity:**
  - the Antigravity ACP server from the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
    (`antigravity-acp`, a zip with `agy_acp_server.exe` on Windows and `agy_acp_server.par` elsewhere). It signs in
    with Google on its first session.
  - the `agy` CLI (1.1.11 or newer), signed in. Usage is read with `agy -p /usage --output-format json`, which
    agy answers without a model turn.

## Install

```sh
bb plugin install https://github.com/K7Adam/bb-plugin-agent-usage.git
```

If a command is not on PATH, set it, then reload the plugin:

```sh
bb plugin config agent-usage set devinCommand "C:/Users/me/AppData/Local/devin/cli/bin/devin.exe"
bb plugin config agent-usage set antigravityCommand "C:/Users/me/AppData/Local/agy-acp-server/1.4.1/agy_acp_server.exe"
bb plugin reload agent-usage
```

Each provider is listed only on machines where its command is installed.

If you added Devin or Antigravity under the ACP plugin's **Custom agents** before, remove those entries
so each agent appears once.

## How usage is read

| | Source | Credential |
| --- | --- | --- |
| Devin | `POST {api_server_url}/exa.seat_management_pb.SeatManagementService/GetUserStatus`, the call the Devin CLI makes | `windsurf_api_key` from the CLI's `credentials.toml` (`%APPDATA%\devin` on Windows, `~/.local/share/devin` elsewhere); sent only to the https server named in that file |
| Antigravity | `agy -p /usage --output-format json` | agy's own sign-in; the plugin reads no Google token |

- Reads run on the machine that hosts the agent (the provider bridge), so several bb machines each report their own account.
- A good result is reused for 5 minutes. **Refresh** in the panel reads again, at most every 30 seconds.
- `agy /usage` takes 20–30 seconds. A slow read keeps running and is served from a small cache file in the system temp folder on the next refresh.
- If agy ever answers `/usage` with a model turn, the plugin stops asking until bb restarts, so no quota is spent.

Both sources are undocumented and may change without notice.

## Develop

```sh
npm install
npm test           # node --test with type stripping
npm run typecheck
bb plugin install . --yes
bb plugin dev .    # rebuild and reload on change
```

The usage source is adapted from [bb-plugin-grok-build-usage](https://github.com/MacHatter1/bb-plugin-grok-build-usage) (MIT).
The `agy /usage` approach follows [Orca](https://github.com/stablyai/orca). Logos are from the ACP registry.

## License

MIT
