# Writedown

A static browser application for local LaTeX projects. **Compile example** builds
a real pdfLaTeX page in a browser worker and provides its PDF, SyncTeX and pass logs.
Project inputs and generated outputs stay in the browser.

Use Node **24.22.3** and npm **11.19.1** (see `.node-version`). Dependencies are
pinned in `package.json` and `package-lock.json`.

Preparation requires `tar`. The verification suite also requires `pdftotext`
(Poppler) and Chrome/Chromium with its operating-system libraries.
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
The combined engine uses only the local `texlive-basic` preload. Catalog lookups,
the remote dependency endpoint, bibliography and shell escape are disabled in
this reference adapter. Only pdfLaTeX without bibliography is qualified here.

The pinned base contains 7,185 files, four format dumps, 343 declared package
names and 3,557 font files. These are inventory counts, not claims that every
package or engine has passed a compilation test. The reference exercises the
article class, pdfLaTeX format and Computer Modern Roman. The complete file/font
and package inventories, upstream version inputs, wrapper AGPL notice and TeX Live
distribution notices are retained in [notices/compiler](notices/compiler/).
Additional package notices remain inside the unchanged upstream data payload.

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
Downloads happen during preparation, never during browser compilation.

The unit gate interrupts a real extraction after partial data has been written,
retries it, corrupts a required WASM file and verifies restoration, then rejects
a truncated archive. A production-build regression seeds staging, backup and
unlisted leftovers and checks that only the pinned compiler files ship.
Recovery receipts live under `WRITEDOWN_ASSET_TEST_OUTPUT`
(default `test-results/`). The browser gate observes the actual compiler worker,
checks successful pass exits, extracts the saved PDF marker with `pdftotext`,
and decompresses the matching SyncTeX. It retains those outputs and all requests.
