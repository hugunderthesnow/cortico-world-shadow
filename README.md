# Shadow for the Coo desktop pet

A second, smaller body for the [Coopanion](https://github.com/Pal-AI-Lab/Coopanion) desktop pet: it
follows the pet around, copies its sit/sleep/dance, takes **pokes only**, and answers a single
`pet_shadow` tool call. Everything local; poking it by mouse costs no tokens.

中文：给 Coo 桌宠加一只跟着走的小影子——只吃鼠标戳、会跟着坐/睡/跳舞，Coo 可以用 `pet_shadow` 戳它一次并收到「影子做了：X」的回执。鼠标戳它不花 token。

## Two parts (important)

Coo's World extensions cannot reach inside the pet window, so this project is split in two:

| Part | What it is | Where |
|---|---|---|
| **Extension** (this npm package) | `pet_shadow` tool, environment prompt, settings page, local command interface on `127.0.0.1:8897` | installed from the Coo extension page |
| **Renderer patch** | the actual second body inside the pet window: a small module patched into the pet's `pet-app.js`, plus a one-line CSP allowance for `http://127.0.0.1:8897` | `tools/install.mjs` in this repository |

Installing only the npm package gives Coo the tool and the settings page, but **no visible shadow**.
Run the installer too.

## Install

1. **Extension**: Coo → Settings → Extensions → install `cortico-world-shadow`, then turn **Shadow** on
   (it is off by default).
2. **Renderer patch** (from a clone of this repository):

   ```powershell
   node tools/install.mjs --pet-dir "<Coo>\resources\app\node_modules\cortico-world-desktop-pet" `
                          --ext-dir "<Coo>\data\extensions"            # dry run first
   node tools/install.mjs --apply --pet-dir "…" --ext-dir "…"          # write
   ```

   Restart Coo. `--status` prints the current state, `--revert` restores the files from
   `*.bak-shadow`.

## What it does

| | |
|---|---|
| Figure | fixed figure pack (default `whale`), 0.45×, sits 130 px beside the pet |
| Movement | walks when the gap is small, runs when large, glides when the height differs; stays at any height |
| Copies | sit / sleep / dance / dizzy; startles when the pet is picked up or thrown; replays `pet_act` / `pet_say` motions |
| Mouse | **poke only** — no grab cursor, no dragging, no patting, no throw |
| Sound | 20% of the pet's volume |
| Tool | `pet_shadow` → plays one random motion, receipt names it (`影子做了：转圈`); 2.5 s timeout |
| Off switch | turning the extension off removes the shadow within 8 seconds |

## Settings

| Field | Range / default | Takes effect |
|---|---|---|
| Size (vs pet) | 0.2–1, default 0.45 | ~2 s (shadow rebuilt) |
| Follow gap | 40–400 px, default 130 | immediately |
| Speed factor | 0.3–2, default 0.6 | immediately |
| Volume (vs pet) | 0–1, default 0.2 | immediately |
| Figure pack | dropdown of installed packs | ~2 s (shadow rebuilt) |
| Reply timeout | 500–8000 ms, default 2500 | next `pet_shadow` |

## Limitations

- Windows only (the renderer patch targets Coo's Windows build).
- The shadow uses a fixed figure; it does not follow the pet when you change its look.
- Coo updates reinstall `node_modules`, which drops the renderer patch — rerun `--apply`.
- The patch is anchored to Coo's current `pet-app.js`; `--dry-run` reports anchors it cannot find
  instead of writing a half-patched file.

## Uninstall

```powershell
node tools/install.mjs --revert --pet-dir "…" --ext-dir "…"
```

Then remove the extension from Coo's extension page and restart.

## License

MIT © 2026 hugunderthesnow
