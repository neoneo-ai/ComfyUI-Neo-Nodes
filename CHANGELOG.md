# Changelog

Notable changes for ComfyUI-Neo-Nodes. Versions are tagged `vX.Y.Z` and published to the ComfyUI Registry.

## [Unreleased]

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
  ComfyUI running. A top-bar `#ns-comfy` pill (shell `js_api` methods `comfy_state` / `comfy_stop` / `comfy_start`,
  polled every 5s) shows port, PID, who started ComfyUI and readiness: one click stops it (`terminate()`, then
  `port_owner()` + `kill_pid()` repeated until nobody listens — `kill_pid()` needs `PROCESS_TERMINATE` and an
  explicit `OpenProcess` restype, otherwise the 64-bit handle is truncated and nothing is killed), one click
  restarts it and the page reloads once the port answers again. The pill stays
  hidden in a browser tab (no `pywebview.api`) and goes grey when ComfyUI is down.
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
  `_MEIPASS/bundled/ComfyUI-Neo-Nodes`; `ensure_plugin()` installs it into `custom_nodes` when the plugin is
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
  its version instead of `Neo-Nodes unknown`.
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
  restart pill leaves the jump to the shell instead of reloading the offline page. `Neo-Studio.spec` now
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
