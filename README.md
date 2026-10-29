# Lotus Cycle

Automatic Moon/Star Lotus cycling with verified buff and cooldown tracking.

## Installation

Download the installation ZIP from [Releases](https://github.com/Volframid/lotus-cycle/releases/latest), then extract the `lotus-cycle` folder into Toolbox's `mods` directory and restart Toolbox. If using GitHub's source ZIP, rename the extracted folder to `lotus-cycle`. Install only one copy.

The shared package defaults to ON. Existing installations keep their saved setting. An active Lotus speed buff starts the cycle automatically. Dungeon-only mode also starts an enabled cycle after login or state recovery, even without an active blessing; no second `lotuscycle on` command is needed. In unrestricted mode, use `lotuscycle on` to start without an active buff.

## Automatic updates

Automatic updates are enabled. Toolbox checks this repository's `main` branch at startup and downloads changed code using the SHA-256 hashes in `manifest.json`. Restart Toolbox to load an update; updates are not applied during a fight. Updates follow the latest code on `main`; a new Release is not required.

Existing user configuration is kept: `config.json`. Missing default files are installed. Logs, character state and Toolbox's local settings are never downloaded or overwritten. New configuration defaults are available in the repository; existing settings are not reset.

If upgrading from an older ZIP without an update address, install the current package once, or replace `module.json` and restart Toolbox. Also enable this mod's updates in Toolbox if a local `module.config.json` previously disabled them. Toolbox's global mod updates must be enabled.

For maintainers: every push to `main` runs the GitHub workflow to regenerate and commit the manifest. Wait for the workflow to succeed before announcing an update. Run `node scripts/build-manifest.cjs` before preparing an installation ZIP.

## How it works

- Uses only Lotus skills confirmed by the current character's server skill list or premium slots. Before these lists arrive, automatic use stays paused. No owned Lotus means no attempts; one owned Lotus is reused after its buff and recharge expire; both owned keep the alternating cycle.
- Waits for the actual Moon/Star speed buff to end before using an eligible Lotus.
- Tracks the server's real buff duration, recharge and short skill cooldown. It does not overwrite an active speed buff.
- Retries unconfirmed attempts at a controlled rate until a real speed buff confirms success.
- A rejected combat input keeps a short, at most 150 ms reply-settling guard. This prevents a refusal for an earlier duplicate from injecting Lotus just before the same skill's real accepted start arrives. Player inputs continue normally, and newer input replaces the guard.
- Pauses while loading, dead, mounted or in a restricted contract. Map changes are checked before treating a buff removal as expiry.
- Optional dungeon-only mode pauses automatic use outside listed dungeons and starts/resumes the enabled cycle when you enter one. Buff durations and cooldowns continue to be tracked everywhere; manual Lotus use is unaffected. `lotuscycle off` remains OFF.
- Saves cooldowns and the last successful Lotus per server/character in `state.json`.

Server restrictions still apply. Unknown cooldowns are shown as unknown, and a skill cooldown alone does not confirm a successful buff.

## Commands

Use these in Toolbox's command chat (for example, `/8 lotuscycle status`).
`lotuscycle` is the module's primary command. The shorter `lotus` alias also works when available.

### Command conflicts

If another module already uses `lotus`, Lotus Cycle still loads and `/8 lotuscycle status` remains available. Automatic use stays paused to avoid running two Lotus engines together; the warning identifies the conflicting command. Keep only one Lotus automation module enabled. After disabling the conflicting module, use `/8 lotuscycle on` or `/8 lotuscycle reload`, or restart Toolbox normally. Renaming a folder inside `mods` does not disable it.

A second current Lotus Cycle instance stays inactive before installing its gameplay hooks. Lotus Cycle never removes or replaces another module's command. This protects command ownership; it does not prevent other software from changing files on disk.

Use `/8 lotuscycle owner` to read the existing Toolbox command ownership records. Conflicted status/ON/reload output includes the same module ID and folder name. These are registry candidates, since a stale instance or another module editing the shared registry can leave old bookkeeping behind. The diagnostic never loads, disables or unloads a module, executes the conflicting command, or prints full paths/settings. If no owner can be resolved, it says so instead of guessing.

| Command | Action |
|---|---|
| `lotuscycle` / `lotuscycle status` | Show ownership, cycle, buff, cooldown and transition status |
| `lotuscycle on` / `lotuscycle off` | Save ON/OFF; ON also starts the cycle |
| `lotuscycle dg` | Toggle and save dungeon-only mode |
| `lotuscycle dg on/off` | Enable/disable dungeon-only mode |
| `lotuscycle dg status` | Show dungeon-only preference and current zone |
| `lotuscycle reload` | Reload all of `config.json` |
| `lotuscycle owner` | Show existing Toolbox records claiming the `lotus` command |
| `lotuscycle animation on/off` | Hide/show automatic Lotus animation; ON means hidden |
| `lotuscycle fast on/off` | Enable/disable the fast transition feature |
| `lotuscycle cancel on/off` | Enable/disable cancellation after buff confirmation; requires fast ON |
| `lotuscycle log` | Start/stop a diagnostic recording |


## Settings

Edit `config.json`, then use `lotuscycle reload`.

| Setting | Purpose |
|---|---|
| `enabled` | Automatic cycling |
| `dungeonOnly` | Restrict automatic use to listed dungeons; default `false`, saved across restarts |
| `first` | First Lotus when starting without an active buff: `moon` or `star` |
| `hideAutoAnimation` | Hide automatic Lotus presentation; manual use stays visible |
| `retryDelayMs` | Retry pacing after unconfirmed requests |
| `acknowledgementMs` | Wait for confirmation before another attempt |
| `fastTransition.enabled` | Allow a bounded retry of the latest player skill after buff confirmation |
| `fastTransition.delayAfterBuffMs` | Fast transition delay, 0–400 ms |
| `fastTransition.cancelAfterBuff` | Cancel the matching automatic Lotus action after the real buff arrives |
| `fastTransition.cancelType` | Native cancellation type; default `0` |
| `fastTransition.blockCancel.enabled` | Use a block press/release for Lancer and Berserker |
| `fastTransition.blockCancel.delayAfterBuffMs` | Block delay after buff confirmation; default 100 ms, range 0–400 |
| `effects` | Lotus skill, speed buff and recharge IDs for your server |

Dungeon zones are bundled in `lib/dungeon-zones.json`, using the numeric guide IDs from the dungeon guide collection. Guardian missions are excluded. There is no runtime dependency on a guide mod. Unlisted zones are paused when dungeon-only mode is ON.

Default server IDs:

| Lotus | Skill | Speed buff | Recharge |
|---|---|---|---|
| Moon | 60401323 | 97950020 | 97950021 |
| Star | 61401324 | 99950020 | 99950021 |

## Fast transitions

Animation hiding changes the client presentation; it does not shorten the server action by itself. Cancellation and player-skill retries are experimental and require the real speed buff plus the matching automatic Lotus action.

Lancer and Berserker use one native block press/release pair. Other classes use native skill cancellation. Manual block or a newer player action prevents a stale automatic cancel. A stored skill can be retried at most once immediately and once on a matching action end; there is no attack retry loop.

These features do not guarantee instant server acceptance. To compare normal transitions, use `lotuscycle fast off`. To keep skill retries but disable Lotus cancellation, use `lotuscycle cancel off`.

## Diagnostics and sharing

Logging starts OFF. Use `lotuscycle log` before and after a test. Recordings are saved as `logs/lotus-cycle-*.jsonl`.

Malformed `state.json` or `config.json` does not prevent startup. The original file is preserved as an `*.invalid-*.bak` backup before recovery. State writes are flushed before replacement and keep a validated `state.json.last-good` recovery copy. Invalid state restores that copy when available; otherwise real server buffs/cooldowns rebuild the timers. When the last Lotus is unknown, the cycle prefers the Lotus with the earliest known readiness instead of waiting for an unavailable configured first Lotus. A recovery warning reports an actual damaged local file; it is not a module crash. Invalid configuration restores bundled defaults. Valid user settings are preserved. UTF-8 and UTF-16 JSON files are supported. Invalid `lotuscycle reload` input leaves the running settings and edited file untouched.

Share the source, `config.json`, `module.json`, `lib/` and this README. Exclude personal `state.json`, `state.json.last-good`, `logs/` and local Toolbox settings; `.gitignore` covers them.
