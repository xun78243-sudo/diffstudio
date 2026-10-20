# Changelog

All notable changes to DiffStudio are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- **Replacement rules (替换规则)** — text compare accepts `/regex/=>replacement`
  rules (no slashes = literal match). Rules rewrite the text **before**
  comparing, so differences in timestamps, version numbers and build IDs are
  ignored. Files are never modified and the panes still show the original text.
  Invalid rules are reported inline. New module `core/replacement.js`.
- **Unimportant rules (重要/不重要)** — text compare accepts regex rules
  (one per line or `;`-separated). Differences caused only by matching text
  are downgraded to `unimportant`: grey instead of yellow, excluded from
  difference navigation, and counted separately. Invalid regex is reported
  inline instead of breaking the view. New module `core/unimportant.js`.
- **File operations in Folder Compare** — rename, new folder, touch
  (timestamp), and move to the opposite side. Every action is validated
  before it touches disk (illegal characters, reserved names, duplicate
  names, trailing dot/space), and none of them overwrites an existing item.
- **Find in files** — text search across both compared folders with per-file
  grouped results.
- **Archive compare** — open a zip / tar / tgz / gz on either side and compare
  it as a folder tree. Implemented without third-party dependencies; entry
  paths are normalised so `..` / absolute entries cannot escape the temp
  directory (zip-slip).
- **3-Way Folder Merge** — new session type: base / left / right plane
  classification, auto-merge of one-sided changes, conflicts are never
  auto-resolved, apply to either side with per-operation undo and backups.
- New IPC: `fs:rename`, `fs:move`, `fs:touch`, `fs:read-raw`.

### Docs

- `docs/bc5-feature-gap.md` — verified feature gaps against Beyond Compare 5.

### Verification

- Unit: 287/287 (`npm test`, includes `test/p0-features.test.js` 77 checks,
  `test/unimportant.test.js` 21 checks and `test/replacement.test.js` 31 checks).
- E2E: 125/125 unchanged, plus 28 targeted checks (`npm run test:p0`),
  7 UI checks for unimportant rules (`node test/unimportant-ui.js`) and
  9 UI checks for replacement rules (`node test/replacement-ui.js`).

## 0.1.0 — 2026-10-20

First public release: a Beyond Compare-inspired desktop tool for comparing,
merging and synchronizing files and folders, built on Electron.

### Added

- **Text comparison** — Myers O(ND) diff with common prefix/suffix trimming,
  Beyond Compare row vocabulary (`same` / `left` / `right` / `change` /
  `conflict`), inline character-level highlighting, isolate-changes view and
  manual line alignment.
- **Three-way merge** — diff3-style hunk merge with auto-accepted identical
  changes and reported conflicts.
- **Folder comparison** — synchronized side-by-side tree, relative paths
  computed in the main process, and HTML diff-report export.
- **Folder patch** — one-sided copy of folder state with an undoable change
  list.
- **CSV and picture comparison** — header-aware CSV column matching and pixel
  comparison.
- **Multi-language UI** — one-checked-language menu invariant, all UI strings
  localised.
- **Installer** — NSIS x64 installer with custom icon, install-directory
  selection, desktop and start-menu shortcuts.

### Verification

- Unit tests: **158/158** passing (`npm test`).
- End-to-end checks: **125/125** passing (`npm run test:e2e`).

### Known limitations

- Windows x64 installer only; no macOS/Linux builds.
- Installer is not code-signed, so SmartScreen may prompt on first run.

### Checksums

```
SHA256  DiffStudio-Setup-0.1.0.exe  587F4CFC91F2A099F2F2E0A9450CCD8F49364B82DEB567D0A00912A058082E8F
```
