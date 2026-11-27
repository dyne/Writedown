# LaTeX compatibility

Writedown compiles with `busytex-1.4.1-basic`. The matrix describes the
documents exercised in a production worker with Google Chrome **157.0.8103.78**
on Linux, Playwright **1.65.1**, Node **24.22.3**, npm **11.19.1**, and Poppler
**25.03.0**. Each positive result applies to the listed recipe. Package and
font inventories describe the available inputs.
[Release manifest](../compiler-release.json) · [TeX Live inventory](../notices/compiler/texlive-basic.txt)

## Reproduce the browser results

From the checkout containing this matrix, follow the browser prerequisites and
the clean-start procedure in the [README](../README.md). To retain just the
compiler fixtures for comparison, run the following after `npm ci` and
`npm run assets:prepare`.

```sh
npm run build
WRITEDOWN_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
WRITEDOWN_TEST_OUTPUT="$PWD/test-results/compatibility" \
npm run test:browser -- compiler-release project-compilation compiler-dependencies
```

Use `npm run check` with the same browser setting for the full gate.
The release pairs wrapper `texlyre-busytex@1.4.1` with the `assets-v1.4.1`
archive (release ID `414988571`, asset ID `647410010`, archive SHA-256
`4f63731fe4ec9238d877846074ab424350add6f6e956944def389e6752d2c78b`).
The release manifest pins every file used by the build. The package lock pins
the wrapper tarball and the PDF.js distribution that supplies the project test
font. [Upstream archive release](https://github.com/TeXlyre/texlyre-busytex/releases/tag/assets-v1.4.1) · [Package lock](../package-lock.json)

Test titles and artifact names below identify the fixture. The SHA-256s identify
the exact source revisions in this matrix.

| Fixture source | SHA-256 |
| --- | --- |
| [compiler-release.spec.ts](../tests/browser/compiler-release.spec.ts) | `70b4341ef5cf9b4b5608a63c44485f138febd149e7edf5b4ead26c0a622a66fb` |
| [project-compilation.spec.ts](../tests/browser/project-compilation.spec.ts) | `0c2b7f566a6ba902e7eb729d7a4d4a2451fd06775248bce4214a4c2fb7825e0e` |
| [compiler-dependencies.spec.ts](../tests/browser/compiler-dependencies.spec.ts) | `7d9f9f951ae5971f3ae4116993b777445d890afe836f718685368d1e9fe119a8` |

## Production worker results

In the fixture column, **release** means `compiler-release.spec.ts`,
**project** means `project-compilation.spec.ts`, and **dependency** means
`compiler-dependencies.spec.ts`. For release tests, the inputs are in
`sources/`, and the outputs are `<engine>.pdf`, `result.synctex.gz` and
`result.json`. For project and dependency tests, inputs are in
`sources/<job>/`, and the outputs are `<job>.pdf`, `<job>.synctex.gz`
and `<job>-result.json`. An expected compile failure retains its diagnostic
and pass data.

| Workflow | Fixture and observed browser result | Native comparison |
| --- | --- | --- |
| pdfLaTeX, `article`, nested inputs, Computer Modern | **release**, `pdflatex`. PDF contains the selected root, its nested chapter and its parent-directory input. SyncTeX resolves all three paths. | Unverified. Matching pdfTeX, LaTeX format inputs, Computer Modern metrics, map and font are absent. |
| XeLaTeX, bundled OpenType font | **release**, `xelatex`. The `xdvipdfmx` pass produces the PDF and embeds Latin Modern Sans 10 Regular from TeX Live. | Unverified. Matching XeTeX, `xdvipdfmx`, format inputs and Latin Modern fonts and metrics are absent. |
| LuaLaTeX | **release**, `lualatex`. The `luahblatex` applet produces the marker PDF and SyncTeX from `article`. | Unverified. Matching LuaHBTeX, LuaLaTeX format inputs, Latin Modern data and font loader are absent. |
| `graphicx`, project PNG, cross-reference and BibTeX | **project**, `original` and `revised`. Both two-page PDFs contain the chapter, reference `1` and citation `[1]`. The title changes from *Original Evidence* to *Revised Evidence*. The `bibtex8` pass uses `plain.bst`. | Unverified. Matching pdfTeX and its data, `graphicx`, driver files, `bibtex8` and `plain.bst` are absent. The PNG and bibliography are exported with the fixtures. |
| MakeIndex | **project**, `index`. `makeidx` generates an index, a separate MakeIndex pass succeeds, and the PDF contains `FixtureIndexEntry`. | Unverified. Matching pdfTeX, `makeidx` and MakeIndex are absent. |
| Project style and optional catalog package | **dependency**, `project-style`, `cold-package`, `cached-package`. A project style wins locally. The pinned catalog `booktabs.sty` supports the table after a verified download and again from cache after worker restart. `disabled-endpoint` fails on a cold cache. | Unverified. Matching pdfTeX, `graphicx` and its driver data are absent. The exact catalog `booktabs.sty` can be extracted from the archive. |
| Project TrueType font | **project**, `project-font`. XeLaTeX loads the fixture's `paper/fonts/project-font.ttf` by path. The PDF has the marker and an embedded Liberation Sans font. | Unverified. Matching XeTeX, `xdvipdfmx` and base format and font data are absent. The project font bytes are exported with the fixture. |
| Missing explicit font | **project**, `unavailable-font`. XeLaTeX reports the missing `UnavailableFixtureFont.ttf` at the source path. No PDF is published. | Unverified. The matching XeTeX stack is absent. Keep the requested font absent to reproduce the failure. |
| LaTeX font substitution | **project**, `substituted-font`. The unknown font family triggers a LaTeX substitution warning. The PDF contains the marker with embedded `CMR10`. | Unverified. Matching pdfTeX and the Computer Modern fallback data are absent. |
| Biber | **project**, `biber`. Writedown reports missing `biber.js`, `biber.wasm` and `biber.data` before starting a compile worker. | Browser PDF comparison is inapplicable for this release. Native Biber is absent. |
| External command | **project**, `external-tool`. The pdfTeX log shows that shell execution is disabled. The fixture reports the missing command output at the source path and publishes no PDF. | Unverified. Matching pdfTeX and its format data are absent. Run the native control with `-no-shell-escape` and a fresh directory. |

The browser release ships the basic preload and can request the catalogued
`booktabs.sty` from a configured endpoint. The full TeXlyre editor documents
a recommended preload, wider on-demand TeX Live file and font lookup, and a
Biber/BibLaTeX workflow. Its documented multilingual hyphenation and tagged-PDF
workflows are outside this fixture matrix. Host system fonts and native shell
commands are unavailable in TeXlyre's browser sandbox. Writedown also disables
browser-side shell handlers. [TeXlyre compilation capabilities](https://texlyre.github.io/docs/latex-compilation/overview) · [Local dependency catalog](../compiler-dependencies.json) · [Writedown worker transport](../src/compiler/worker-runner.ts)

## Native comparison recipe

The reference run found Poppler on the host. It found no `pdflatex`,
`xelatex`, `xdvipdfmx`, `luahblatex`, `lualatex`, `bibtex8`,
`bibtex`, `biber`, `makeindex`, `kpsewhich`, `synctex` or
`tlmgr` on PATH, and no TeX Live tree in the standard locations checked.
No native comparison was run.

1. Match the native inputs before comparing. The upstream dependency record lists
   TeX Live source tag `texlive-2026.0` and `texlive2026.iso`. Target the
   logged pdfTeX `3.141592653-2.6-1.40.29`, XeTeX
   `3.141592653-2.6-0.999998`, LuaHBTeX `1.24.0`, BibTeX8
   `0.99d-x4.0` and MakeIndex `2.18`. The browser logs record LaTeX2e
   `2025-11-01`, L3 `2026-01-19`, and `article.cls`
   `2025/01/22 v1.4n`. Use native formats generated from the matching
   LaTeX sources. The WASM format dumps are platform-specific. Record the native
   tool versions and the hashes of files resolved by the native tools, including
   fonts, metrics, maps, driver files and format sources. Use `-recorder` on
   the native TeX passes to capture input paths in `main.fls` and
   `kpsewhich` to locate individual files. Match data against the locked
   TeX Live archive and its inventories. The TeX Live year alone is insufficient
   to establish a match. Record any missing or mismatched input as unverified.
   [Upstream version inputs](../notices/compiler/versions.txt)

   | Identifying input | SHA-256 |
   | --- | --- |
   | Computer Modern Roman `cmr10.pfb` | `61d5da34985e8fff8b65859ba7526dcad30a930b94116ac9c45316f8658b12c2` |
   | Latin Modern Sans `lmsans10-regular.otf` | `eafeff07bdca224bb5e7aae037a55ed67a234253c50e8f451c0803bc3e4a4126` |
   | Latin Modern Roman `lmroman10-regular.otf` | `df3e2eb9d5e8e2dc7e5ced7c75ede7413e8970da9b0b53ae9a712e869a7b7151` |
   | Project font, PDF.js `6.5.438` `LiberationSans-Regular.ttf` | `f8ace1f892b2bd9dc1792ba7f097fa7588f84fed48321480e04de5390828221f` |
   | `plain.bst` | `b155b64491a05ea9a86c83bd85c08628ec2136ecf92612a03d5c32adb21a1323` |
   | Catalog `booktabs.sty` | `3fe694a5406f84847143e56ba1841385364277cfe7694a9f4bc0072ca8656abc` |

2. Copy one exported `sources` tree per fixture into a fresh native working
   directory. Preserve the relative paths. Use `paper/` as the working
   directory for pdfLaTeX's nested release fixture and every project and
   dependency fixture. Use the fixture root for the XeLaTeX and LuaLaTeX release
   fixtures. For the downloaded or cached package case, extract the exact catalog
   file with `node scripts/prepare-dependencies.ts /absolute/package-staging`
   from the checkout, then copy the published `booktabs.sty` to the native
   working directory. The project-style case already has its own file.

3. Replay the tool order from the successful browser result JSON with the same
   arguments, using the matching native format for each WASM `--fmt` path.
   For negative cases, record the diagnostic and whether a PDF was created.
   Start with the following commands for the respective engines. Run the listed
   passes again in the browser result's order. Use the final pdfLaTeX PDF pass
   with `-interaction=nonstopmode -output-format=pdf`; retain all logs.

   ```sh
   pdflatex -recorder -synctex=1 -no-shell-escape -interaction=batchmode -halt-on-error main.tex
   xelatex -recorder -synctex=1 -no-shell-escape -interaction=batchmode -halt-on-error -no-pdf main.tex
   luahblatex -recorder -synctex=1 -no-shell-escape -interaction=nonstopmode -halt-on-error --nosocket main.tex
   ```

   For the citation fixture, run `bibtex8 --8bit main.aux` after the first
   pdfLaTeX pass. For the index fixture, run `makeindex main.idx` after that
   first pass. For XeLaTeX, finish with `xdvipdfmx -o main.pdf main.xdv`.
   If the native LaTeX launcher is called `lualatex`, use it for the LuaLaTeX
   passes only after its banner confirms LuaHBTeX and the format inputs match.
   Keep the generated PDF and `main.synctex.gz` together.

4. Use the same Poppler build on both PDFs. Read `Pages` from `pdfinfo`
   and compare normalized text page by page. This example preserves page
   boundaries while collapsing runs of whitespace and normalizing Unicode.
   The citation fixture should include `Citation: [1].` and the
   corresponding entry title on both sides. Check the index entry and font
   embedding with `pdffonts` for the relevant rows. Ignore creation dates,
   document IDs and other metadata.

   ```sh
   python3 - browser.pdf native.pdf <<'PY'
   import difflib
   import subprocess
   import sys
   import unicodedata

   def pages(path):
       text = subprocess.check_output(["pdftotext", "-layout", path, "-"], text=True)
       return [" ".join(unicodedata.normalize("NFC", page).split()) + "\n"
               for page in text.removesuffix("\f").split("\f")]

   browser, native = map(pages, sys.argv[1:])
   diff = list(difflib.unified_diff(browser, native, fromfile=sys.argv[1], tofile=sys.argv[2]))
   print("".join(diff), end="")
   raise SystemExit(bool(diff))
   PY
   ```

5. Compare SyncTeX anchors at the same project-relative source file and line.
   Copy each PDF and its sidecar to names with the same stem on its respective
   side. Read the `Input:` records with `gzip -dc` and use the source
   path recorded on each side. For example, query the nested chapter at line 1
   using `synctex view -i "1:1:$source_path" -o "$pdf"`. Query the cited
   line and the Findings heading separately for the bibliography case.
   Record each result's page and `x`/`y` coordinates in PDF points. Compare
   corresponding pages and positions, allowing up to 0.5 point per axis for
   rounding. Use `pdftotext -bbox-layout` to inspect the matching marker if
   the query returns several candidates. Save the observed native result,
   versions, data hashes and any differences alongside the browser artifacts.
