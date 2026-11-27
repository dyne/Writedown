# AGENTS.md

Applies throughout this repository.

## Commands

- Use Node `24.22.3` and npm `11.19.1`. Install with `npm ci`.
- Run `npm run assets:prepare` before a production build or the full suite. It
  requires `tar` and can reuse a verified local archive.
- Use `npm run typecheck` and `npm run test:unit` for focused TypeScript and
  unit checks. Run `node --test tests/unit/<name>.test.ts` for a single spec.
- Run `npm run build` before a focused production browser check. Use
  `npm run test:browser -- <spec>` to select cases. The suite needs Chromium
  and Poppler's `pdftotext` and `pdffonts`. Set
  `WRITEDOWN_BROWSER_EXECUTABLE` for an installed browser.
- Run `npm run check` for the combined typecheck, unit, build, and browser
  gate. Use `WRITEDOWN_TEST_OUTPUT` and `WRITEDOWN_ASSET_TEST_OUTPUT` to
  retain evidence outside the default `test-results/` directory.

## Code map

| Area | Entry points |
| --- | --- |
| App and editor wiring | `src/app.ts`, `src/editor/` |
| Immutable snapshots and IndexedDB | `src/project/` |
| Compile scheduling and worker transport | `src/compiler/service.ts`, `src/compiler/worker-runner.ts` |
| BusyTeX, diagnostics, and dependency resolution | `src/compiler/`, `compiler-release.json`, `compiler-dependencies.json` |
| PDF previews and source navigation | `src/viewer/`, `src/viewer/synctex/` |
| KaTeX and opt-in MathJax SVG | `src/formula/` |
| Static assets and offline caching | `vite.config.ts`, `scripts/`, `src/offline/` |
| Browser fixtures and request receipts | `tests/browser/`, `tests/support/` |

## Invariants

- Keep project data, generated files, logs, and arbitrary dependency misses on
  the device. Network dependency reads use verified, immutable catalog URLs.
  Keep BusyTeX's direct networking and shell escape disabled.
- Preserve snapshot ownership and monotonically increasing project revisions.
  Serialize worker operations and reject replies for superseded attempts.
- Keep each PDF, SyncTeX sidecar, and path map paired with the same attempt.
  A failed render can retain the last good PDF for that project. A project
  switch clears that display.
- Preserve the `/writedown/` production base and service-worker scope. Keep
  required assets verified and MathJax assets out of default precaching.
  Test browser behavior against `dist/` with the plain static fixture server.
- Update the release or dependency manifest and tests together when changing
  pinned compiler assets. Record tested capabilities and missing comparison
  inputs in [docs/compatibility.md](docs/compatibility.md).
- Keep generated compiler assets, caches, build output, test receipts, and
  workspace Org plan state out of commits.
