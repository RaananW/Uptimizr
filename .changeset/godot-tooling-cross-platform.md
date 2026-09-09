---
"@uptimizr/godot": patch
---

Let the Godot web-export tooling run off Linux. `pnpm godot:fetch` threw outright on any
other platform and looked for Godot's data directory at `~/.local/share/godot`, so the
connector's real-engine verification was Linux-only. It now resolves the `win64` /
`windows_arm64` release assets and uses each platform's real Godot data directory
(`%APPDATA%\Godot` on Windows, `~/Library/Application Support/Godot` on macOS), which is
also where the editor looks for the export templates it installs. macOS ships a `.app`
bundle rather than a bare binary, so `GODOT_BIN` remains the route there, now with an
error message that says so. The template range-fetch was already host-independent.
Tooling only — no change to the published connector code.
