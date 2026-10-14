# MCP Server (External Agent Access)

> 🇨🇳 中文: [../mcp.md](../mcp.md)

`kernel-plugin/mcp_server.py` is a standalone MCP server (stdio transport). An MCP client
(Claude Desktop / Cursor / your own client) launches it as a subprocess, so an external agent can call
Neo Studio's image and director capabilities.

It does not start with ComfyUI and takes no part in node registration: zero relative imports, standard
library only, and every capability is reached through the local ComfyUI HTTP interface. `stdout` carries
JSON-RPC only; logs always go to `stderr`.

## Launch

```powershell
python kernel-plugin\mcp_server.py --comfy-url http://127.0.0.1:8188
```

- The ComfyUI URL must be a loopback http address (`127.0.0.1` / `localhost` / `::1`); anything else
  makes the server refuse to start.
- Defaults to `http://127.0.0.1:8188`; pass `--comfy-url` when the desktop shell runs ComfyUI elsewhere.
- `--selftest` prints the enabled tool list and exits — use it to verify the install (no ComfyUI needed).
- `tools\mcp_setup.ps1` prints the Claude Desktop / Cursor configuration snippets.

| Flag | Environment | Meaning |
|------|-------------|---------|
| `--comfy-url` | `NEO_MCP_COMFY_URL` | ComfyUI URL (loopback only) |
| `--tools` | `NEO_MCP_TOOLS` | Comma-separated tool allowlist; empty enables everything |
| `--image-base64` | `NEO_MCP_IMAGE_BASE64=1` | `get_image` attaches base64 image bytes by default |
| `--timeout` | `NEO_MCP_TIMEOUT` | Timeout in seconds for regular requests (default 30) |

## Tools

| Tool | Purpose |
|------|---------|
| `neo_status` | Versions / queue / director recipe count — call it first to confirm the service is up |
| `list_skills` `list_models` | Skill ids, available models and suggested values |
| `generate_prompt` | Short idea → finished prompt (uses the LLM, requires a configured model) |
| `generate_image` | Submits an image job and returns a `task_id` immediately |
| `task_status` `list_tasks` `cancel_task` | Task snapshot / list / cancel (all four task tables share `task_id`) |
| `get_image` | Output image: returns the filename and a `/view` URL, base64 bytes only with `base64=true` |
| `list_gallery` `list_recipes` `load_recipe` | Asset library tree, recipe list, single recipe metadata |
| `director_recipes` `director_spec` | Director recipe list, `shared` + segment list |
| `director_plan` | Storyboard planning: `plan` idea/script → segments; `optimize` rewrites one segment in H3 format; `modify` rewrites one segment per instruction |
| `director_copy` `director_save` | Copy a recipe (unlocks read-only presets), write segments into a custom recipe |
| `director_run` `segment_run` `assemble_run` | Full film / single segment / assembly, all return a `task_id` immediately |

## Conventions

- **Async tasks**: `generate_image`, `director_run`, `segment_run`, `assemble_run` only return a
  `task_id`. Poll with `task_status` until `succeeded`, then fetch the output; a full film is a
  multi-segment long job, so never wait on it synchronously.
- **Segment numbers are 1-based everywhere** (segment 1 = the first segment on the timeline).
  `segment_run.segment` and the lists in `assemble_run.segments` / `director_run.only_segments` are
  1-based and converted to the endpoints' 0-based indices internally.
- **Only two write operations**: `rs_recipes/save` and `rs_recipes/copy`. No delete endpoints are
  exposed; file reads go through ComfyUI's `/view` only, the MCP layer never touches local paths.
  Built-in preset recipes are read-only — `director_copy` first, then `director_save`.
- **LLM dependency**: `generate_prompt` and `director_plan` need an LLM configured in Neo Studio
  settings. Without one they return a short error pointing at the settings instead of a fake success.

## Known limits

- Per-segment prompt rewriting (`director_plan` with `optimize` / `modify`) handles one segment per
  call; multiple segments need repeated calls.
- Task snapshots are pruned after a task finishes, so `task_status` then reports "task not found";
  collect output names before that point.
- Base64 images are capped at 4 per call and 1.5 MB per image — larger ones return the `/view` URL
  only; text responses are capped at 12000 characters, longer output is truncated.
- Front-end orchestration features (grid split, voice-over, subtitles) are not exposed as tools.
