#!/usr/bin/env node
/**
 * Browser-level workbench checks. Run a static server for web/ first.
 *
 * WEB_URL=http://127.0.0.1:4173 R7_FIXTURE=/path/to/stock.bin node tests/web_browser.mjs
 *
 * Install Playwright locally or set PLAYWRIGHT_MODULE to its index.mjs. An
 * existing Chromium can be selected with PLAYWRIGHT_CHROMIUM_EXECUTABLE.
 * R7_FIXTURE is optional; firmware fixtures are never included in the project.
 * Downloads and screenshots stay in the ignored decoded/web-qa directory.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = path.join(root, 'decoded', 'web-qa');
const target = process.env.WEB_URL || 'http://127.0.0.1:4173';
const fixture = process.env.R7_FIXTURE && path.resolve(process.env.R7_FIXTURE);
const checks = [];
const browserErrors = [];
const blockedRequests = [];

async function playwright() {
  if (process.env.PLAYWRIGHT_MODULE) {
    return import(pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href);
  }
  for (const name of ['playwright', 'playwright-core']) {
    try { return await import(name); } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Install Playwright or set PLAYWRIGHT_MODULE to its index.mjs.');
}

async function check(name, run) {
  await run();
  checks.push(name);
  console.log(`PASS ${name}`);
}

async function assertDisabled(page, selector, expected = true) {
  assert.equal(await page.locator(selector).isDisabled(), expected, selector);
}

async function assertNoOverflow(page) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
    `Horizontal overflow at ${page.viewportSize().width}px`);
}

async function download(page, selector, filename) {
  const waiting = page.waitForEvent('download');
  await page.locator(selector).click();
  const result = await waiting;
  const destination = path.join(artifacts, filename);
  await result.saveAs(destination);
  assert.equal(await result.failure(), null);
  return destination;
}

function verifyWithPython(original, modified, withLogo) {
  // Use the existing CLI codec as an independent reference implementation.
  // The expected full file is assembled from the original, so every untouched
  // byte, trailer, section and the unaligned logo boundary is covered.
  const program = String.raw`
import pathlib, sys
sys.path.insert(0, str(pathlib.Path(sys.argv[1]) / 'tools'))
from r7_unpack import parse, decode_old_model, encode_old_model
original = pathlib.Path(sys.argv[2]).read_bytes()
modified = pathlib.Path(sys.argv[3]).read_bytes()
section = next(f for f in parse(original) if f['name'] == 'ui_nu')
start, length, key = section['offset'], section['length'], section['key']
ui = bytearray(decode_old_model(key, original[start:start+length]))
for offset, size, text in [(0x2268, 12, b'ROAD TEST'), (0xa458, 20, b'Field unit 7'), (0xa478, 20, b'LOCAL EDIT')]:
    ui[offset:offset+size] = text + bytes(size-len(text))
if sys.argv[4] == 'logo':
    ui[0x2d526:0x2d526+2640] = bytes([0x1b])*2640
expected = original[:start] + encode_old_model(key, ui) + original[start+length:]
assert len(modified) == len(original), 'File length changed'
assert modified == expected, 'Downloaded firmware differs from Python reference'
print('Full downloaded file matches independent Python reconstruction')
`;
  const result = spawnSync(process.env.PYTHON || 'python3', ['-c', program, root, original, modified,
    withLogo ? 'logo' : 'text'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);
}

await mkdir(artifacts, { recursive: true });
const { chromium } = await playwright();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      if (url.origin !== new URL(target).origin || !['GET', 'HEAD'].includes(request.method())) {
        blockedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }
    }
    return route.continue();
  });
  await page.goto(target, { waitUntil: 'networkidle' });
  await check('Empty workbench is usable at desktop and mobile widths', async () => {
    assert.equal(await page.locator('#choose-file').isVisible(), true);
    await assertNoOverflow(page);
    await page.screenshot({ path: path.join(artifacts, 'desktop-empty.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await assertNoOverflow(page);
    await page.screenshot({ path: path.join(artifacts, 'mobile-empty.png') });
    await page.setViewportSize({ width: 1440, height: 1050 });
  });
  await check('Malformed input exposes an error and cannot prepare a firmware download', async () => {
    await page.locator('#firmware-file').setInputFiles({ name: 'truncated.bin', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3]) });
    await page.locator('#error').waitFor({ state: 'visible' });
    assert.match(await page.locator('#error').innerText(), /.+/);
    await assertDisabled(page, '#prepare-download');
  });

  if (fixture) {
    assert.equal(existsSync(fixture), true, `Fixture not found: ${fixture}`);
    await check('Verified R7 image loads with its real menu strings', async () => {
      await page.locator('#firmware-file').setInputFiles(fixture);
      await page.waitForFunction(() => document.querySelector('#selfTest')?.value === 'Self Test');
      assert.equal(await page.locator('#owner1').inputValue(), 'Alert Display #1');
      assert.equal(await page.locator('#owner2').inputValue(), 'Alert Display #2');
      await assertDisabled(page, '#prepare-download');
    });
    await check('Unsupported text is identified and cannot be exported', async () => {
      await page.locator('#selfTest').fill('MÖDE');
      assert.equal(await page.locator('#selfTest').getAttribute('aria-invalid'), 'true');
      assert.match(await page.locator('#selfTest-error').innerText(), /ASCII/i);
      assert.match(await page.locator('#status').innerText(), /unsupported|ASCII/i);
      await assertDisabled(page, '#prepare-download');
      await page.locator('#selfTest').fill('ROAD TEST');
      await page.locator('#owner1').fill('Field unit 7');
      await page.locator('#owner2').fill('LOCAL EDIT');
      await assertDisabled(page, '#prepare-download', false);
    });
    let textExport;
    await check('Text export is byte-identical to independent Python reconstruction', async () => {
      await page.locator('#prepare-download').click();
      await page.locator('#download-firmware').waitFor({ state: 'visible' });
      textExport = await download(page, '#download-firmware', 'text-edit.bin');
      verifyWithPython(fixture, textExport, false);
      const manifestPath = await download(page, '#download-manifest', 'text-change-manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      assert.equal(typeof manifest, 'object');
      assert.ok(JSON.stringify(manifest).includes('ROAD TEST'), 'Manifest omits requested text change');
    });
    await check('A corrupt image reports the failure and invalidates previous downloads', async () => {
      await page.locator('#logo-file').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('This is not an image.') });
      await page.locator('#error').waitFor({ state: 'visible' });
      assert.match(await page.locator('#error').innerText(), /image|decode|PNG/i);
      assert.equal(await page.locator('#download-firmware').isVisible(), false);
      assert.equal(await page.locator('#selfTest').inputValue(), 'ROAD TEST');
    });
    await check('Known grayscale image produces the exact expected 2-bit bitmap', async () => {
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = 176;
        canvas.height = 60;
        const ctx = canvas.getContext('2d');
        const data = ctx.createImageData(176, 60);
        for (let y = 0; y < 60; y++) for (let x = 0; x < 176; x++) {
          const i = (y * 176 + x) * 4;
          data.data.set([[0, 90, 180, 255][x % 4], [0, 90, 180, 255][x % 4],
            [0, 90, 180, 255][x % 4], 255], i);
        }
        ctx.putImageData(data, 0, 0);
        return canvas.toDataURL('image/png').split(',')[1];
      });
      await page.locator('#logo-file').setInputFiles({ name: 'four-shades.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
      await page.waitForFunction(() => !document.querySelector('#reset-logo')?.disabled);
      await page.locator('#prepare-download').click();
      await page.locator('#download-firmware').waitFor({ state: 'visible' });
      const output = await download(page, '#download-firmware', 'text-logo-edit.bin');
      verifyWithPython(fixture, output, true);
      await page.screenshot({ path: path.join(artifacts, 'desktop-edited.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await assertNoOverflow(page);
      // Capture explicit viewports: some Chromium builds repeat the initial
      // viewport when stitching a full-page screenshot after a resize.
      for (const [name, selector] of [['fields', '#text-editor'], ['preview', '.preview-column'], ['review', '#review']]) {
        await page.locator(selector).scrollIntoViewIfNeeded();
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await page.screenshot({ path: path.join(artifacts, `mobile-${name}-viewport.png`) });
      }
      await page.setViewportSize({ width: 1440, height: 1050 });
    });
    await check('Reset restores all initial values and removes stale downloads', async () => {
      await page.locator('#reset-all').click();
      assert.equal(await page.locator('#selfTest').inputValue(), 'Self Test');
      assert.equal(await page.locator('#owner1').inputValue(), 'Alert Display #1');
      assert.equal(await page.locator('#owner2').inputValue(), 'Alert Display #2');
      await assertDisabled(page, '#prepare-download');
      assert.equal(await page.locator('#download-firmware').isVisible(), false);
    });
    await check('Exported firmware can be reopened and edited again', async () => {
      await page.locator('#firmware-file').setInputFiles(textExport);
      await page.waitForFunction(() => document.querySelector('#selfTest')?.value === 'ROAD TEST');
      await assertDisabled(page, '#selfTest', false);
      await assertDisabled(page, '#prepare-download');
    });
    await check('Changing an immutable code byte makes the image inspect-only', async () => {
      const bytes = Buffer.from(await readFile(fixture));
      // Stock R7 ui_nu begins at byte 24. This is outside all editable fields.
      bytes[24 + 0x100] ^= 1;
      await page.locator('#firmware-file').setInputFiles({ name: 'unsupported.bin', mimeType: 'application/octet-stream', buffer: bytes });
      await page.waitForFunction(() => /Inspection only/i.test(document.querySelector('#compatibility')?.textContent || ''));
      assert.match(await page.locator('#compatibility').innerText(), /outside the editable ranges/i);
      await assertDisabled(page, '#selfTest');
      await assertDisabled(page, '#prepare-download');
    });
  } else {
    console.log('SKIP Proprietary R7 fixture not supplied; set R7_FIXTURE for byte-level browser export checks.');
  }
  await check('File handling makes no upload/external requests and causes no uncaught browser errors', async () => {
    assert.deepEqual(blockedRequests, []);
    assert.deepEqual(browserErrors, []);
  });
  console.log(`${checks.length} browser checks passed. Artifacts: ${path.relative(root, artifacts)}`);
} finally {
  await browser.close();
}
