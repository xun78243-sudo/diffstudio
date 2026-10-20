# DiffStudio

A Beyond Compare–inspired desktop application for comparing, merging, and
synchronizing files and folders. Built with Electron.

## Status

| Module | Status |
| --- | --- |
| 文本比较 Text Compare | Working — line diff, inline character highlight, difference navigation, find, bookmarks, inline editing, copy to the other side, ignore whitespace/case, encoding picker (auto / UTF-8 / UTF-8 BOM / UTF-16 LE/BE / GB18030 / Latin-1), saves keep the encoding the file was read with |
| 文件夹比较 Folder Compare | Working — recursive tree, content comparison (256 MB per file), filename mask + excluded folders, display filter, per-row copy, double-click opens text compare |
| 文件夹同步 Folder Sync | Working — folder-grouped items, batch select, per-item actions, copy + confirmed delete, re-analysis after a run |
| 三路合并 3-Way Merge | Working — diff3 alignment, conflict detection, take left/right/base |
| 十六进制比较 Hex Compare | Working — byte-level diff with hex + ASCII, previous/next difference, editing by `offset:byte` and saving, 16 MB per file with virtualised rendering |
| 表格比较 Table Compare | Working — CSV row/column diff with a shared column order and widths |
| 图片比较 Picture Compare | Working — pixel diff on a union canvas, tolerance, zoom, difference-region navigation, save difference image |
| 文本补丁 Text Patch | Working — generate a unified diff from two files, preview it, save it, apply it onto the original, undo the apply |
| 文件夹补丁 Folder Patch | Working — preview copying one side onto the other (missing items / content differences / empty directories), apply, undo, export the plan |

The folder patch planner only acts on "clean" row states (`same`, `diff`,
`left-orphan`, `right-orphan`). Rows with unknown or errored state are skipped:
a copy and a delete are the same decision seen from two sides, so guessing
would be destructive. Directory rows always become `mkdir` operations, which is
how an empty directory survives the round trip. Before a file is overwritten or
removed it is copied to `<name>.diffstudio-undo`, and "undo" writes those
backups back and deletes the files the patch created.

Every session also offers: swap sides, export report, and a saved session that is
restored on the next launch (see "Sessions & persistence" below).

### Encoding

Text compare detects encodings in this order: BOM (UTF-8 / UTF-16 LE / UTF-16 BE),
BOM-less UTF-16 BE (zero bytes on even offsets), strict UTF-8, GB18030 (covers GBK
and GB2312), then Latin-1 as the fallback that always decodes. The picker in the
toolbar forces one of these; changing it reloads both files. Saving writes back in
the encoding the file was read with, so editing a GBK file does not silently turn
it into UTF-8. A file containing NUL bytes (other than UTF-16 with a BOM) is
reported as binary instead of being shown as text.

### Hex editing

In hex compare, type `offset:byte` in the toolbar field (hex, e.g. `1A:FF`) and
press Enter to change a byte; prefix with `R:` to edit the right side. Editing
never changes the file length, and both files are written when you press save.
Files are read up to 16 MB; only the visible rows are rendered, so a large file
does not exhaust memory.

## 界面

浅色主题，参考 Beyond Compare 的视觉风格：白色背景、浅灰工具栏、蓝色强调色、
浅色底 + 深色文字的差异着色。界面文字全部为简体中文（`CSV` 为通用缩写保留）；
可在「语言」菜单切换到 English。

顶部提供「会话 / 视图 / 语言 / 帮助」菜单，可直接新建各类比较会话。
菜单项在文字前带 16 px 图标：会话菜单里的 8 种比较类型各有专属图标，
关闭标签页、返回首页、语言切换、关于也有图标；「最近打开」的条目沿用
对应类型的图标，当前语言仍以勾选标出（勾选叠在图标右上角）。

## 运行

```bash
npm install
npm start
```

Electron binaries are downloaded from the npm registry by default. If that is
slow, set a mirror before installing:

```bash
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
```

## Architecture

```
main.js                     Electron main process: window + filesystem IPC
preload.js                  contextBridge: exposes window.api to the renderer
src/renderer/
  index.html                App shell markup
  styles.css                Light theme + diff colour palette
  js/app.js                 Tabs, home view, session routing
  js/core/diff.js           Myers O(ND) diff, diff-line builder, diff3 merge
  js/core/csv.js            RFC 4180 CSV parser
  js/core/ui.js             DOM helpers, line splitting, glob masks, char diff
  js/core/icons.js          Inline SVG paths for the menu icons
  js/core/status.js         Status-bar helper (avoids import cycles)
  js/core/context.js        Dependency container passed to sessions
  js/core/patch.js          Unified Diff build/parse/apply, HTML + text reports
  js/core/align.js          Manual alignment (Align With) re-pairing
  js/core/imageDiff.js      Pixel comparison, difference regions, zoom maths
  js/views/*.js             One file per session type
```

### Dependency injection

Sessions receive an explicit `context` object rather than reaching for
globals. `app.js` exposes a small test hook so harnesses can create a
session with an injected bridge:

```js
window.__diffstudio.openTab('text', fakeApi, { left, right });
```

This matters because the object exposed by `contextBridge` is **immutable**:
its properties cannot be reassigned, so stubbing `window.api` directly has no
effect.

### Diff engine

`core/diff.js` implements the Myers O(ND) greedy algorithm — the same
"Myers O(ND) alignment" referenced inside Beyond Compare's own binary. Common
prefixes and suffixes are trimmed first, then the middle is diffed with a
full-trace Myers pass, which is correct and simple at the cost of O(D²) trace
memory. Beyond a fixed edit budget the engine falls back to positional pairing
so two unrelated large files cannot lock the UI.

Edit scripts are converted into Beyond Compare's vocabulary:

| Kind | Meaning |
| --- | --- |
| `same` | identical on both sides |
| `left` | left orphan (present only on the left) |
| `right` | right orphan (present only on the right) |
| `change` | a paired run of removals and additions |
| `conflict` | merge only: both sides changed the region differently |

Three-way merge uses a diff3-style hunk merge: both `base → side` diffs are
reduced to hunks located by base position, then the hunks are merged in order,
detecting identical changes (auto-accepted) and overlapping divergent changes
(reported as conflicts).

## Verification

`e2e.js` (run against a live app with `--remote-debugging-port=9222`) drives
the UI over the Chrome DevTools Protocol and asserts on rendered DOM for every
module. `test/menu-icons.js` (`npm run test:menu`) re-checks the menu icons and
the one-checked-language invariant and saves one screenshot per menu.
`test/diff.test.js` and `test/core-extra.test.js` unit-test the pure
layers (diff, merge, line splitting, CSV, i18n, glob masks, Unified Diff,
manual alignment, pixel comparison, folder patch planning, exclude matching,
double-click view selection) in plain Node.
Current result: **125/125 E2E checks and 158/158 unit checks passing**
(`npm test` and `npm run test:e2e`). The E2E suite was run three times in a row
against one app instance; it mutates its own fixtures, so the sync/patch cases
snapshot and restore the directory they touch. A separate 73-check audit
harness (three full passes, in Beyond Compare terms) also passed 73/73 three
times in a row, both with `electron .` and with the installed
`DiffStudio-Setup-0.1.0.exe`.

Found and fixed during verification:

1. **Import cycle** — views imported `setStatus` from `app.js`, which imports
   the views. Moved the helper to `core/status.js`.
2. **Wrong diff class names** — rows rendered as `left`/`right` instead of
   `kind-left`/`kind-right`, so orphans were unstyled. Fixed the prefix in
   `textCompare.js`.
3. **Broken relative paths** — folder keys were computed with
   `path.slice(rootPath.length)`, which produced empty keys (and truncated
   filenames) whenever the root path length differed. Moved the computation
   into the main process using `path.relative()` and added a regression
   assertion for exact filenames.
4. **Invisible filenames** — flex items default to `min-width: auto`, which
   collapsed the name column. Added `min-width: 0`.
5. **Test selectors tied to English labels** — localising button tooltips broke
   the E2E suite even though the app worked. Added stable `data-role`
   attributes (`open-left`, `open-base`, `pick-left`, …) so automation no
   longer depends on display text.
6. **Myers diff produced wrong right-hand indices** — in the suffix-walk the
   right index was computed from `i` instead of `endM + k`, so unchanged lines
   after a change were attributed to the wrong right-hand rows. The edit script
   trace is now rebuilt from the recorded trace instead of re-guessing paths.
7. **BOM-poisoned fixtures** — fixtures written with PowerShell's
   `Out-File -Encoding UTF8` carried a UTF-8 BOM. The BOM was treated as real
   content, so left and right "identical" files differed, CSV headers mis-matched
   columns, and some fixtures had been written to the wrong side. Generation now
   writes BOM-free UTF-8, verifies each file by reading it back, and asserts that
   the left/right fixtures really differ.
8. **Inline character diff was not minimal** — the old greedy matcher produced
   noisy highlights. Replaced with Myers over characters, with a 2000-char guard
   so minified files don't lock the UI.
9. **Table compare rendered the wrong side's cells** — `collapsed(body, side)`
   ignored `side` and projected both files through the left column map, so the
   right pane showed left-hand values.
10. **Merge: resolving a hunk did not repaint** — after "take right" the output
    pane and conflict count stayed stale because the handler forgot to re-render,
    and the auto-jump to the next conflict then resolved the wrong hunk. Fixed by
    re-rendering after every resolution.
11. **Merge: mixed line endings in the output** — each output line kept the EOL of
    whichever side it came from, producing files that mixed CRLF and LF. The
    output now follows the ancestor file's dominant style (`joinLines(lines, eol)`).
12. **Language switch left the menu bar in the old language** — `setLanguage`
    rebuilt menus and views but never refreshed the top-level menu labels.
13. **Line endings were compared as content** — a CRLF file and the same LF file
    were reported as different. `splitLines` now returns `{ body, eol }`, the
    comparison ignores EOLs (Beyond Compare's default) and differing styles are
    shown as a legend note instead.

Second audit round (feature gaps against Beyond Compare, found while adding the
missing interactions):

14. **`makeEquality()` vetoed custom comparators** — it AND-ed the caller's
    comparator with a hard-coded `bodyOf(x) === bodyOf(y)` check, so "ignore
    whitespace" and "ignore case" could never take effect: the toolbar looked
    enabled but the diff did not change. The comparison now goes through a single
    comparator; `makeEquality()` only ignores EOLs and records which styles it saw.
15. **"Next/previous difference" reported `当前第 0 处`** — the cursor starts at
    `-1` ("not positioned yet") and the label printed `cursor + 1`. It now shows
    the position the next jump will land on (1 of N).
16. **Arrow keys copied in the wrong direction** — `→` copied right-to-left and
    `←` left-to-right, opposite to both the arrow and the toolbar's copy buttons.
    Also, pressing an arrow with editing off did nothing at all; it now reports
    that editing must be enabled first.
17. **Keyboard shortcuts never fired in tests or synthetic events** — the handler
    was bound on `document`, which does not receive events dispatched on `window`.
    Moved to `window`. Selecting a row now also moves the navigation cursor, so
    "next difference" continues from the row the user clicked.
18. **Myers diff froze the renderer on fully different files** — two unrelated
    10k-line files took 4.3 s. A budget guard now falls back to positional pairing
    beyond ~4M edit steps (same case: 2 ms), still producing a script that
    reproduces the target text exactly.
19. **Sync delete was silently dropped** — choosing "delete" ran nothing and said
    nothing. Deletes are now supported, gated by a confirmation that is separate
    from the copy confirmation, re-check the file still exists, and are reported
    as `已删除 N 项`. Cancelling the dialog resets that row to its suggested
    action, so a later run does not replay the abandoned delete.
20. **Sync counted a failed operation as a success** — one counter covered both
    copies and deletes. Copies and deletions are now counted separately, so
    `同步完成：成功 N 项，失败 M 项` reflects what actually happened.
21. **Table compare showed each pane's own header order** — a right-hand file with
    columns `b,a` rendered its cells `x,1` in a `b,a` header while the left pane
    used `a,b`, so no field lined up. Both panes now share one column order and one
    set of column widths; missing columns render as placeholders.
22. **CSV trailing blank rows were treated as data** — spreadsheet exports end
    with empty rows, which produced phantom "right only" rows. Trailing blank rows
    are trimmed (a file that is only a blank line still yields one row), and CRLF
    inside quoted fields is normalised to LF.
23. **Folder tree rows were pushed to the right edge** — `.tree-row` is a flex
    container whose parent is a block box; without an explicit width it shrank to
    its content and the tree's `text-align` pushed names, sizes and statuses to
    the far right, leaving the left edge apparently blank.
24. **Sessions opened from elsewhere ignored their paths** — `openTab(kind,
    { initial })` was wired through `app.js`, but only text compare read it, so
    folder/hex/table/merge views opened empty when launched with paths. All
    sessions now prefill and compare/merge/analyse immediately.
25. **Hardened file access** — the renderer runs with `sandbox: true`, new windows
    are denied, every filesystem handler rejects non-absolute paths, text decoding
    falls back to latin1 when the bytes are not valid UTF-8, and `fs:exists` was
    added so sync can re-check a target before deleting it.

### Demo pictures

`npm run demo:pictures` regenerates `demo/pics/pic-left.png` and
`demo/pics/pic-right.png` (two 160×120 pictures with one block moved and
recoloured). Load them with **会话 → 图片比较** or
`npm start -- demo/pics/pic-left.png demo/pics/pic-right.png`.

## Feature round: comparison actions, sessions, picture compare

Built after an inventory of Beyond Compare's own action names (`Name =>
Description` strings recovered from `BCompare.chm`). Anything listed below
reproduces the behaviour of an action that exists in Beyond Compare and was
missing here.

### Text compare

| Action | Notes |
| --- | --- |
| Swap Sides | Exchanges both paths, contents, alignment anchors and bookmarks |
| Clear Bookmarks | Separate from "toggle bookmark" |
| Find / Replace, Replace All | `Ctrl+R` / `Ctrl+Shift+R`; literal, case-insensitive; refused unless editing is on, because replacing silently changes the buffers |
| Align With | Uses the selected row as a manual anchor, then re-pairs both sides with the normal algorithm |
| Isolate | Shows only the selected difference block with 3 lines of context; clicking again restores |
| Word wrap, Tab width | Display-only (`.pane.wrap`, `tab-size`), never rewrites the compared text |
| Export patch | Unified Diff (`--- / +++ / @@`) that `git apply` and `patch` accept |
| Export report | HTML with escaped cell text and status colouring |

### Folder compare

| Action | Notes |
| --- | --- |
| Swap Sides | Swaps roots and re-walks both trees |
| Undo | Undoes the last single-file copy: deletes the file if it did not exist before; if it overwrote a file, the status table is restored and the user is told the old content is gone (no backup was taken) |
| Export report | HTML of the currently visible (filtered) differences |

### Picture compare (new session)

Decoding happens in the main process via Electron's `nativeImage` (PNG / JPEG /
BMP), so no image library is added. The renderer receives RGBA pixels, compares
them on a union canvas (when sizes differ, the extra area only counts as a
difference where it is not fully transparent), and renders into a `<canvas>` —
pixels are never turned into DOM nodes.

- Tolerance slider (0–255) for colour noise.
- Difference / Left / Right render modes; fit, 1:1, zoom in/out.
- "Next/previous difference" cycles connected difference regions.
- "Save difference image" writes a PNG with differing pixels highlighted.

### Sessions & persistence

- Settings live in `userData/settings.json` (atomic write via a temp file).
- The session menu keeps up to 12 recently opened files/folders.
- On launch the last session is restored (tabs, paths, active tab).
- Start order: command line → restored session → home.

### Command line

```bash
diffstudio a.txt b.txt            # text compare
diffstudio dir1 dir2              # folder compare (any argument is a folder)
diffstudio merge base mine theirs # three-way merge
diffstudio file.png other.png     # picture compare
```

Arguments are resolved by the main process; paths that do not exist are
skipped rather than opening a session that immediately errors.

### Verification notes

`test/core-extra.test.js` covers the new pure layers, including patch
round-trips, rejection of mismatched context, hunk splitting for distant vs
nearby edits, manual alignment, and pixel comparison edge cases (size changes,
transparent padding, tolerance). The patch tests also pin the Unified Diff
format that external tools accept: one file name on both header lines, every
body line newline-terminated, `\ No newline at end of file` for an unterminated
last line, and hunk counts that match the emitted lines. A side harness ran the
same editor through both `git apply` and GNU `patch`.

Session persistence was verified end to end with a throwaway harness that
launches the app against a private `userData` directory over DevTools:

| Check | Result |
| --- | --- |
| Command line opens a text compare and reports it in the status bar | pass |
| Session snapshot written to `settings.json` with both paths | pass |
| Paths supplied by the command line appear in the recent list, like any other opened pair | pass |
| Restart restores the previous comparison | pass |
| Closing every tab and restarting lands on the home screen | pass |
| Two directory arguments open a folder compare | pass |
| User-opened files do appear in the recent list, newest first, without duplicates | pass |
| The recent list survives a restart | pass |

Found and fixed in this round (patch sessions, folder patch, home layout):

26. **Unified Diff was not a valid patch** — each body line was written
    without its terminator, then joined with an extra newline, producing two
    newlines after every line and an empty line before each hunk body. `git
    apply` rejected the file ("corrupt patch"). The emitter now writes one
    terminated line per row, derives the hunk header from what it actually
    emitted, and adds the `\ No newline at end of file` marker.
27. **Patch headers named two different files** — `--- a/x` / `+++ b/x` reads as
    a rename to `git apply`, which then fails to find the target. Both header
    lines now carry the same file name (`fileName` option).
28. **The built-in patch applier compared objects with strings** — parsed
    hunks held `{ body, eol }` objects while the original lines could be
    either the same shape or plain strings, so every context line "mismatched"
    and each hunk was reported as rejected. Comparison is now by line body,
    and `applyUnifiedPatch` returns plain strings like its callers expect.
29. **Opening a session added its paths to "recent"** — `openTab` recorded
    whatever `initial` it was given, so command-line launches, restores and
    every focused tab refilled the list with the same files. Only a real open
    from inside a view (via `context.notePaths`) records now.
30. **Home cards left an orphan row** — eight cards in four columns wrapped as
    4+3+1. The grid is five columns (5+3, the sixth card starting in column 2)
    with a `minmax(124px, 150px)` track so narrower windows shrink the cards
    instead of overflowing.


31. **The E2E suite corrupted its own fixtures** — fixtures were generated
    from scratch, but the sync case really copies right-only files into the
    left folder and deletes one, so a second run in the same process saw no
    "right only" file at all and the orphan classification check failed. The
    case now snapshots the left folder and restores it (content and mtime).
    An earlier `remove('left/only-right.txt')` line in `fixtures.js` had the
    same effect every run; it is gone.
32. **The restore check compared a file that only exists on one side** — the
    session-restore case reloaded `lf.txt`, which is right-only, so the left
    pane showed a read error and zero rows. It now restores a pair that exists
    on both sides.
33. **The BOM-less UTF-16 BE check had its byte positions swapped** — it looked
    for zero bytes at odd offsets, but big-endian stores the high byte first, so
    zero bytes sit at *even* offsets. The heuristic returned false for every
    real file and UTF-16 BE fell through to UTF-8 as a string of NULs. The check
    now runs before the UTF-8 test and requires the pairs to decode as printable
    characters.
34. **Forcing an encoding could show a binary as garbage text** — the NUL-byte
    check only ran while the picker said `auto`, so choosing "UTF-8" for a
    `.bin` file printed its NULs as text. The check is now unconditional apart
    from UTF-16 with a BOM.
35. **The hex view went blank when the window was hidden** — the first paint
    waited for `requestAnimationFrame`, which Chromium may not fire for an
    occluded window. The first screen is now drawn synchronously and the frame
    callback only handles scrolling.
36. **The hex view had no working save** — the E2E fake API had no
    `writeBinary`, so `applyEdit`/`save` threw and the panel silently did
    nothing. `delete` and `copy` were also missing from `preload.js`, which broke
    undo and made the sync delete test report "succeeded 0, failed 4". All three
    are wired now.
37. **Overwrites could not be undone at all** — undo only restored the row's
    status, and the bytes that had been overwritten were gone. Undo could also
    throw because `preload.js` never exposed `copy` or `delete`: every call
    failed with "api.copy is not a function". Both helpers are now bridged, and
    undoing a copy over an existing entry writes the overwritten file back from
    a `.diffstudio-undo` backup taken before the copy.
38. **Anchor rows from manual alignment rendered as `[object Object]`** — the
    row emitted by `realignWithAnchors` stored `{text, eol}` in `aLine`/`bLine`,
    but everything downstream (rendering, inline edit, save) reads the
    `{body, eol}` shape used by `buildDiffLines`, so the anchor line showed
    `[object Object]` and editing it threw. The anchor now emits a row identical
    in shape to an automatic one, with a unit test pinning the shape.
39. **Excludes were ignored inside subfolders** — the folder compare only
    excluded names at the top level, so `node_modules` under a subfolder was
    still walked. Added `isExcluded()` (segment-wise, case-insensitive, accepts
    a name or a relative path such as `src/generated`) and a unit test; the
    folder filter also gained the missing "identical only" option.
40. **Double-click always opened the text compare** — a binary file or a CSV
    dropped into the text view instead of the hex or table view. New
    `core/viewer.js` picks text / table / image / hex from the extension, wired
    into the folder view and covered by an E2E assertion for all three kinds.
41. **Isolate never actually isolated** — the window filter kept a row when
    *either* side's line number fell inside the range, so every same-text row
    leaked back in and the view stayed at full length. The filter now requires
    both sides to be inside their own range (one-sided rows use their own side).
    A 60-line file now folds to the 7-line block and restores on toggle. The
    toggle also left the button pressed after "exit" and used filtered indices
    against the full diff, which made the second click a no-op. Selection,
    navigation cursor and bookmarks now all live in full-file coordinates with a
    render→full index map.
42. **Ignore whitespace only trimmed** — inner space runs (`a  b` vs `a b`) and
    tabs still counted as differences. Both sides are now normalised by
    collapsing every whitespace run.
43. **Ignore options were recomputed but never applied** — the handlers called
    `renderComparison()`, which reused stale `diffLines`; a new `recomputeDiff()`
    re-reads the files. Covered by unit and E2E cases.
44. **Ctrl+F and Ctrl+G did nothing** — Ctrl+F now focuses and selects the find
    box, Ctrl+G jumps to the next difference; Ctrl+Shift+R is checked before
    Ctrl+R so "replace all" is not swallowed by "replace".
45. **Find drew no highlights** — hits are wrapped in `mark.find-hit` (the first
    one also gets `.current`), cleared on a miss, and the pane regains focus.
    "Find next / previous" now continue from an existing hit instead of doing
    nothing when the box is empty.
46. **Folder filter could empty the whole tree** — the visible set only tracked
    ancestor directories, never the matching files themselves, so every filter
    except "all" rendered 0 rows. Rewritten to register each hit plus all of its
    ancestors.
47. **Keyboard shortcuts stacked per tab** — the text view listened on `window`,
    so five open/close cycles made `Alt+↓` jump five blocks at once. The
    listener now sits on the view's own `container`.
48. **Sessions opened with paths never reached the recent list** — command-line,
    recent-list and restored sessions called nothing that records the paths;
    only a manual picker click did. Views now report paths once loading
    finishes, and `rememberPath` still de-duplicates.
49. **Lower-case shortcut keys were ignored** — `e.key` was compared as
    `Ctrl+S` without folding the case, so Shift/CapsLock broke the shortcut.
    Keys inside inputs, textareas, selects and buttons are ignored unless a
    modifier is held.
50. **Isolate with nothing selected did nothing** — it now selects the first
    difference block (and says so) instead of showing a prompt; with no
    differences at all it reports that instead of opening an empty view.

## Packaging

`npm run dist` builds `dist/DiffStudio-Setup-<version>.exe` (NSIS, x64, per-user
install with a choosable directory, desktop and Start-menu shortcuts). The icon
is generated by `build/make-icon.js` (pure Node PNG/ICO encoder, no image
dependency) into `build/icon.ico`; the same file is embedded in the executable
and the installer. Verified by a silent install (`/S`), launching the installed
exe with two file arguments over the DevTools port (the full 73-check audit
passed 73/73 against it), and a silent uninstall that leaves no files behind.

The first packaging run needs network access for two of electron-builder's own
tools (the `winCodeSign` bundle and the `nsis-resources` archive); Electron,
NSIS and 7-Zip come from the local cache after that. On a machine without
GitHub access, point `ELECTRON_BUILDER_BINARIES_MIRROR` at a mirror, or place
the archives in `%LOCALAPPDATA%\electron-builder\Cache\downloads`.

## Not implemented (by design)

Media, Version, Registry and Folder Merge sessions, the BC-style interactive
text-patch editor (patches can be generated and applied, but not edited as a
comparison), plus FTP/SFTP and cloud providers, scripting and source-control
integrations.
