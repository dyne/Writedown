# Writedown

Writedown is a browser editor for local LaTeX and Markdown projects. Import a
folder, choose its root document, and edit with a live PDF preview. The browser stores
your project and runs TeX in a worker. Source files, logs, and generated PDFs
stay on your device.

## Run locally

Use Node **24.22.3** (see [`.node-version`](.node-version)), npm **11.19.1**,
and `tar`. From the repository root, install the locked dependencies, prepare
the compiler, and build the app.

```sh
npm ci
npm run assets:prepare
npm run build
node --input-type=module -e 'import { startStaticServer } from "./tests/support/static-server.ts"; console.log((await startStaticServer("dist")).url)'
```

Open the loopback URL the server prints. Choose **Compile example** to try
pdfLaTeX and download its PDF, SyncTeX sidecar, and pass logs. Use
`npm run dev` to work on the app itself.

## Edit and preview

Import files or a folder, then choose the **Root document**, engine, and
bibliography mode. The editor compiles after 300 ms without edits. The preview
keeps the last readable PDF while a revision compiles or fails and shows its
revision alongside the current diagnostics. Use **Retry** after a failed compile.

Use **Show in PDF** to locate a source line. Double-click a PDF position, or
use **Open source**, to jump back to its source. These actions need a readable
SyncTeX sidecar from the current revision.

Select TeX math, with or without inline or display delimiters, to see it in
**Formula preview**. KaTeX renders the selection independently of the document.
For project macros, add a root-level `formula-macros.tex` with one
`\newcommand` definition per line. Definitions can take required arguments.

Choose **MathJax SVG** in **Formula renderer** for SVG output. It supports
basic TeX, AMS math, and project macros. Selecting it loads the pinned
MathJax components and TeX font data from `mathjax/4.1.3/`. Render a formula
online once to use SVG after an offline reload. KaTeX is the default.

### Markdown input

Create or import a `.md` or `.markdown` file and choose it as the **Root document**.
The **Input format** control switches the open source file between Markdown and
LaTeX without changing its contents. The choice is saved with the project.
Writedown converts Markdown to a LaTeX article in the browser and uses the
selected TeX engine for the same live PDF preview.

Use `<math>…</math>` within a paragraph for inline math or on its own for a
display equation. Use `<latex>…</latex>` for LaTeX commands and environments
that belong in the body of a document.

```markdown
# Field notes

The estimate is <math>\frac{1}{2}</math>.

<math>
\sum_{k=1}^n k = \frac{n(n+1)}{2}
</math>

<latex>
\textbf{Measurements taken at noon.}
</latex>
```

## Host the production build

Mount the complete contents of `dist/` at `/writedown/`. Use HTTPS on
public hosts so the service worker can register. Keep `index.html` and
`service-worker.js` at the mount root. Serve bundles and PDF.js files from
`assets/`, and the BusyTeX worker, WASM, and preload from
`compiler/busytex-1.4.1-basic/`. The build includes redistribution notices
under `notices/`. Return HTTP 404 for missing assets.

| Files | Content type |
| --- | --- |
| `.html` | `text/html` |
| `.js`, `.mjs`, including workers | `text/javascript` |
| `.css` | `text/css` |
| `.wasm` | `application/wasm` |
| `.data` and optional dependency payloads | `application/octet-stream` |
| `.woff2`, `.ttf`, `.otf` | `font/woff2`, `font/ttf`, `font/otf` |

If your deployment uses the [optional TeX dependency endpoint](#optional-tex-dependency-endpoint),
configure it before building.

## Offline access

Open the production app over HTTPS or loopback while online. **Offline access
is ready** means the service worker controls the page and has verified and
cached the app shell and compiler files. Compile once with each optional TeX
package you need. If you use MathJax SVG, render a selection once. You can then
reopen the same URL offline.

Each update verifies a separate cache before it replaces the active worker.
Close the open Writedown tabs when the app says the update is ready. An
interrupted installation leaves the previous build usable. If setup fails,
restore service or free browser storage, then choose **Retry offline setup**.

The BusyTeX wrapper may clear its own `EM_PRELOAD_CACHE` database when its
preload version changes. It can rebuild that database offline from the app's
verified runtime cache. Optional TeX dependencies have a separate cache for
each compiler release. If a verified dependency compiles online but fails to
save, **Retry cache** starts a fresh worker for the same project revision.

Projects live in IndexedDB, independently of the caches. If a project is
pinned to an unavailable compiler release, the editor identifies it and
offers to switch to the installed release. Switching saves a new revision with
the same source files.

## Compiler and assets

The [release manifest](compiler-release.json) pins `texlyre-busytex@1.4.1`
and the matching `assets-v1.4.1` archive by URL, GitHub release and asset IDs,
sizes, and SHA-256 digests. Asset preparation uses a 521,748,902-byte archive.
The build ships 128,304,494 bytes of compiler assets plus the app bundles.

The worker starts with the bundled `texlive-basic` preload. Browser fixtures
exercise pdfLaTeX, XeLaTeX with `xdvipdfmx`, and LuaLaTeX with the
`luahblatex` applet. The basic release omits Biber. BusyTeX's direct package
networking and shell escape are disabled. The base inventory lists 7,185
files, four format dumps, 343 declared package names, and 3,557 font files.
See which combinations passed and how to reproduce them in the
[compatibility matrix](docs/compatibility.md). The
[compiler notices](notices/compiler/) contain the inventories, version inputs,
and distribution notices. Additional package notices remain in the upstream
data payload.

Relative inputs resolve from the selected root document. For example, when the
root is `paper/main.tex`, `\input{chapters/intro.tex}` reads
`paper/chapters/intro.tex` and `\input{../shared.tex}` reads `shared.tex`
at the project root. Use a lowercase `.tex` suffix with no earlier `.tex`
in the basename. The driver's output lookup uses the first literal `.tex`
in that name.

Each compile gets a fresh writable project filesystem. Its passes share that
job's auxiliary files. The driver runs TeX, BibTeX if selected, and MakeIndex
if TeX generates index entries. It can run up to three more TeX passes, followed
by `xdvipdfmx` for XeLaTeX. A driver sequence is limited to four TeX passes
and seven tool calls. The driver retains the full log from its last TeX pass
and output and auxiliary data from earlier passes.

One service serializes worker startup, preloads, and compilation. Editing
invalidates any result in flight and replaces the pending snapshot. Ordinary
edits reuse the initialized worker. A change of project, engine, or release
retires it. Startup has a 180-second deadline, and the complete compile has a
separate 120-second deadline. After a timeout or worker failure, a later edit
or manual retry can start another worker from the current snapshot.

When needed, `npm run assets:prepare` downloads the archive into `.cache/compiler/` and
extracts the pinned files into private staging under `.cache/compiler-staging/`.
It verifies each file before publishing to `public/compiler/busytex-1.4.1-basic/`.
It checks file digests on reuse and repairs an incomplete or corrupted release.
To use a local copy of the exact archive, set
`WRITEDOWN_ASSET_ARCHIVE=/absolute/file.tar.gz`.

`WRITEDOWN_ASSET_CACHE` and `WRITEDOWN_ASSET_ROOT` override the cache and
preparation destinations. A custom output root uses private staging inside that
root so publication stays on the same filesystem. Production builds verify the
default `public/compiler/` location and emit only the compiler files listed in
the release manifest. Leftover stages, backups, and unlisted files stay out of
`dist/`.

## Optional TeX dependency endpoint

The compiler checks project files, the bundled TeX tree, and dependencies
already loaded in the worker. If TeX reports a missing required style or
class, the app checks the catalog and its verified cache. The
[dependency catalog](compiler-dependencies.json) currently approves
`booktabs.sty`. Unlisted misses stay on the device and appear in diagnostics.

With `VITE_TEX_DEPENDENCY_ENDPOINT` unset or empty, the app uses the bundled
release and any verified dependencies already in browser storage. To enable
downloads, set that build-time variable to the endpoint's directory URL before
running `npm run build`. Use an absolute HTTPS URL without credentials,
a query, or a fragment. HTTP loopback URLs work for local testing.

After preparing the compiler, generate the endpoint files in a staging
directory. This command honors `WRITEDOWN_ASSET_ARCHIVE` and
`WRITEDOWN_ASSET_CACHE`.

```sh
node scripts/prepare-dependencies.ts /absolute/path/to/dependency-staging
```

Serve `<release-id>/<sha256>/<filename>` as immutable binary files below the
configured directory. For a separate origin, allow the app's origin with CORS.
The browser sends a credential-free GET to the catalog URL and verifies the
size and SHA-256 before preloading the bytes in the worker. It saves verified
bytes in release-scoped Cache Storage for future visits. Project paths, source,
outputs, and arbitrary search misses stay local.

To extend the catalog, review a required style or class from an inventoried
bundle in the locked archive. Record its packed path, byte count, and SHA-256.
The preparation command checks the archive and bundle members, reports the
observed size and digest on a mismatch, and publishes only matching files.
The extracted `booktabs.sty` retains its LaTeX Project Public License notice.

## Verify a checkout

In addition to Node, npm, and `tar`, the test suite needs Poppler's
`pdftotext` and `pdffonts`, plus Chrome or Chromium and its system libraries.
Set `WRITEDOWN_BROWSER_EXECUTABLE` to an installed browser. You can also run
`npx playwright install --with-deps chromium` after `npm ci` to prepare
Playwright's Chromium, then leave the executable override unset.

```sh
npm ci && npm run assets:prepare && WRITEDOWN_BROWSER_EXECUTABLE=/usr/bin/google-chrome npm run check
```

`npm run check` typechecks, runs unit tests, builds `dist/`, and runs
Playwright. Production cases use a plain static server at `/writedown/`
and record page, dedicated-worker, and service-worker traffic. The tests
cover missing entry assets, interrupted extraction, repair after WASM
corruption, rejection of truncated archives, and exclusion of staging
leftovers. Browser fixtures check real worker exits, PDF text, and SyncTeX.

The `static-session` tests cover editing a chapter and bibliography,
previewing a formula, following a PDF-to-source jump, repairing an error,
and compiling a new edit offline with both servers stopped. They retain
screenshots at 1280×800 and 390×844 at 100% and 200% text size, plus PDFs,
SyncTeX, and request logs. To rerun the journey after building, use the same
browser setting as for the full suite.

```sh
WRITEDOWN_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
WRITEDOWN_TEST_OUTPUT="$PWD/test-results/static-session" \
npm run test:browser -- static-session
```

`npm run test:browser` expects an existing production build. Set
`WRITEDOWN_TEST_OUTPUT` and `WRITEDOWN_ASSET_TEST_OUTPUT` to retain browser
artifacts and asset-recovery receipts in specific directories. Both default
to the ignored `test-results/` directory.
