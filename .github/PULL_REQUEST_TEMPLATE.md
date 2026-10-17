## What breaks without this change

<!-- The node that vanishes at load, the route the offline service answers 409 for, the orphan ComfyUI child after the window closes, the gallery that re-reads every file. -->

## Behavioral change

<!-- One clause. No implementation diary. -->

## Tests run

- [ ] `python -m pytest -q studio/tests`
- [ ] `npm test`
- [ ] `python -m pytest -q app/tests` (dev machine with a sibling `../ComfyUI`)
- [ ] New node: `python -m pytest -q studio/tests/test_node_metadata.py`
- [ ] New route: `app/studio_caps.py` entry + `app/tests/test_studio_server.py` case

## Docs

- [ ] `docs/<page>.md` and `docs/en/<page>.md` updated in the same change
- [ ] New node: `studio/web/docs/<node key>.md`
- [ ] `CHANGELOG.md` entry under `[Unreleased]`

## Package boundary

- [ ] No secret, no user data, no data root inside the plugin directory
- [ ] New files classified in `studio/.comfyignore`
- [ ] No version bump (the release is a tag, not a feature PR)