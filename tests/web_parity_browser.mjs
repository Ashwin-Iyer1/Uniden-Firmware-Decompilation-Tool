#!/usr/bin/env node
/** Browser parity coverage for settings, offset strings, and Python patch files.
 * Serve web/ on localhost:4173 or set WEB_URL. Install Playwright externally;
 * PLAYWRIGHT_MODULE may select its index.mjs. R7_FIXTURE enables private-stock
 * comparisons against the Python tools. Generated files remain under decoded/.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "decoded/web-qa/parity");
const url = process.env.WEB_URL || "http://127.0.0.1:4173";
const fixture = process.env.R7_FIXTURE && path.resolve(process.env.R7_FIXTURE);
const errors = [], network = [];
let passed = 0;
async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE)
    return import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href);
  for (const name of ["playwright", "playwright-core"]) {
    try { return await import(name); }
    catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
  }
  throw new Error("Install Playwright externally and set PLAYWRIGHT_MODULE.");
}
function python(program, args = [], binary = false) {
  const result = spawnSync(process.env.PYTHON || "python3", ["-c", program, root, ...args], {
    encoding: binary ? null : "utf8", maxBuffer: 40 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr?.toString() || result.error?.message || "Python reference failed");
  return result.stdout;
}
async function check(name, action) {
  await action();
  console.log(`PASS ${name}`);
  passed++;
}
const pythonImports = String.raw`
import sys, pathlib, json, contextlib, io
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / 'tools'))
from r7_settings import patch_firmware, SETTINGS
from rseries_patch import setstr, patch
from rseries_unpack import parse, decode_old_model, encode_old_model
`;
await mkdir(out, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    const request = route.request(), target = new URL(request.url());
    if (["http:", "https:"].includes(target.protocol) &&
        (target.origin !== new URL(url).origin || !["GET", "HEAD"].includes(request.method()))) {
      network.push(`${request.method()} ${target.origin}${target.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(url, { waitUntil: "networkidle" });
  const tab = async (name) => {
    await page.locator(`#tab-${name}`).click();
    await page.locator(`#panel-${name}`).waitFor({ state: "visible" });
  };
  const count = async () => Number(await page.locator("#operation-count").textContent());
  const waitCount = async (expected) => page.waitForFunction(
    (value) => Number(document.querySelector("#operation-count").textContent) === value, expected);
  const open = async (input) => {
    await page.locator("#firmware-file").setInputFiles(input);
    await page.locator("#editor-shell").waitFor({ state: "visible" });
    await page.waitForFunction(
      (name) => document.querySelector("#file-name").textContent === name,
      typeof input === "string" ? path.basename(input) : input.name);
    await page.waitForFunction(() => document.querySelector("#load-status").textContent === "Firmware opened.");
    await waitCount(0);
  };
  const stock = async () => {
    // Reset the file input so a repeated stock upload always dispatches change.
    await page.locator("#firmware-file").setInputFiles([]);
    await open(fixture);
  };
  const settings = async () => {
    await tab("settings");
    await page.waitForFunction(() => /\bverified\b|unapplied settings/i.test(document.querySelector("#settings-status").textContent));
    await page.locator("#settings-content").waitFor({ state: "visible" });
    assert.equal(await page.locator("#settings-content").isVisible(), true);
  };
  const expandFor = async (selector) => {
    const details = page.locator(selector).locator("xpath=ancestor::details");
    for (let i = (await details.count()) - 1; i >= 0; i--)
      if (!(await details.nth(i).evaluate((element) => element.open)))
        await details.nth(i).locator(":scope > summary").click();
  };
  const download = async (name) => {
    await tab("review");
    await page.locator("#prepare-download").click();
    await page.locator("#download-firmware").waitFor({ state: "visible" });
    const pending = page.waitForEvent("download");
    await page.locator("#download-firmware").click();
    const result = await pending, filename = path.join(out, name);
    await result.saveAs(filename);
    assert.equal(await result.failure(), null);
    return filename;
  };
  const noOverflow = async () => assert.equal(await page.evaluate(
    () => document.documentElement.scrollWidth <= innerWidth), true, "Page overflows horizontally");
  const setSettings = async (changes) => {
    for (const [name, value] of Object.entries(changes)) {
      const control = page.locator(`#settings-input-${name}`);
      if (name === "auto_mute_delay_ms") await control.fill(String(value));
      else await control.selectOption(String(value));
    }
  };
  const raw = async (section, offset, bytes) => {
    await tab("raw");
    await page.locator("#raw-section").selectOption(section);
    if (section !== "file") await page.locator("#raw-decoded").check();
    await page.locator("#raw-type").selectOption("hex");
    await page.locator("#raw-patch-offset").fill(offset);
    await page.locator("#raw-value").fill(bytes);
    await page.locator("#apply-raw").click();
  };
  const batch = async (section, text, filename = null) => {
    await tab("raw");
    await page.locator("#raw-section").selectOption(section);
    if (section !== "file") await page.locator("#raw-decoded").check();
    await expandFor("#patch-text");
    if (filename) {
      await page.locator("#patch-file").setInputFiles({
        name: filename, mimeType: "text/plain", buffer: Buffer.from(text),
      });
      await page.waitForFunction(
        (value) => document.querySelector("#patch-text").value === value, text);
    } else await page.locator("#patch-text").fill(text);
  };

  await check("Unsupported binaries cannot expose guarded settings", async () => {
    await open({ name: "unsupported-settings.bin", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3, 4]) });
    await tab("settings");
    await page.locator("#settings-unavailable").waitFor({ state: "visible" });
    await page.waitForFunction(() => /unavailable/i.test(document.querySelector("#settings-unavailable").textContent));
    assert.equal(await page.locator("#settings-content").isVisible(), false);
    assert.match(await page.locator("#settings-unavailable").textContent(), /R7|unsupported|UI|section/i);
    assert.equal(await count(), 0);
  });
  await check("Invalid patch files reject atomically before any edit", async () => {
    await batch("file", "0 aa\n4 bb\n");
    await page.locator("#apply-patch-file").click();
    await page.locator("#error").waitFor({ state: "visible" });
    assert.equal(await count(), 0);
    assert.equal(await page.locator("#prepare-download").isDisabled(), true);
    await page.locator("#patch-text").fill("0 aa\n1 not-hex\n");
    await page.locator("#apply-patch-file").click();
    assert.equal(await count(), 0);
  });

  if (fixture) {
    const changes = { auto_mute_delay_ms: 15750, default_theme: 3, default_mute_volume: 6, default_mute_level: 4 };
    let settingsFile;
    await check("All guarded settings export exactly the Python instruction patches", async () => {
      await stock();
      await settings();
      assert.equal(await page.locator("#settings-input-default_theme").inputValue(), "");
      await setSettings(changes);
      await page.locator("#apply-settings").click();
      await waitCount(1);
      settingsFile = await download("settings-all.bin");
      python(pythonImports + String.raw`
original = pathlib.Path(sys.argv[2]).read_bytes()
actual = pathlib.Path(sys.argv[3]).read_bytes()
expected, report = patch_firmware(original, json.loads(sys.argv[4]))
assert actual == expected, 'Browser settings differ from Python patch_firmware'
assert report['other_sections_identical']
`, [fixture, settingsFile, JSON.stringify(changes)]);
      await page.locator("#undo").click();
      await waitCount(0);
      assert.equal(await page.locator("#prepare-download").isDisabled(), true);
    });
    await check("Reopening settings output retains identified profile and current values", async () => {
      await open(settingsFile);
      await settings();
      for (const [name, value] of Object.entries(changes))
        assert.equal(await page.locator(`#settings-input-${name}`).inputValue(), String(value));
      await tab("overview");
      assert.equal(await page.locator("#profile-state").textContent(), "R7 v153.150.127");
      await tab("bands");
      await page.locator("#band-low-0").waitFor({ state: "visible" });
      assert.equal(await count(), 0);
    });
    await check("A reference load cannot discard a settings draft started while it is pending", async () => {
      await stock();
      await settings();
      await tab("overview");
      await page.evaluate(() => {
        const original = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = async function () {
          if (this.name === "delayed-reference.bin") {
            await new Promise((resolve) => { window.__releaseReference = resolve; });
            File.prototype.arrayBuffer = original;
          }
          return original.call(this);
        };
      });
      await page.locator("#reference-file").setInputFiles({
        name: "delayed-reference.bin", mimeType: "application/octet-stream",
        buffer: await readFile(fixture),
      });
      await page.waitForFunction(() => typeof window.__releaseReference === "function");
      await settings();
      await setSettings({ auto_mute_delay_ms: 3800 });
      await page.evaluate(() => window.__releaseReference());
      await page.waitForFunction(() => /draft was started while the reference was loading/i.test(
        document.querySelector("#error").textContent));
      assert.equal(await page.locator("#settings-input-auto_mute_delay_ms").inputValue(), "3800");
      assert.equal(await page.locator("#apply-settings").isEnabled(), true);
      assert.equal(await count(), 0);
      await page.locator("#apply-settings").click();
      await waitCount(1);
      const actual = await download("settings-after-delayed-reference.bin");
      python(pythonImports + String.raw`
expected, _ = patch_firmware(pathlib.Path(sys.argv[2]).read_bytes(), {'auto_mute_delay_ms':3800})
assert expected == pathlib.Path(sys.argv[3]).read_bytes()
`, [fixture, actual]);
    });
    await check("Settings drafts survive navigation and unrelated DSP edits", async () => {
      await stock();
      await settings();
      await setSettings({ auto_mute_delay_ms: 4200, default_mute_volume: 5 });
      await tab("overview");
      await settings();
      assert.equal(await page.locator("#settings-input-auto_mute_delay_ms").inputValue(), "4200");
      await raw("dsp_nu", "0xdd38", "3b 39 a0 00");
      await waitCount(1);
      await settings();
      assert.equal(await page.locator("#settings-input-default_mute_volume").inputValue(), "5");
      await page.locator("#apply-settings").click();
      await waitCount(2);
      const actual = await download("settings-with-dsp.bin");
      python(pythonImports + String.raw`
original = pathlib.Path(sys.argv[2]).read_bytes()
expected, _ = patch_firmware(original, {'auto_mute_delay_ms':4200, 'default_mute_volume':5})
s = next(s for s in parse(expected) if s['name']=='dsp_nu'); off=s['offset']; size=s['length']
d = bytearray(decode_old_model(s['key'], expected[off:off+size]))
d[0xdd38:0xdd3c] = bytes.fromhex('3b 39 a0 00')
expected = expected[:off] + encode_old_model(s['key'], d) + expected[off+size:]
assert expected == pathlib.Path(sys.argv[3]).read_bytes()
`, [fixture, actual]);
      await page.locator("#reset-all").click();
      await waitCount(0);
    });
    await check("A stale settings draft cannot overwrite a newer coupled UI edit", async () => {
      await stock();
      await settings();
      await setSettings({ auto_mute_delay_ms: 4500 });
      const replacement = python(pythonImports + String.raw`
print('\n'.join(f'{site.offset:x} {site.encode(2000).hex()}' for site in SETTINGS['auto_mute_delay_ms'].sites))
`);
      await batch("ui_nu", replacement);
      await page.locator("#apply-patch-file").click();
      await waitCount(1);
      await settings();
      assert.equal(await page.locator("#settings-input-auto_mute_delay_ms").inputValue(), "4500");
      await page.locator("#apply-settings").click();
      await page.locator("#error").waitFor({ state: "visible" });
      assert.match(await page.locator("#error").textContent(), /changed|conflict|reload|discard/i);
      assert.equal(await count(), 1);
      const actual = await download("settings-stale-rejected.bin");
      python(pythonImports + String.raw`
expected, _ = patch_firmware(pathlib.Path(sys.argv[2]).read_bytes(), {'auto_mute_delay_ms':2000})
assert expected == pathlib.Path(sys.argv[3]).read_bytes()
`, [fixture, actual]);
    });
    await check("Partial coupled instruction changes disable guarded settings", async () => {
      await stock();
      await raw("ui_nu", "0x1d0a6", "03 20");
      await waitCount(1);
      await tab("settings");
      await page.locator("#settings-unavailable").waitFor({ state: "visible" });
      await page.waitForFunction(() => /coupled|inconsistent/i.test(document.querySelector("#settings-unavailable").textContent));
      assert.match(await page.locator("#settings-unavailable").textContent(), /coupled|inconsistent/i);
      assert.equal(await page.locator("#settings-content").isVisible(), false);
      assert.equal(await count(), 1);
    });
    await check("Offset string editing accepts Latin-1 and preserves the Python field", async () => {
      await stock();
      await tab("text");
      await page.locator("#text-section").selectOption("ui_nu");
      await expandFor("#text-offset");
      await page.locator("#text-offset").fill("0x22b0");
      await page.locator("#text-read").click();
      await page.locator("#string-form").waitFor({ state: "visible" });
      await page.locator("#string-value").fill("Caf\u00e9");
      await page.locator("#apply-string").click();
      await waitCount(1);
      const actual = await download("latin1-string.bin");
      python(pythonImports + String.raw`
reference = str(pathlib.Path(sys.argv[3]).with_suffix('.python-reference.bin'))
with contextlib.redirect_stdout(io.StringIO()): setstr(sys.argv[2], 'ui_nu', 0x22b0, 'Caf\u00e9', reference)
assert pathlib.Path(reference).read_bytes() == pathlib.Path(sys.argv[3]).read_bytes()
`, [fixture, actual]);
      await page.locator("#undo").click();
      await waitCount(0);
    });
    await check("Imported patch comments and ordered overlaps match Python exactly", async () => {
      await stock();
      const text = "# Python patch format\n0400 deadbeef # first write\n\n0402 1234\n0450 aabbcc\n";
      const input = path.join(out, "overlap-patches.txt");
      await writeFile(input, text);
      await batch("gps_nu", text, "overlap-patches.txt");
      await page.locator("#apply-patch-file").click();
      await waitCount(1);
      const actual = await download("overlap-patches.bin");
      python(pythonImports + String.raw`
reference = str(pathlib.Path(sys.argv[3]).with_suffix('.python-reference.bin'))
with contextlib.redirect_stdout(io.StringIO()): patch(sys.argv[2], 'gps_nu', sys.argv[4], reference)
assert pathlib.Path(reference).read_bytes() == pathlib.Path(sys.argv[3]).read_bytes()
`, [fixture, actual, input]);
      await page.locator("#undo").click();
      await waitCount(0);
    });
    await check("Batch drafts cannot silently change target regions", async () => {
      await stock();
      await batch("gps_nu", "0400 deadbeef\n");
      await page.locator("#raw-section").selectOption("dsp_nu");
      await page.locator("#error").waitFor({ state: "visible" });
      assert.match(await page.locator("#error").textContent(), /region|changed|draft|reopen|discard/i);
      assert.equal(await count(), 0);
      assert.equal(await page.locator("#raw-section").inputValue(), "gps_nu");
      await page.locator("#apply-patch-file").click();
      await waitCount(1);
      const actual = await download("batch-captured-region.bin");
      python(pythonImports + String.raw`
expected = pathlib.Path(sys.argv[2]).read_bytes()
s = next(s for s in parse(expected) if s['name']=='gps_nu'); off=s['offset']; size=s['length']
d = bytearray(decode_old_model(s['key'], expected[off:off+size]))
d[0x400:0x404] = bytes.fromhex('deadbeef')
expected = expected[:off] + encode_old_model(s['key'], d) + expected[off+size:]
assert expected == pathlib.Path(sys.argv[3]).read_bytes()
`, [fixture, actual]);
    });
    await check("New editors fit desktop and mobile viewports", async () => {
      await stock();
      await settings();
      for (const [label, viewport] of Object.entries({
        desktop: { width: 1440, height: 1000 }, mobile: { width: 390, height: 844 },
      })) {
        await page.setViewportSize(viewport);
        for (const name of ["settings", "text", "raw"]) {
          await tab(name);
          if (name === "text") await expandFor("#text-offset");
          if (name === "raw") await expandFor("#patch-text");
          await noOverflow();
          await page.screenshot({ path: path.join(out, `${label}-${name}.png`), fullPage: true });
        }
      }
    });
  } else console.log("SKIP R7_FIXTURE is not set; private firmware parity checks were not run.");

  await check("All file handling stays local without uncaught browser errors", async () => {
    assert.deepEqual(network, []);
    assert.deepEqual(errors, []);
  });
  console.log(`${passed} browser parity checks passed. Artifacts: ${path.relative(root, out)}`);
} finally {
  await browser.close();
}
