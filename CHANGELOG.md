# Changelog

All notable changes to DiffStudio are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
