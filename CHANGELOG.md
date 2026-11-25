# Changelog

Each release is tagged `vX.Y.Z` on its `chore: release X.Y.Z` commit.

## Unreleased

- Restore real quota rings in thread headers. The replacement header action could only show text and folded into the thread menu, while the setting still promised rings.
- Align usage setting labels and descriptions with both displays: the floating pill and the thread-header rings.
- Add `npm run contract`, a local check of what `agy acp` and `devin acp` report (capabilities, config options, modes, built-in commands, flags) against `contract/acp-contract.json`. It sends no prompt.
- Add Dependabot for npm and GitHub Actions.

## 0.3.1 - 2026-11-24

- Fix: files written by Antigravity opened with "HTTP 404: Path does not exist" on Windows, because agy reports them as `/C:/...`.
- Label swarm actions by what they do ("Added worker", "Stopped worker", "Named swarm") and show the swarm board tools (`read_board`, `post_message`, `swarm_wait`) as their own rows.

## 0.3.0 - 2026-11-24

- Plan and goal composer actions for both providers.
- Manual compaction for Antigravity. Devin stays off because it compacts after the `/compact` turn has ended.
- Reasoning levels match what each agent offers: Antigravity low to xhigh, Devin none to max.
- Devin settings `devinProcessModel` and `devinRefusalFallback`. Launch settings reach new threads without a plugin reload.
- `@get-bb/plugin-sdk` 0.6.189 (requires a bb that ships it).

## 0.2.1 - 2026-11-18

- Devin ACP dialect, Windows path and search polish for Antigravity, CI.

## 0.2.0 - 2026-11-18

- Antigravity ACP dialect, plugin skills and `@get-bb/plugin-sdk` 0.6.157.

Earlier releases: see the git history.
