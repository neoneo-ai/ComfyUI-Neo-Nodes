# Neo Studio Developer Docs

> 🇨🇳 中文: [Developer.md](Developer.md)

For developers: project structure, front-end and back-end module responsibilities, API routes, node registration,
data directories, testing and release. End-user documentation lives in [README.md](README.md); the detailed docs are
split by major module under `docs/en/` (index: [docs/en/README.md](docs/en/README.md)).

## Documentation map

| Doc | Content |
|-----|---------|
| [docs/en/architecture.md](docs/en/architecture.md) | Project structure, module responsibilities, node registration, data & configuration directories |
| [docs/en/api-routes.md](docs/en/api-routes.md) | Backend API route overview |
| [docs/en/testing.md](docs/en/testing.md) | pytest unit tests and JS regression tests (golden snapshots, run-tests.ps1) |
| [docs/en/release.md](docs/en/release.md) | Registry publishing and offline tooling (preset preprocessing / OSS deployment) |
| [docs/en/llm.md](docs/en/llm.md) | LLM modes, local GGUF installation, model directory conventions |

Feature module docs (user guide + implementation details):
[prompts](docs/en/prompts.md) · [skills](docs/en/skills.md) · [image-gen](docs/en/image-gen.md) ·
[h3-video-gen](docs/en/h3-video-gen.md) · [recipes](docs/en/recipes.md) · [gallery](docs/en/gallery.md) ·
[workflow-repair](docs/en/workflow-repair.md)

## Quick tour

- **Plugin entry** `__init__.py`: imports the backend modules to register API routes, merges node mappings following
  the `NEO_NODES` list and prints the version banner, and declares `WEB_DIRECTORY = "./web"`.
- **Node registration**: `NODE_CLASS_MAPPINGS` at the bottom of `prompts.py` (NeoPromptEncoder / NeoPromptAgent),
  plus NeoImageGenEdit from `image_gen_edit.py` (a V3 node + Autogrow reference images).
- **API routes**: the gallery family and `llm.py` (LLM configuration / title extraction) carry their own
  `web.RouteTableDef` and are mounted onto `PromptServer.instance.routes` by `__init__.py` (the remaining modules
  still register with direct decorators); the list is in [docs/en/api-routes.md](docs/en/api-routes.md).
  The desktop shell reuses the same handlers on the ComfyUI port +3 to run the offline Studio
  (`neo_studio_server.py`): the routes owned by the shell service are fixed by the single table in
  `neo_studio_caps.py` (file read/write / local lookup / remote download / the 8080 LLM service), and everything
  outside the table answers `409 offline`.
  The feature-flag table ships with `/neo_studio/version`, and Studio gates only the run-type buttons (generate /
  run segment / assemble); recipe editing, skill editing, settings and LLM configuration never need the ComfyUI
  runtime.
  `starting` while the shell is bringing ComfyUI up is one dict shared by `StudioShell` and the shell-side service,
  emitted by both `comfy_state` and `/neo_studio/version` (pywebview injects `js_api` later than page load, and
  `window.pywebview` appears before its methods, which finish.js fills in afterwards: shell-side api code always
  waits for the method it needs to show up before taking over, and the frontend knows it is starting from the
  version snapshot alone). During that window only "ComfyUI is starting…" is shown; the not-running banner and the
  start entry are hidden.
  Closing the window only takes away the ComfyUI the shell started itself: the first `closing` only saves geometry
  and lets the close through (returns False), while the "stopping ComfyUI" notice and the teardown (killing the
  process, shutting the shell-side service, `destroy`) all run on a background thread — `closing` runs
  synchronously on the UI thread, so every second the teardown sleeps is a second the window is frozen (`join`
  burns the full 5 seconds when the shell-side service is busy), and `evaluate_js` additionally needs the UI thread
  back in its message loop before it executes, so calling it from the handler deadlocks. Geometry must be read
  before the window is destroyed (reading properties afterwards throws, the teardown chain breaks halfway and the
  process becomes an orphan); `closed` and a final pass before process exit each cover it once (the `destroy` path
  may never fire `closing`), and the teardown thread is joined before exiting — leaving before the join finishes
  means an orphan.
  Liveness is asked by PID through `OpenProcess`, not `Popen.poll()` (once the child handle has been reaped it
  falsely reports "already exited"); after `terminate` the child must be reaped (`Popen.wait`) — without reaping,
  the process is left as a bare kernel object, so `pid_alive` always reports "still alive": closing the window
  sleeps the full wait ceiling (that is the multi-second stall), and both the PID-based fallback kill and the port
  sweep behind "Startup settings → Stop kernel" are guaranteed to fail (the "no permission to terminate this
  process" line). Only a reaping timeout triggers the fallback kill; the port sweep is not used. ComfyUI started by
  the user has no handle and is never touched.
  When the shell starts, "is there a ComfyUI" is decided only by whether anyone is listening on the port: a missing
  `/neo_studio/version` probe (that instance has not loaded the plugin yet and is still importing custom nodes)
  also only attaches — a second instance is never started on a neighbouring port, and the "Startup settings →
  Start kernel" button only attaches as well. The single-instance lock is the named mutex
  `Local\Neo.Studio.SingleInstance` (the already-exists signal comes from `kernel32.GetLastError()`;
  `ctypes.get_last_error()` does not return 183 for this call) and holds no port: listening on 8189 looks like a
  second ComfyUI in netstat and reads as "ports 8188 and 8189 are up, closing the window only killed one".
  When the root cannot be derived, or `python.exe` is found neither beside the plugin nor inside it, the window
  opens on the guide page (`guide_html`, `load_html` + js_api): at that point `build_app` cannot even import
  `folder_paths`, the shell-side service cannot start at all, so the page has to work without an HTTP service;
  validation and launch all go through js_api (`check_setup` / `pick_root` / `pick_python` / `start_setup`), and the
  service only becomes startable once the root is filled in.
  The frameless window is a startup setting, stored as `frameless` in `launcher_config.json` (on by default;
  unchecking it restores the system title bar): it is fed to pywebview at window creation and switched as style
  bits at runtime (only `WS_CAPTION` is removed, `WS_THICKFRAME` stays set — pywebview's frameless uses
  `FormBorderStyle=None`, which drops edge-drag resizing as well, restored by `ensure_resizable_frame` after the
  window is Shown; the native window is only created inside `start()`, so there is no hwnd at creation time).
  `easy_drag` must stay off — pywebview's simple drag is a global mousedown, and frameless means clicking any card
  drags the window along; dragging starts by pressing an empty part of the header and calling `win_start_drag`,
  with the shell looping on the window thread and following the cursor (`SetWindowPos` +
  `GetAsyncKeyState(VK_LBUTTON)`), stopping the moment the left button is released — handing it back to the system
  through `WM_NCLBUTTONDOWN + HTCAPTION` or `WM_SYSCOMMAND·SC_MOUSEMOVE` never starts, because the WinForms Form
  swallows the non-client-area press.
  Minimize / maximize / fullscreen / close go through `window_state` plus the `win_*` group of js_api methods, and
  whether the controls appear is decided by `frameless`; the maximized and fullscreen states are tracked by the
  shell itself (pywebview's `Window.maximized` / `.fullscreen` are creation-time initial values): frameless maximize
  fills the work area (the system maximize returns a full-screen rectangle and would cover the task bar), and
  exiting fullscreen makes pywebview write `FormBorderStyle` back to its creation value so the title bar comes back,
  with the style re-applied from the shell's state; closing while fullscreen does not save geometry (it would store
  a full-screen rectangle and the window would fill the screen on the next start).
  Shell-side `/extensions/` static responses carry `no-store` (matching ComfyUI's `/extensions`), and
  `tmp/studio_profile/EBWebView/Default/Cache` is cleared before the window opens: a stale plugin JS in the cache is
  served straight out of it (no request), and once it is linked into the same ES module graph as the new modules the
  link error happens before `studio-app.js` executes and JS cannot catch it — the page is left with only the header:
  no views mounted, no offline banner, and the header status slot stuck at `hidden`.
  When running from source, every start syncs `kernel-plugin/` into the `custom_nodes` copy (`sync_plugin`: only
  same-named code is overwritten, files matching on size and mtime are skipped, a copy currently held by ComfyUI is
  skipped and picked up on the next start, and nothing in the target directory is deleted); both the shell-side
  service and the ComfyUI page take their frontend files from `custom_nodes`, so once the sync finishes the window
  opens straight into the new UI. The exe only swaps the directory when its bundled copy's version is newer, and a
  git checkout is never touched.
  The shell log `tmp/studio_shell.log` records startup / navigation / window close / drag steps (`drag N steps`,
  0 = the left button was already released on press) plus uncaught frontend errors reported by the page (the
  `[web]` prefix, sent through the js_api `log()`), keeping only the tail 200KB; the full output of the ComfyUI the
  shell launched goes to `tmp/comfy_run.log` (read by Studio "Settings → Logs").

- **Frontend assets**: the modules under `web/` are loaded by the ComfyUI extension mechanism (only `.js` is
  accepted); the standalone Studio page lives in `web/studio/`, cross-node shared utilities in `web/js/core/`, and
  node help documents in `web/docs/<node key>.md` (the ComfyUI native convention path, loaded directly by the
  property panel's "Info" tab).

## Common commands

```bash
python -m pytest tests -v      # Python unit tests (no ComfyUI needed)
npm test                       # JS regression tests (golden snapshot comparison)
pwsh tests/run-tests.ps1       # JS test runner (forced exit on timeout; never run `node --test` bare)
```

Details: [docs/en/testing.md](docs/en/testing.md).

The `folder_paths` / `server` / `comfy.*` imports of the kernel plugin are provided at runtime by the ComfyUI root;
Pylance needs `.vscode/settings.json`'s `python.analysis.extraPaths` pointing at the sibling ComfyUI root to
recognize these imports.