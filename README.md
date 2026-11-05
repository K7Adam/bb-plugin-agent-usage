# Devin & Antigravity for bb

A [bb](https://getbb.app) plugin that adds **Devin** and **Google Antigravity** as
providers over ACP and shows each plan's quota in bb's usage panel
(Settings → Usage limits, the sidebar usage card, and `bb settings usage`).

| Provider id | Agent | Usage windows |
| --- | --- | --- |
| `devin-cli` | Devin CLI (`devin acp`) | Daily and weekly quota, plan name |
| `antigravity-cli` | Antigravity CLI (`agy acp`) | 5-hour and weekly quota per model group (Gemini, Claude/GPT, Gemini 4 Argon) |

Both providers run on bb's own ACP bridge (`@get-bb/plugin-sdk/provider-bridge/acp-next`),
the same one bb uses for its built-in ACP agents: models, reasoning levels, session modes and
skills come from the agent itself.

## Requirements

On every bb machine that runs these agents:

- **Devin:** the [Devin CLI](https://docs.devin.ai/cli), signed in with `devin auth login`.
- **Antigravity:**
  - the `agy` CLI, signed in. From agy 1.5.1 it serves ACP itself (`agy acp`), which the plugin starts by
    default. It answers ACP's `initialize` in well under a second. Usage is read with
    `agy -p /usage --output-format json`, which agy answers without a model turn (1.1.11 or newer).
  - Older setups can keep the separate Antigravity ACP server from the
    [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) (`antigravity-acp`,
    `agy_acp_server.exe` on Windows, `agy_acp_server.par` elsewhere) by setting `antigravityCommand` to it.
    It is a PyInstaller build that unpacks about 300 MB on every start: `initialize` took 16 seconds on an idle
    machine and, under load, more than the bridge's 60-second limit.

## Install

```sh
bb plugin install https://github.com/K7Adam/bb-plugin-agent-usage.git
```

If a command is not on PATH, set it, then reload the plugin. A command named `agy` (or `agy.exe`) is started
as `<command> acp`, any other Antigravity command without arguments:

```sh
bb plugin config agent-usage set devinCommand "C:/Users/me/AppData/Local/devin/cli/bin/devin.exe"
bb plugin config agent-usage set antigravityCommand "C:/Users/me/AppData/Local/agy/bin/agy.exe"
bb plugin reload agent-usage
```

Each provider is listed only on machines where its command is installed.

If you added Devin or Antigravity under the ACP plugin's **Custom agents** before, remove those entries
so each agent appears once.

## Where usage is shown

Desktop and mobile are set separately (Settings → Devin & Antigravity):

| Setting | Options | Default |
| --- | --- | --- |
| `overlayPlacementDesktop` | `floating`, `header`, `off` | `floating` |
| `overlayPlacementMobile` | `header`, `floating`, `off` | `header` |

- **floating**: the draggable pill. Its position is stored on each device, separately for desktop and
  mobile (browser storage), so dragging it on one device no longer moves it on another.
  `overlayPosition` and `overlayDock` are only the starting point for a device that has not been
  arranged yet. Dragging the pill onto the dismiss target turns it off for that form factor only.
- **header**: small rings in each thread's header row. On a phone the three providers closest to their
  limit, the rest as "+n", and a tap opens the details as a bottom sheet. On a desktop every ring, with a
  popover under the button.
- Viewports up to 520px wide count as mobile.

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

## Antigravity temp folder

This section applies only to the separate `agy_acp_server`, not to `agy acp`.

The Antigravity ACP server is a PyInstaller one-file build. Every start unpacks about 300 MB into a new
`_MEI…` folder under the temp folder, and only a server that exits on its own removes it again. bb stops
the server after listing its models, and its health check runs `agy_acp_server --version`, which the
server does not support, for at most 5 seconds. Each of those starts used to leave a folder behind in the
system temp folder.

The plugin therefore:

- starts the Antigravity server with `TEMP`, `TMP` and `TMPDIR` set to `agy-temp` under the plugin's
  bridge data folder on each machine (`~/.bb/plugins/agent-usage/bridge-data/agy-temp` on the server's
  machine, under `~/.bb-machines/<server>/plugins/…` on an enrolled one),
- removes leftover `_MEI…` folders there when the bridge starts, before a launch (at most every 5 minutes)
  and every 30 minutes. A folder is removed only when it is older than 15 minutes and can be renamed,
  which Windows refuses while a server unpacks into it or runs from it,
- once at bridge start, removes older leftovers from the system temp folder that contain the Antigravity
  server's own files (`google3/cloud/developer_experience/antigravity_extensions`),
- answers bb's health check for Antigravity itself, without starting the server. The version comes from
  the install folder of the ACP registry archive (`…/agy-acp-server/1.4.1/…`), otherwise it is empty.

Devin is not affected.

On Windows, an antivirus that checks every new file can make the unpack take far longer than bb's
30-second model list; on one machine it took about 100 seconds instead of about 20. A Microsoft Defender
exclusion for `agy-temp` that applies only while the server itself reads or writes there fixes that, and
other programs touching the folder are still scanned. In an elevated PowerShell:

```powershell
Add-MpPreference -ExclusionPath "$env:USERPROFILE\.bb\plugins\agent-usage\bridge-data\agy-temp\:{Process:""$env:LOCALAPPDATA\agy-acp-server\*\agy_acp_server.exe""}"
```

PowerShell expands both paths before Defender sees them. Write them out yourself if you set the exclusion
elsewhere, because Defender reads variables such as `%LOCALAPPDATA%` as the SYSTEM account's.

## Troubleshooting

- **"External hook '…' failed to execute"** in an Antigravity thread: the ACP server splits hook
  commands from `~/.gemini/config/hooks.json` like a POSIX shell, so backslashes in a Windows path
  disappear. Write hook paths with forward slashes (`C:/Users/me/hook.cmd`).

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
