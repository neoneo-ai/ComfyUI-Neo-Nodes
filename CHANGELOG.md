# Changelog

Notable changes for Neo Studio. Versions are tagged `vX.Y.Z` and published to the ComfyUI Registry.

## [Unreleased]

- Docs: split the Studio desktop out of the developer quick tour into `docs/studio-desktop.md` /
  `docs/en/studio-desktop.md`; the desktop module names in `docs/api-routes.md` and `docs/en/api-routes.md` follow the
  `app/` rename, and the
  install example uses `<ComfyUI root>` / `<data root>` placeholders instead of fixed drive paths. The MCP config
  snippets use the same placeholders, and `docs/en/api-routes.md` gets the MCP section the Chinese page already had.
- Naming: the desktop app stopped calling itself a "shell", which reads like a terminal shell. `StudioShell` →
  `StudioDesktop`, `ShellServer` → `DesktopServer`, `SHELL_PORT_OFFSET` → `DESKTOP_PORT_OFFSET`,
  `SHELL_LOG` → `DESKTOP_LOG`, `caps.owner()` answers `desktop`, and the desktop trace log is
  `data/studio_desktop.log` (an existing `data/studio_shell.log` is left where it is). Docs say 桌面端 / desktop
  throughout. Windows-owned names stay untouched: `shell32`, `WScript.Shell`, `IShellItem`, "PowerShell".
- MCP server for external agents. `studio/mcp_server.py` is a standalone stdio MCP server
  (JSON-RPC, standard library only, no relative imports, no ComfyUI node imports): an MCP client
  (Claude Desktop / Cursor / custom) launches it as a subprocess and the agent calls Neo Studio's
  image and director capabilities through 20 tools — status, skills, models, prompt expansion,
  image generation, task polling/cancel, output fetch (`get_media`: png images and mp4 films as `/view`
  URLs), gallery, recipes, and the director loop (recipes, spec, plan, copy, save, run, segment run, assemble
  run). Generation is async: submit returns a `task_id`, `task_status` polls it; director, segment and assembly
  outputs are mp4 videos. Segment numbers are 1-based for callers and converted
  to the endpoints' 0-based indices internally. The ComfyUI URL is loopback-only, `stdout` carries
  protocol only (logs go to `stderr`), no delete endpoints are exposed, the only writes are
  `rs_recipes/save` and `rs_recipes/copy`, outputs are returned as `/view` URLs with base64 opt-in for images,
  and `NEO_MCP_TOOLS` narrows the tool list. `tools\mcp_setup.ps1` prints the client config snippets;
  `--selftest` verifies the install. Docs: `docs/mcp.md` / `docs/en/mcp.md`.
- Fixed the desktop shell failing to open its window on machines where .NET Framework hosting is broken
  (`Failed to resolve Python.Runtime.Loader.Initialize`). The shell now bootstraps clr before
  `webview.start()` and, when netfx hosting fails, overrides `pythonnet`'s runtime with coreclr — pywebview's
  own coreclr fallback never engages because the netfx runtime object already occupies `pythonnet._RUNTIME`.
  coreclr needs the desktop runtime for `System.Windows.Forms`, so the bundle ships
  `tools/coreclr.runtimeconfig.json` (`Microsoft.WindowsDesktop.App`, `LatestMajor`) into `_internal/runtime/`.
  `release-app.yml` now builds on Python 3.12, matching the locally verified build.
- `.github/workflows/release-app.yml`: pushing a `v*` tag (or a manual dispatch) runs
  `tools\build_studio_exe.ps1` on `windows-latest` and attaches both distribution forms to that tag's
  GitHub Release — the onefile exe and the onedir build zipped whole (`mode` defaults to `both`) — so
  the recommended form now has a prebuilt download. Assets are unsigned; signing and notarization stay
  local (`-Sign` / `-Notarize`), and the Registry publish stays in `publish.yaml`. The README
  Installation entry for the portable app now points at Releases.
- English documentation mirror. `docs/en/` is a one-to-one English copy of every module doc; each English page
  links back to its Chinese original and each Chinese doc links to its English counterpart, and English pages only
  link to English pages. The root `README.md` (English) points at `docs/en/*` while `README_ZH.md` keeps pointing
  at the Chinese docs; the developer entry points are `Developer.md` (中文) and `Developer_EN.md` (English).
  `studio/README.md` is now English with `README_ZH.md` beside it, so the Registry package ships the
  English readme.
- Root `README.md` and `README_ZH.md` slimmed (225 → 165 and 285 → 232 lines). The Features / 模块一览 rows now
  link to the module doc that owns the detail, Installation leads with the desktop app and keeps the
  plugin routes collapsed, Quick Start is six short steps, the standalone-app section
  keeps the entry-point table plus the shell-behavior bullets, and the doc index table is replaced by a link to
  the docs index. The detail that moved out is not lost: the rebuild-after-change rule, the source sync and the
  window & taskbar icon are in `docs/release.md` / `docs/en/release.md`, and the two canvas screenshots now live
  in `prompts.md` (reference grid) and `h3-video-gen.md` (video nodes).
- Installation now leads with the **Neo Studio desktop app** (portable exe built by
  `tools\build_studio_exe.ps1`, and the source form `neo-studio-app.vbs` / `.bat`) and states that the
  app installs the plugin into `custom_nodes` by itself. The ComfyUI plugin routes (Manager, comfy CLI,
  clone, `install_plugin.ps1`, old-package upgrade note) moved into a collapsed `<details>` block, and
  Quick Start step 1 opens the app.
- The `nine_grid_storyboard` preset's `skill.md` no longer links to `../../docs/gallery.md`: `docs/` is not
  shipped in the Registry package, so that relative link was unreachable in every installed copy. It now names
  the gallery doc as plain text.
- The desktop shell syncs the plugin into `custom_nodes` by itself. Running from source (`neo-studio-app.vbs`)
  copies `studio/` over `ComfyUI/custom_nodes/comfyui-neo-studio` on every launch and before every
  "▶ Start kernel": same-name files only, files whose size and mtime already match are skipped, a file the
  running ComfyUI holds open is skipped and picked up on the next launch, and nothing in the target is ever
  deleted — user configs, the data-root pointer and installed dependencies stay put. Git checkouts are left
  alone; the exe keeps its version-gated bundled update.
- Studio header is status-only. `#ns-comfy-status` shows "● Running" / "● Stopped" / "● Starting" and keeps the
  port, the PID and who launched ComfyUI in the tooltip. The actions moved to the top of the shell-only
  `启动设置` tab: one state line plus "▶ Start kernel" (`▶ 启动内核`) and "■ Stop kernel" (`■ 停止内核`), the one
  that cannot run right now disabled. One `comfy_state` poll feeds both, so the header and the panel can no
  longer disagree, and a start that is already running is not spawned twice.

- Renamed Neo Nodes to Neo Studio. The Registry package is `comfyui-neo-studio` with `DisplayName` "Neo Studio";
  the plugin installs as `custom_nodes/comfyui-neo-studio` and every frontend asset URL is
  `/extensions/comfyui-neo-studio/...` — ComfyUI serves extension files under the install folder name, so the
  package name, the install folder and the URL literals have to be one spelling. Node class names and all route
  paths (`/neo-studio`, `/neo_studio/*`, `/neo_nodes/*`, `/neo_gallery/*`, …) are unchanged; only the node
  category label moved from `Neo-Nodes` to `Neo Studio`, so existing workflows keep loading.
  Upgraders need to delete `custom_nodes/ComfyUI-Neo-Nodes` before installing the new package: the package
  name changed, so Manager installs it next to the old folder and the same nodes register twice. User data
  lives outside the plugin directory, so removing the old folder touches no data.

- Packaging and publishing: `tools/install_plugin.ps1` installs the kernel plugin from source into
  `custom_nodes/comfyui-neo-studio` — code and built-in presets only, writes the `configs/data_root.json`
  pointer, and never deletes anything already in the target. `tools/build_studio_exe.ps1` gained `-Sign`
  (signtool via `-CertThumbprint` or `-Pfx`/`-PfxPass`, verified with `signtool verify /pa`), `-Notarize`
  (macOS `notarytool` + `stapler` + `spctl`) and `-Publish` (`comfy node publish`); all three are off by
  default, so a plain build is unchanged. Plugin dependency installs now pass `--no-warn-script-location`.
  `.github/workflows/publish.yaml` now runs `comfy node publish` inside `studio/` itself: the shared
  `comfy-org/publish-node-action` only publishes the repository root, and the root `pyproject.toml` is the
  desktop shell's own manifest, not the Registry package.

- Neo Studio desktop shell: `neo-studio-app.vbs` opens the Studio page in a WebView2 window with no console
  window (`neo_studio_app.py`, optional `pywebview` extra); the shell runs under `pythonw`, its startup trace
  goes to `tmp/studio_shell.log` (which also keeps the pywebview logger off the missing `stderr` that aborts
  window creation); messages go to a system dialog, ComfyUI is spawned
  without a child console, window geometry is persisted in `configs/studio_window.json` (a position saved while the window was minimized
  is off-screen and is dropped, so the window is not restored invisible), Studio `localStorage`
  survives restarts, links navigate inside the shell window (`OPEN_EXTERNAL_LINKS_IN_BROWSER = False`, so the
  skill canvas handoff and the top-menu Studio link stay in-window), blob downloads are allowed, and a second launch
  exits instead of opening a second window. The window is created before any startup work: the dependency
  self-check, the shell-side read-only service and the ComfyUI spawn run on a background thread, and the window
  is pointed at the offline gallery (full Studio when ComfyUI already answers, first-setup page when the root
  and interpreter are unresolved) once they finish — the window appears immediately instead of after the
  cold-start wait, and a window closed exactly while the shell is spawning ComfyUI closes that process
  immediately instead of leaving an orphan kernel. The shell is a launcher: closing the window saves geometry only and leaves
  ComfyUI running. The shell `js_api` methods `comfy_state` / `comfy_stop` / `comfy_start` are polled every 5s
  and shared by the header status and the `启动设置` kernel controls: stopping goes through `terminate()`, then
  `port_owner()` + `kill_pid()` repeated until nobody listens — `kill_pid()` needs `PROCESS_TERMINATE` and an
  explicit `OpenProcess` restype, otherwise the 64-bit handle is truncated and nothing is killed. Starting the
  kernel from the offline page reloads nothing — the shell jumps the whole window back to the full Studio once
  the port answers. The header status stays hidden in a browser tab (no `pywebview.api`).
  The window and taskbar icon is the clapperboard `web/neo-studio.ico` (`tools/make_studio_icon.py`), passed to
  `webview.start(icon=...)` with an explicit `AppUserModelID` so the taskbar button is not merged into the generic
  Python icon that `pythonw` falls back to. `tools/build_studio_exe.ps1` packages the shell with an embedded
  icon, so Explorer and shortcuts show it too, in two distribution forms: `-Mode onefile` (default) emits the
  single-file `tools/neo-studio.exe`, `-Mode onedir` emits the folder build `tools/neo-studio/Neo-Studio.exe`
  that skips the startup unpacking (window ~0.7s sooner), `-Mode both` emits both. Under a frozen build
  `resolve_root()` walks up from the exe's own location, so the window geometry, browser profile and logs stay
  in the shell state dir next to the exe (`data/`, `%APPDATA%/Neo Studio` when that folder is not writable).
  The exe is a local build artifact (`pyinstaller` is a build-time dep, not in
  `requirements.txt`) and never ships in the Registry; `neo-studio-app.vbs` stays the plugin entry point.
- Portable launcher settings: a `启动设置` tab (Studio view `launcher`) served by the shell-side
  `/neo_studio/launcher` route — GET reads the snapshot, POST runs the shell's `apply_launcher` /
  `install_plugin` / `install_deps`, the two path rows' browse buttons call the `js_api` methods `pick_root` /
  `pick_python` — so it works in
  the desktop shell only, and the tab stays hidden in a browser tab. It edits the ComfyUI root, the python
  interpreter and the port, validates them server-side (a root without `main.py` is rejected instead of launching a
  kernel that cannot start) and persists them to `launcher_config.json` in the shell state dir, which falls back to
  `%APPDATA%/NeoStudio` when the plugin folder is not writable. `tools/build_studio_exe.ps1` now embeds a copy of
  the plugin (`git ls-files -z` minus dev-only dirs, so user configs and API keys never ship) under
  `_MEIPASS/bundled/comfyui-neo-studio`; `ensure_plugin()` installs it into `custom_nodes` when the plugin is
  missing, requirements included. The tab shows the self-check state
  (ok / bad root / missing python / missing dependencies / plugin install failed), with `安装依赖` when the
  target python lacks the plugin dependencies and `重试安装插件` when the bundled copy could not be installed.
- First-run setup page: when the ComfyUI root cannot be inferred (or has no `main.py`), or no `python.exe` is
  found next to the root, the window opens on a `guide_html` page built with `load_html` + `js_api` instead of
  exiting. The shell-side service cannot be assembled without a valid root (`build_app` imports `folder_paths`
  from it), so this page must not depend on HTTP: it prefills whatever was auto-detected, validates live through
  `check_setup`, takes values from the native `pick_root` / `pick_python` dialogs, and `start_setup` starts the
  shell service and reuses `apply_launcher` to save and launch. Auto-detection that succeeds goes straight to
  Studio as before, and the pre-window root picker is gone. `start_setup` runs the same self-check as a normal
  start, so a root whose `custom_nodes` has no plugin gets the bundled copy installed before the shell service is
  assembled — pointing the service at the missing folder used to fail assembly with `FileNotFoundError` and leave
  only "service won't start" on the page. Empty path input no longer resolves to the relative `.`, which counts as
  a valid root when the shell runs from inside the ComfyUI folder.
- Launcher tab in the full Studio page: the `启动设置` panel now reads and writes through the shell `js_api`
  (`launcher_state` / `apply_launcher` / `install_plugin` / `install_deps`) instead of only the shell-side
  `/neo_studio/launcher` route. That route is same-origin only on the shell service, so the tab used to vanish as
  soon as ComfyUI was ready and the window jumped to the ComfyUI port. It stays hidden in a browser tab (no
  bridge, no route). The bundled plugin copy now keeps `pyproject.toml`, so a plugin the exe installed reports
  its version instead of `Neo Studio unknown`.
- Bundled plugin update: `ensure_plugin()` now compares the bundled `pyproject.toml` version with the installed
  copy's and replaces it when the bundled release is newer. The new copy is assembled in the shell state dir first,
  the user data dirs (`configs/`, `data/`, `gallery/`, `locals/`, `prompts/`, `recipes/`, `skills/`, `tmp/`) are
  merged into it, and only then is the installed folder swapped out — a locked folder (ComfyUI running) fails the
  swap and keeps the old copy for the next launch. An installed copy without a version counts as oldest, so an
  install from an older exe gets the version file. Source (dev) runs and git checkouts are never overwritten.

- Shell-embedded read-only gallery service (`neo_studio_server.py`, ComfyUI port + 3): the gallery modules now
  carry their own `web.RouteTableDef` and `__init__.py` mounts them into `PromptServer.instance.routes`, so the
  same browsing handlers run with no ComfyUI runtime — the shell serves `/neo-studio`, the extension static files,
  the read-only gallery subset (`list` / `subdirs` / `thumbnail` / `image` / `video` / `audio` / `waveform` /
  `media_meta` / `css` / `get_settings` / `lora_dirs` / `dir_cover_images`), `userdata/neo_gallery_data.json`
  (atomic write) and a `/ws` stub, and answers every write or generation route with `409 {"offline": true}`.
  The window opens on that offline library at startup, jumps to the full Studio when ComfyUI is ready, and is
  pulled back when ComfyUI stops; Studio shows a "ComfyUI not running" banner, hides the VRAM panel, and the
  restart button on the offline banner leaves the jump to the shell instead of reloading the offline page. `Neo-Studio.spec` now
  `collect_all`s `aiohttp` and `PIL` so the packaged exe keeps browsing offline.

- Studio header title is a link back to the main canvas (`<a class="ns-logo" href="/">`), and the shell injects a
  floating "🎬 返回 Studio" pill on every non-Studio page load, so returning from the full-page main canvas reload
  works in the same window. `/neo-studio` is served with `Cache-Control: no-cache` so shell header edits reach the
  window. The shell `js_api` carries only `url` and the `load_url` bound method: holding the pywebview window object
  makes `create_proxy` recurse through `window.native.AccessibilityObject...` and blow the stack.
- Fixed the plugin package failing to import in ComfyUI: `__init__.py` read `gallery.gallery_lora`, but a submodule
  attribute lands on the parent package, so the import died on `AttributeError` and every `/neo_*` route and node
  disappeared silently — the shell then never detected a ready ComfyUI and kept respawning it.
- The shell spawns ComfyUI with `CREATE_NO_WINDOW` and now redirects its output to `tmp/comfy_run.log`: without the
  redirect a failed startup left no trace anywhere. When 8188 is held by a leftover process it picks a free port
  (`free_comfy_port`, skipping the shell's own service port) instead of spawning an instance that dies on the
  port conflict.
- Studio Settings gains a Log tab (`GET /neo_studio/log` reads the `app.logger` ring buffer), so the ComfyUI
  console is visible without a console window. The panel fills the main area, and auto-scrolls only while pinned
  to the bottom, so scrolling up to read survives the 2s poll.
- Skills support video and audio reference slots.
- Qwen Image 2.1 pose editing with ControlNet.
- Skill manager: `workflow.json` is edited directly in the canvas; preset writeback through overrides with auto-copy; workflow skills are excluded from prompt enhancement; skill detail UI reworked.
- Canvas import maps control refs and pins reference loaders.
- Skill manager search box stays open under IME input and closes via ✕.
- README rewritten: hero demo, zero-config section, feature highlights; gallery screenshots compressed.
- README default language is now English: `README.md` is the English doc, the Chinese text lives in `README_ZH.md`.
  The standalone-app section is condensed to the user-facing facts; shell internals stay in `Developer.md`.
- Plugin source directory renamed `kernel-plugin/` to `studio/`. The Registry package name, the installed
  `custom_nodes/comfyui-neo-studio` directory, node names and the data root are untouched; only repo paths,
  tooling and docs moved. `conftest.py` keeps a placeholder `studio` package so pytest collection no longer
  runs the plugin entry point.
- Repo root `__init__.py` entry for the git-clone install form: cloning the repo straight into
  `custom_nodes/comfyui-neo-studio` registers through `studio/` again. It only registers when loaded from
  `custom_nodes`, so tooling that imports the repo root as a package stays inert.
- Repository renamed `ComfyUI-Neo-Nodes` → `neo-studio`; the app history merged onto the plugin history so
  `v1.0.0`..`v1.2.0` are ancestors of `main`. All `github.com/neoneo-ai` links point at the new name.

## [1.2.0] - 2026-10-08

- **Native LLM provider**: safetensors text-generation models (e.g. Qwen3.5 BF16) run inside the ComfyUI process with no extra dependency; models auto-unload to free VRAM on switch and unload.
- **Model Hub**: Comfy-Org hub with dual-source (ModelScope / Hugging Face) search, ModelScope subfolder support, Civitai downloads, bookmark pagination.
- **Gallery**: LoRA safetensors metadata badges with refresh, image lightbox, stable outpaint ratio presets.
- **Skill manager**: embedded litegraph workflow editor, writeback preview with local history, canvas↔skill config sync, flowchart layout for imported skill workflows.
- **Image Gen & Edit**: `max_refs` config with auto-grow reference slots; Qwen Image 2.1 identity-swap preset.
- **Registry and metadata**: `.comfyignore`, Registry metadata, node manifest and version banner at plugin load, node search aliases, tooltips, metadata contract test.
- Cancellable LoRA directory tagging with tag formatting; top-menu behavior and node placement refined; workflow repair skips unhashable widget heads.

## [1.1.0] - 2026-10-04

- Qwen Image 2.1 outpaint mode; masked local edit with crop and feathering; SAM3 mask feathering.
- Skill workflow import/export with update endpoint; skill manager UI refresh.
- Batch LoRA tagging in the gallery (missing LoRA directories are skipped); Backyard gallery preprocessing with OSS upload.
- Outpaint pipeline aligned with the reference workflow (1MP / 1.5MP scaling); removal prompt prefill contract in the image edit dialog.
- English README added; vendored Krea2 edit node registration and quadview LoRA handling removed.

## [1.0.1] - 2026-10-02

- Manual publish flow documented; version bumped for the first Registry release.

## [1.0.0] - 2026-10-02

- Initial release: Neo Prompt Encoder, Neo Prompt Agent, Neo Image Gen & Edit, H3 Video Director with director recipes, Neo Gallery with bookmarks, Neo Reference Grid, Neo Grid Split, Neo Bundle Expand, workflow repair, skill presets, and Neo Studio.
