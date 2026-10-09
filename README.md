# Lotus Cycle

Standalone Moon/Star Lotus automation for all 13 TERA classes. No other mod or external skill data is required.

## Installation

Download the installation ZIP from [Releases](https://github.com/Volframid/lotus-cycle/releases/latest), then extract the `lotus-cycle` folder into Toolbox's `mods` directory and restart Toolbox. If using GitHub's source ZIP, rename the extracted folder to `lotus-cycle`. Install only one copy.

The shared package defaults to ON. Existing installations keep their saved setting. An active Lotus speed buff starts the cycle automatically. If no speed buff is active, use `lotus on` to start with the configured first Lotus.

## Automatic updates

Automatic updates are enabled. Toolbox checks this repository's `main` branch at startup and downloads changed code using the SHA-256 hashes in `manifest.json`. Restart Toolbox to load an update; updates are not applied during a fight. Updates follow the latest code on `main`; a new Release is not required.

Existing user configuration is kept: `config.json`. Missing default files are installed. Logs, character state and Toolbox's local settings are never downloaded or overwritten. New configuration defaults are available in the repository; existing settings are not reset.

If upgrading from an older ZIP without an update address, install the current package once, or replace `module.json` and restart Toolbox. Also enable this mod's updates in Toolbox if a local `module.config.json` previously disabled them. Toolbox's global mod updates must be enabled.

For maintainers: every push to `main` runs the GitHub workflow to regenerate and commit the manifest. Wait for the workflow to succeed before announcing an update. Run `node scripts/build-manifest.cjs` before preparing an installation ZIP.

## How it works

- Waits for the actual Moon/Star speed buff to end, then uses the other Lotus when available.
- Tracks the server's real buff duration, recharge and short skill cooldown. It does not overwrite an active speed buff.
- Retries unconfirmed attempts at a controlled rate until a real speed buff confirms success.
- Pauses while loading, dead, mounted or in a restricted contract. Map changes are checked before treating a buff removal as expiry.
- Optional dungeon-only mode pauses automatic use outside listed dungeons and resumes the existing cycle when you enter one. Buff durations and cooldowns continue to be tracked everywhere; manual Lotus use is unaffected.
- Saves cooldowns and the last successful Lotus per server/character in `state.json`.

Server restrictions still apply. Unknown cooldowns are shown as unknown, and a skill cooldown alone does not confirm a successful buff.

## Commands

Use these in Toolbox's command chat:

| Command | Action |
|---|---|
| `lotus` / `lotus status` | Show cycle, buff, cooldown and transition status |
| `lotus on` / `lotus off` | Save ON/OFF; ON also starts the cycle |
| `lotus dg` | Toggle and save dungeon-only mode |
| `lotus dg on/off` | Enable/disable dungeon-only mode |
| `lotus dg status` | Show dungeon-only preference and current zone |
| `lotus reload` | Reload all of `config.json` |
| `lotus animation on/off` | Hide/show automatic Lotus animation; ON means hidden |
| `lotus fast on/off` | Enable/disable the fast transition feature |
| `lotus cancel on/off` | Enable/disable cancellation after buff confirmation; requires fast ON |
| `lotus log` | Start/stop a diagnostic recording |


## Settings

Edit `config.json`, then use `lotus reload`.

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

These features do not guarantee instant server acceptance. To compare normal transitions, use `lotus fast off`. To keep skill retries but disable Lotus cancellation, use `lotus cancel off`.

## Diagnostics and sharing

Logging starts OFF. Use `lotus log` before and after a test. Recordings are saved as `logs/lotus-cycle-*.jsonl`.

Malformed `state.json` or `config.json` no longer prevents startup. The original file is preserved as an `*.invalid-*.bak` backup before recovery. Invalid state resets saved timers; real server buff/cooldown packets rebuild them. Invalid configuration restores the bundled defaults. Valid user settings are preserved. UTF-8 and UTF-16 JSON files are supported. If `lotus reload` finds invalid settings, the current running configuration stays active and the file is left untouched.

Share the source, `config.json`, `module.json`, `lib/` and this README. Exclude personal `state.json`, `logs/` and local Toolbox settings; `.gitignore` covers them.
