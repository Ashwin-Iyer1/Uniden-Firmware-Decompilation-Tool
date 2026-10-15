# Browser firmware workbench

Use the [web editor](https://ashwin-iyer1.github.io/Uniden-Firmware-Decompilation-Tool/)
to open your own firmware file, inspect its sections, edit supported display text and
replace the boot logo. Download a separate modified `.bin` and a JSON change report.
Keep your original firmware for recovery.

## Supported edits

The initial editing profile is **R7 v153.150.127**. The editor verifies decoded UI,
DSP and GPS content, not the filename or version numbers alone. It permits three
fixed text slots and the 176 × 60, four-shade boot logo. Text uses printable ASCII
and must fit its original storage slot. The two “Alert Display” fields rename menu
labels; they do not create new owner-information screens.

Previously exported text/logo edits can be reopened: the UI fingerprint excludes
only those editable ranges. Other UI code changes, different DSP/GPS images, and
unverified versions disable editing. Recognized containers without a supported
editing profile can still be inspected; malformed or unknown container structures
are rejected. The file limit is 32 MiB.

Code, radio settings, GPS databases, scan animation, audio and other models are not
editable in this first web version. The existing Python tools remain available
for the broader features documented in this repository.

## File handling and export

All file processing happens in browser memory. There is no upload endpoint,
account, database, analytics, third-party script, or automatic file storage.
GitHub Pages serves the application files; firmware and uploaded logo contents
are never sent to it. Refreshing or closing the tab discards the current session.

The exporter retains the container length, all file bytes outside the UI section,
and all decoded UI bytes outside the permitted ranges. It reports input/output
SHA-256 hashes. A no-change export is byte-identical
to the input. The UI enables downloads after a valid change is reviewed.

This is an experimental editor. Byte-level checks do not establish hardware
compatibility. Modified exports have not been tested on a detector. The editor
does not flash devices; consult [FLASHING.md](FLASHING.md) before using an output.

## Local development

No build step or runtime dependencies are required. Serve **only `web/`**, so local
firmware and decompiler output cannot be fetched from a development server:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory web
# Open http://127.0.0.1:4173
node --test tests/web_firmware.test.mjs
python3 -m unittest discover -s tests -v
```

Node.js 22 or later runs the JavaScript tests. Optional local fixture tests use
`R7_FIXTURE=/absolute/path/to/your/firmware.bin`; never commit that file or exports.

For browser integration checks, install Playwright into a directory outside this
repository and run its Chromium installer. With the local server running:

```sh
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs \
R7_FIXTURE=/absolute/path/to/your/firmware.bin \
node tests/web_browser.mjs
```

The optional fixture must be the stock R7 v153.150.127 image for these checks. The
browser suite compares complete downloaded text/logo edits against the independent
Python codec, checks reset and reimport, and monitors for upload requests. Without
a fixture it checks the empty workbench and malformed input. Screenshots and
downloads are written only under ignored `decoded/web-qa/`.

`web/firmware.mjs` owns parsing, profile verification and byte edits;
`web/app.mjs` owns file selection, previews and downloads. Contributions for more
versions should add independently verified profiles and tests, never loosen the
existing identity checks to make an unfamiliar file editable.

The [Pages workflow](../.github/workflows/pages.yml) checks the Python regressions
and JavaScript engine before publishing **only `web/`** from `main`. It also runs
checks for pull requests, without publishing their changes. Setup follows GitHub's
[custom workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
