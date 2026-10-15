# Studio Desktop

The desktop puts the Studio page in a local window: it starts ComfyUI itself and serves a read-only asset service on
the ComfyUI port +3, so browsing assets and editing recipes and skills keep working while ComfyUI is not running.
Source runs and the packaged exe go through the same `app/studio_app.py`.

## Components

| File | Responsibility |
|------|----------------|
| `app/studio_app.py` | Window, self-check, start / stop ComfyUI, frameless window, close teardown, startup settings |
| `app/studio_server.py` | Desktop-side aiohttp service (ComfyUI port +3, `DESKTOP_PORT_OFFSET`); loads the plugin modules' own `RouteTableDef` handlers by directory |
| `app/studio_caps.py` | Capability table: which routes the desktop service owns; everything outside answers `409 offline` |
| `data/` | State directory: `studio_window.json` (geometry), `studio_profile` (WebView2 profile / localStorage), `launcher_config.json` (root / python / port / frameless / dev_mode), `studio_desktop.log`, `comfy_run.log` |

Source runs keep state in the repository's `data/`; the exe prefers `data/` beside the exe and falls back to
`%APPDATA%\Neo Studio` when the exe sits in a non-writable directory.

## Offline gating

The test is "file read/write / local lookup / remote download / the 8080 LLM service only"; anything needing the
execution queue, VRAM, or node definitions belongs to ComfyUI. The feature-flag table ships with
`/neo_studio/version`, and Studio gates only the run-type buttons (generate / run segment / assemble); recipe
editing, skill editing, settings and LLM configuration never need the ComfyUI runtime. Route list:
[api-routes.md](api-routes.md).

## Startup sequence

- The window comes first: opening the window only unpacks and creates it (splash / guide page); the self-check,
  the desktop-side service and starting ComfyUI all finish on a background thread.
- `starting` while the desktop is bringing ComfyUI up is one dict shared by `StudioDesktop` and the desktop-side service,
  emitted by both `comfy_state` and `/neo_studio/version`. pywebview injects `js_api` later than page load, and
  `window.pywebview` appears before its methods, which finish.js fills in afterwards: desktop-side api code always
  waits for the method it needs to show up before taking over, and the frontend knows it is starting from the version
  snapshot alone. During that window only "ComfyUI is starting…" is shown; the not-running banner and the start entry
  are hidden.
- When the desktop starts, "is there a ComfyUI" is decided only by whether anyone is listening on the port: a missing
  `/neo_studio/version` probe (that instance has not loaded the plugin yet and is still importing custom nodes) also
  only attaches — a second instance is never started on a neighbouring port, and the "Startup settings → Start
  kernel" button only attaches as well.

## Guide page (first-time setup)

When the root cannot be derived, or `python.exe` is found neither beside the plugin nor inside it, the window opens
on the guide page (`guide_html`, `load_html` + js_api): at that point `build_app` cannot even import `folder_paths`,
the desktop-side service cannot start at all, so the page has to work without an HTTP service. Validation and launch
all go through js_api (`check_setup` / `pick_root` / `pick_python` / `start_setup`), and the service only becomes
startable once the root is filled in.


## Frameless window and dragging

- Frameless is a startup setting, stored as `frameless` in `launcher_config.json` (on by default; unchecking it
  restores the system title bar): it is fed to pywebview at window creation and switched as style bits at runtime
  (only `WS_CAPTION` is removed, `WS_THICKFRAME` stays set — pywebview's frameless uses `FormBorderStyle=None`,
  which drops edge-drag resizing as well, restored by `ensure_resizable_frame` after the window is Shown; the native
  window is only created inside `start()`, so there is no hwnd at creation time).
- `easy_drag` must stay off — pywebview's simple drag is a global mousedown, and frameless means clicking any card
  drags the window along. Dragging starts by pressing an empty part of the header and calling `win_start_drag`,
  with the desktop looping on the window thread and following the cursor (`SetWindowPos` +
  `GetAsyncKeyState(VK_LBUTTON)`), stopping the moment the left button is released — handing it back to the system
  through `WM_NCLBUTTONDOWN + HTCAPTION` or `WM_SYSCOMMAND·SC_MOUSEMOVE` never starts, because the WinForms Form
  swallows the non-client-area press.
- Minimize / maximize / fullscreen / close go through `window_state` plus the `win_*` group of js_api methods, and
  whether the controls appear is decided by `frameless`. The maximized and fullscreen states are tracked by the
  desktop itself (pywebview's `Window.maximized` / `.fullscreen` are creation-time initial values): frameless maximize
  fills the work area (the system maximize returns a full-screen rectangle and would cover the task bar); exiting
  fullscreen makes pywebview write `FormBorderStyle` back to its creation value so the title bar comes back, with
  the style re-applied from the desktop's state; closing while fullscreen does not save geometry (it would store a
  full-screen rectangle and the window would fill the screen on the next start).

## Dev mode

- Dev mode is a startup setting, stored as `dev_mode` in `launcher_config.json` (off by default): checking it makes
  the next start go through `webview.start(debug=True)`, and the settings toggle is `set_dev_mode`.
- pywebview sets `AreBrowserAcceleratorKeysEnabled`, `AreDefaultContextMenusEnabled`, and `AreDevToolsEnabled` all
  equal to `debug` when the CoreWebView2 environment is created: without dev mode, F5 / Ctrl+F5 / Ctrl+R and the
  WebView2 context menu do not work in the window. All three are fixed at environment creation and cannot be changed
  on a running window, so the toggle takes effect after the window restarts.
- The reload entry does not depend on dev mode: the Studio page takes over F5 / Ctrl+F5 / Ctrl+R itself
  (`initReloadHotkey` in `studio/web/studio/studio-app.js`), so one keypress after a frontend hot-sync
  (`tools/watch_web.py`) loads the new code.

## Window close and process reaping

Only the ComfyUI the desktop started itself is taken away; ComfyUI started by the user has no handle and is never
touched.

- The first `closing` only saves geometry and lets the close through (returns `False`); the "stopping ComfyUI"
  notice and the teardown (killing the process, shutting the desktop-side service, `destroy`) all run on a
  background thread — `closing` runs synchronously on the UI thread, so every second the teardown sleeps is a
  second the window is frozen (`join` burns the full 5 seconds when the desktop-side service is busy), and
  `evaluate_js` additionally needs the UI thread back in its message loop before it executes, so calling it from
  the handler deadlocks.
- Geometry must be read before the window is destroyed (reading properties afterwards throws, the teardown chain
  breaks halfway and the process becomes an orphan); `closed` and a final pass before process exit each cover it
  once (the `destroy` path may never fire `closing`), and the teardown thread is joined before exiting — leaving
  before the join finishes means an orphan.
- Liveness is asked by PID through `OpenProcess`, not `Popen.poll()` (once the child handle has been reaped it
  falsely reports "already exited").
- After `terminate` the child must be reaped (`Popen.wait`) — without reaping, the process is left as a bare
  kernel object, so `pid_alive` always reports "still alive": closing the window sleeps the full wait ceiling
  (that is the multi-second stall), and both the PID-based fallback kill and the port sweep behind "Startup
  settings → Stop kernel" are guaranteed to fail (the "no permission to terminate this process" line). Only a
  reaping timeout triggers the fallback kill; the port sweep is not used.

## Single-instance lock

The named mutex `Local\Neo.Studio.SingleInstance`, holding no port: listening on 8189 looks like a second ComfyUI in
netstat and reads as "ports 8188 and 8189 are up, closing the window only killed one". The already-exists signal
comes from `kernel32.GetLastError()`; `ctypes.get_last_error()` does not return 183 for this call.

## Plugin sync

When running from source, every start syncs `studio/` into the `custom_nodes` copy (`sync_plugin`: only same-named
code is overwritten, files matching on size and mtime are skipped, a copy currently held by ComfyUI is skipped and
picked up on the next start, and nothing in the target directory is deleted). Both the desktop-side service and the
ComfyUI page take their frontend files from `custom_nodes`, so once the sync finishes the window opens straight into
the new UI. The exe only swaps the directory when its bundled copy's version is newer, and a git checkout is never
touched. **Changing `app/studio_app.py` requires repackaging** — see [release.md](release.md).

## Static assets and cache

Desktop-side `/extensions/` static responses carry `no-store` (matching ComfyUI's `/extensions`), and
`data/studio_profile/EBWebView/Default/Cache` is cleared before the window opens: a stale plugin JS in the cache is
served straight out of it (no request), and once it is linked into the same ES module graph as the new modules the
link error happens before `studio-app.js` executes and JS cannot catch it — the page is left with only the header:
no views mounted, no offline banner, and the header status slot stuck at `hidden`.

## Logs

- `data/studio_desktop.log`: startup / navigation / window close / drag steps (`drag N steps`, 0 = the left button was
  already released on press), plus uncaught frontend errors reported by the page (the `[web]` prefix, sent through
  the js_api `log()`), keeping only the tail 200KB.
- `data/comfy_run.log`: the full stdout / stderr of the ComfyUI the desktop launched (port conflicts and import
  errors land here; read by Studio "Settings → Logs").

## Related tests

`app/tests/test_studio_desktop.py`, `app/tests/test_studio_server.py` and `studio-app.e2e.mjs` —
see [testing.md](testing.md).
