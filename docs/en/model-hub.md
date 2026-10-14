# Model Hub

> 🇨🇳 中文: [../model-hub.md](../model-hub.md)

🅝 menu → **📥 Model Hub**: search and download models from the Comfy-Org area with two selectable
sources (ModelScope / Hugging Face); downloads land straight in ComfyUI's model folders.

## Flow

1. Pick a source → the Comfy-Org repository list is fetched (grouped by the curated registry, order
   inside a group = ModelScope relevance ranking; searchable, ⟳ refetches bypassing the cache).
2. Pick a repository → its model files are listed (non-model files filtered out), each row as
   `file name [landing category] size`, with `✓ present (subfolder)` on files that already exist on disk.
3. Pick a file → the landing category is filled in automatically; **the subfolder is a dropdown** built
   from the subfolders that already exist under that category folder (auto-probed by default: an
   existing directory named after the repository or prefixed with it, otherwise the root), plus
   "＋ New subfolder…" to type a fresh name. Clicking an existing file selects the subfolder that file
   actually lives in (files of the same model and category usually share a directory), which wins over
   the probed default. Preview: `→ models/<category>/<subfolder>/<file>` (the LLM category preview
   includes the mandatory `<repo name>/` segment; it is not stacked twice when the existing location
   already is that segment).
4. ⬇ Download → progress bar with percentage / downloaded / speed, cancellable; on completion you get
   a notice and the file list refreshes.

## Landing categories

- A `split_files/<category>/...` prefix inside the repository maps straight onto a ComfyUI model
  category (`transformer` / `unet` → `diffusion_models`, `clip` → `text_encoders`, and so on).
- Without that prefix, file-name keywords take over (`vae` / `lora` / `esrgan` / `clip` / `t5` / `qwen`
  …); nothing matched → `diffusion_models`.
- `.gguf` goes to the **LLM category**: `models/<LLM subfolder>/<repo name>/`, the same directory the
  built-in local inference (llama-cpp) uses.
- The landing root comes from the `folder_paths` registered directories (including the external ones
  from `extra_model_paths.yaml`): the directory whose name matches the category wins (with `unet` /
  `diffusion_models` in the same group it picks the right one), otherwise the first existing one.
  The `✓ present` marker scans **all** registered directories of that category and their subfolders.

## Resumable downloads

A download writes `<file>.part`, with `<file>.part.meta.json` next to it recording source / repository
/ path / total size / bytes downloaded:

- "Cancel" keeps the breakpoint and the status reads "cancelled (breakpoint kept)"; downloading the
  same file again resumes over an HTTP Range.
- When the `.part` does not match the source / repository / file of the current request, it errors out
  and tells you to delete the `.part` — a broken file is never silently stitched together.
- On completion the `.part` is renamed to the real file and the metadata is deleted.
- One task at a time: only a single download runs at once, a second request returns
  "a download is already in progress".

## Settings (⚙)

| Setting | Description |
|----|------|
| Default source | `modelscope` / `huggingface` |
| HF endpoint | Mirror root URL (only absolute http/https URLs are accepted; an invalid value falls back to the official endpoint) |
| HF Token | Required for gated repositories |
| ModelScope Token | Optional, only needed to download gated repository files (listing and search work anonymously) |
| LLM subfolder | Directory name under `models/` where GGUF files land (default `LLM`) |
| Total timeout / read timeout | Seconds, minimum 10 |

Settings are stored in `configs/model_hub.json`. Subfolder and file names are sanitized before landing
(directory parts stripped, illegal characters removed, `..` rejected), and the landing path must stay
inside the model folders.

**The ModelScope Token may stay empty**: both the organization listing and the cross-organization
search use the site's own `dolphin/models` endpoint (relevance ordering `SortBy=Default`, anonymous
access). When that endpoint is down, missing repositories are filled in from Hugging Face results plus
a per-repository existence probe against the registry (probe results cached for a day). A token is only
needed to serve gated repository files, so a wrong token does not affect listing or search.

## Curated registry

`configs/model_registry.json` keeps the groups and recommended combinations (repository names and notes
only, no metadata) and drives the grouping and the fill-in of the repository list. Repositories inside a
group follow the **relevance order** of the ModelScope organization page (the order returned by
`SortBy=Default`); repositories ModelScope does not list go at the end of their group.

## Link with skill repair

An entry in the skill repair dialog that is missing a model opens the Model Hub with the search query
and category prefilled (`openModelHub({ query, category })`).

---

Backend `model_hub.py` (routes: [api-routes.md](api-routes.md)); frontend `web/model-hub.js` + `web/model-hub.css`.
