# Writedown

A static browser application for local LaTeX projects. **Compile example** builds
a real pdfLaTeX page in a browser worker and provides its PDF, SyncTeX and pass logs.
Project inputs and generated outputs stay in the browser.
The editor compiles the current TeX root automatically after 300 ms without
edits. Its compilation status follows the current revision. Use **Retry
compilation** after a failed attempt.

Select TeX math in the source to see it in **Formula preview**, with or without
inline or display delimiters. To share macros across a project's selections,
add a root-level `formula-macros.tex` with one `\newcommand` definition per line.
Definitions can take required arguments. This preview uses KaTeX and its local
fonts. The production build ships their licenses under `notices/`.

Choose **MathJax SVG** in **Formula renderer** to get SVG output from the
selected fragment. Basic TeX, AMS math, and project macros are available with
this renderer. The first selection loads the pinned MathJax components and
TeX font data from `mathjax/4.1.3/`. Keep the choice on KaTeX for the default
preview. To make SVG available offline, render a formula online first. After
an offline reload you can select SVG again using the cached components.

Use Node **24.22.3** and npm **11.19.1** (see `.node-version`). Dependencies are
pinned in `package.json` and `package-lock.json`.

Preparation requires `tar`. The verification suite also requires `pdftotext`
and `pdffonts` (Poppler) and Chrome/Chromium with its operating-system libraries.
Either provide an existing browser with `WRITEDOWN_BROWSER_EXECUTABLE`, or prepare
Playwright's matching Chromium once with `npx playwright install --with-deps chromium`
after `npm ci`. Browser installation is an environment prerequisite, not part of
the check command. On a machine with Chrome at `/usr/bin/google-chrome`, the
clean-start command is:

```sh
npm ci && npm run assets:prepare && WRITEDOWN_BROWSER_EXECUTABLE=/usr/bin/google-chrome npm run check
```

`npm run check` runs strict TypeScript checking, Node unit tests, a Vite production
build, then Playwright against that build. The test fixture is a plain Node static
server mounting `dist/` at `/writedown/`, without a development server or fallback
HTML for missing assets. It records every incoming request, including worker and
service-worker requests, and attaches records to the browser result. Four smoke
cases cover 1280×800 and 390×844 at 100% and 200% text size with local screenshots.
A negative case removes the compiled entry from a disposable copy and requires the
same smoke assertion to fail on its 404. The original `dist/` remains available.

Use `WRITEDOWN_TEST_OUTPUT=/absolute/path` for retained browser artifacts; by
default they go to ignored `test-results/`. `npm run test:browser` requires an
existing prepared build. `npm run dev` serves development source. Deploy the files in
`dist/` under `/writedown/` on a static host with JavaScript MIME types.

`compiler-release.json` pins wrapper **texlyre-busytex 1.4.1** and the matching
**assets-v1.4.1** archive by URL, GitHub release/asset IDs, sizes and SHA-256
digests. The lockfile pins wrapper integrity. The archive is 521,748,902 bytes;
the selected static payload is 128,304,494 bytes, plus the application bundles.
The combined engine starts with the local `texlive-basic` preload. The adapter
keeps BusyTeX's native dependency networking and shell escape disabled.
The production worker fixtures qualify pdfLaTeX, XeLaTeX with
`xdvipdfmx`, and LuaLaTeX with the release's `luahblatex` applet.

The pinned base contains 7,185 files, four format dumps, 343 declared package
names and 3,557 font files. These are inventory counts, not claims that every
package or engine has passed a compilation test. The reference exercises the
article class, pdfLaTeX format and Computer Modern Roman. The XeLaTeX fixture
loads the pinned Latin Modern Sans OpenType font and checks its embedded PDF
font name. The complete file/font and package inventories, upstream version
inputs, wrapper AGPL notice and TeX Live distribution notices are retained in
[notices/compiler](notices/compiler/).
Additional package notices remain inside the unchanged upstream data payload.

The worker resolves relative TeX input paths from the selected entry's directory.
For a root at `paper/main.tex`, `\input{chapters/intro.tex}` reads
`paper/chapters/intro.tex` and `\input{../shared.tex}` reads `shared.tex` at the
project root. Compiler results carry the snapshot path map for log locations and
SyncTeX input records. The pinned driver's artifact names use the first literal
`.tex` in the entry filename. Use a lowercase `.tex` suffix with no earlier
`.tex` in the basename.

The driver mounts a fresh writable project filesystem for each complete snapshot.
All passes of that job share its auxiliary files. The driver runs TeX, then
BibTeX when selected, then MakeIndex if TeX generated index entries. It runs up
to three more TeX passes for references and final output, then `xdvipdfmx` for
XeLaTeX. The bound is four TeX passes and at most seven tool calls in total.
Final citation and rerun warnings appear alongside raw pass output. The
driver retains the full TeX log for its last TeX pass and returns output and
auxiliary data for earlier passes. The basic release lacks the standalone
Biber payload, so selecting Biber reports which assets are missing.

One service serializes worker initialization, dependency preloading and jobs.
Edits immediately invalidate publication for the previous revision and replace
the pending snapshot. An initialized worker is reused for ordinary edits and
retired on project, engine or release changes. Startup has a 180-second
deadline and each complete compile has a separate 120-second deadline.
After a timeout or worker failure, the next eligible revision or a manual
retry starts another worker using the editor's existing snapshot.

Preparation caches the verified archive in ignored `.cache/compiler/`, extracts
to private `.cache/compiler-staging/` storage outside the public tree, verifies
every shipped file, then publishes the full
set to `public/compiler/busytex-1.4.1-basic/`. Reuse checks all file digests; an
incomplete or corrupted published set is rebuilt. A local archive supplied with
`WRITEDOWN_ASSET_ARCHIVE=/absolute/file.tar.gz` must match the pinned bytes.
`WRITEDOWN_ASSET_CACHE` and `WRITEDOWN_ASSET_ROOT` override preparation locations;
production builds always verify the normal `public/compiler/` location. For a
custom publication root, preparation uses private scratch inside that writable
root. Its parent and the repository cache need no write access, and directory
renames remain on the target filesystem.
Production builds disable Vite's recursive public-directory copying and emit
only descriptor-listed files after checking the exact bytes handed to the
bundler. Leftover stages, backups and unlisted files cannot enter `dist/`.
Provisioning downloads the pinned release archive during preparation.

The unit gate interrupts a real extraction after partial data has been written,
retries it, corrupts a required WASM file and verifies restoration, then rejects
a truncated archive. A production-build regression seeds staging, backup and
unlisted leftovers and checks that only the pinned compiler files ship.
Recovery receipts live under `WRITEDOWN_ASSET_TEST_OUTPUT`
(default `test-results/`). The browser gate observes the actual compiler worker,
checks successful pass exits, extracts the saved PDF marker with `pdftotext`,
and decompresses the matching SyncTeX. It retains those outputs and all requests.

## Optional TeX dependency endpoint

The compiler first tries the project files, the bundled TeX tree and verified
files already in its resident worker. When TeX reports a required style or
class missing, the adapter can preload the matching entry from the local
release cache or obtain it from an optional endpoint. The catalog in
[`compiler-dependencies.json`](compiler-dependencies.json) approves only
`booktabs.sty` for this release. Other missing files stay local and appear in
the compilation diagnostics.

Leave `VITE_TEX_DEPENDENCY_ENDPOINT` unset or empty to use the bundled release
and any verified dependencies already in browser storage. To enable downloads,
set the public build-time variable to the endpoint directory URL and run
`npm run build`. Use an absolute HTTPS URL without credentials, a query or
a fragment. HTTP loopback URLs work for local testing.

After preparing the compiler, generate the endpoint files in a staging
directory with the pinned archive. The command honors `WRITEDOWN_ASSET_ARCHIVE`
and `WRITEDOWN_ASSET_CACHE`.

```sh
node scripts/prepare-dependencies.ts /absolute/path/to/dependency-staging
```

Serve the resulting `<release-id>/<sha256>/<filename>` paths as immutable
binary files under the configured directory. A separate origin must allow
the app's origin with CORS. The browser issues a credential-free GET to the
exact catalog URL, verifies the size and SHA-256 before use and stores the
verified bytes in release-scoped Cache Storage. The worker receives those
bytes through the pinned preload message. Project paths, source, outputs and
arbitrary search misses stay on the device.

To extend the catalog, choose a required style or class from an inventoried
bundle in the same locked archive and record its exact packed path, byte count
and SHA-256 after reviewing it. The preparation command verifies the archive
and bundle members, extracts the selected file and reports its observed size
and digest on a catalog mismatch. It publishes each file only after verifying
the catalog pin. The extracted booktabs file retains its LaTeX Project Public
License notice from the TeX Live distribution.

## Offline access

A production build registers a service worker under `/writedown/` on HTTPS
or a loopback origin. **Offline access is ready** means the worker controls the
page and has verified and saved the app shell and the pinned compiler files.
Compile once with each required optional dependency while online so that its
verified bytes are available on the next visit.

The app-owned runtime cache is keyed by scope, compiler release and build.
An update verifies a separate set before it can replace the active worker.
After the update is ready, close the open Writedown tabs to apply it. An
interrupted installation leaves the previous version usable. Use **Retry
offline setup** after restoring service or freeing browser storage.

The BusyTeX wrapper tracks its preload version in local storage and can clear
its own `EM_PRELOAD_CACHE` database when that version changes. The worker can
rebuild that database offline from the app-owned copy of the verified release.
Optional dependency bytes are kept in a separate release cache. If a verified
dependency compiles online but cannot be saved, **Retry dependency cache**
starts a fresh worker for the same project revision.

Cache repair is independent of the IndexedDB project store. If a saved project
references a compiler release that the current build cannot run, the editor
shows the unavailable release and offers an explicit switch to the installed
one. Switching saves a new revision with the same source files.
