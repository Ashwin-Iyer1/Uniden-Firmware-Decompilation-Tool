#!/usr/bin/env node
/** Browser integration QA. Serve web/ on localhost4173 or set WEB_URL.
 * PLAYWRIGHT_MODULE may point to an externally installed playwright/index.mjs.
 * R7_FIXTURE optionally supplies a private stock R7 file. Never commit fixtures.
 * All generated files stay under ignored decoded/web-qa/.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "decoded/web-qa");
const url = process.env.WEB_URL || "http://127.0.0.1:4173";
const fixture = process.env.R7_FIXTURE && path.resolve(process.env.R7_FIXTURE);
let passed = 0;
const errors = [],
  network = [];
async function loadPlaywright() {
  if (process.env.PLAYWRIGHT_MODULE)
    return import(
      pathToFileURL(path.resolve(process.env.PLAYWRIGHT_MODULE)).href
    );
  for (const name of ["playwright", "playwright-core"]) {
    try {
      return await import(name);
    } catch (e) {
      if (e.code !== "ERR_MODULE_NOT_FOUND") throw e;
    }
  }
  throw new Error("Install Playwright externally and set PLAYWRIGHT_MODULE.");
}
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}
function python(program, args = [], binary = false) {
  const result = spawnSync(
    process.env.PYTHON || "python3",
    ["-c", program, root, ...args],
    { encoding: binary ? null : "utf8", maxBuffer: 40 * 1024 * 1024 },
  );
  assert.equal(
    result.status,
    0,
    result.stderr?.toString() ||
      result.error?.message ||
      "Python reference failed",
  );
  return result.stdout;
}
function verifyDownload(file, stage) {
  python(
    String.raw`
import sys, pathlib, struct, io, contextlib
sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'tools'))
from r7_unpack import parse,decode_old_model,encode_old_model
from r7_patch import field_size
from r7_lzss import decompress,compress
from r7_gpsdb import read_firmware_points,write_firmware
original=pathlib.Path(sys.argv[2]).read_bytes(); actual=pathlib.Path(sys.argv[3]).read_bytes(); stage=int(sys.argv[4])
sections={s['name']:s for s in parse(original)}
expected=bytearray(original)
for name in ['dsp_nu','ui_nu','gps_nu']:
 s=sections[name]; off=s['offset']; size=s['length']; key=s['key']; dec=bytearray(decode_old_model(key,original[off:off+size]))
 if name=='dsp_nu': struct.pack_into('<I',dec,0xdd34+4,10500123)
 if name=='ui_nu' and stage>=2:
  for offset,text in [(0x2268,b'ROAD TEST'),(0x22b0,b'ROADWAY')]:
   length,_=field_size(dec,offset); dec[offset:offset+length]=text+bytes(length-len(text))
 if name=='ui_nu' and stage>=3: dec[0x2d526:0x2d526+2640]=bytes([0x1b])*2640
 if name=='ui_nu' and stage>=4:
  data=bytearray(decompress(dec,0x2f7ac,0x514)); data[0x298]=4 if data[0x298]!=4 else 0
  packed=compress(data); assert len(packed)<=0x254
  dec[0x2f7ac:0x2fa00]=packed+bytes([255])*(0x254-len(packed))
 if name=='gps_nu' and stage>=6: struct.pack_into('<I',dec,0x400,0xdeadbeef)
 expected[off:off+size]=encode_old_model(key,dec)
if stage>=5:
 points=read_firmware_points(expected)
 points.append((42.123456789,-71.987654321,1,45,2,2,360))
 output=pathlib.Path(sys.argv[3]).with_suffix('.python-reference.bin')
 with contextlib.redirect_stdout(io.StringIO()): write_firmware(expected,points,str(output),20261015)
 expected=output.read_bytes()
assert actual==expected, 'Complete browser download differs from independent Python reconstruction at stage '+str(stage)
`,
    [fixture, file, String(stage)],
  );
}
await mkdir(out, { recursive: true });
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", (route) => {
    const req = route.request(),
      target = new URL(req.url());
    if (
      ["http:", "https:"].includes(target.protocol) &&
      (target.origin !== new URL(url).origin ||
        !["GET", "HEAD"].includes(req.method()))
    ) {
      network.push(`${req.method()} ${target.origin}${target.pathname}`);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(url, { waitUntil: "networkidle" });
  const tab = async (name) => {
    await page.locator(`#tab-${name}`).click();
    await page.locator(`#panel-${name}`).waitFor({ state: "visible" });
  };
  const count = async () =>
    Number(await page.locator("#operation-count").textContent());
  const waitCount = async (n) =>
    page.waitForFunction(
      (n) =>
        Number(document.querySelector("#operation-count").textContent) === n,
      n,
    );
  const noOverflow = async () =>
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "Page overflows horizontally",
    );
  const download = async (selector, name) => {
    const wait = page.waitForEvent("download");
    await page.locator(selector).click();
    const value = await wait;
    const dest = path.join(out, name);
    await value.saveAs(dest);
    assert.equal(await value.failure(), null);
    return dest;
  };
  const exportFile = async (name) => {
    await tab("review");
    await page.locator("#prepare-download").click();
    await page.locator("#download-firmware").waitFor({ state: "visible" });
    return download("#download-firmware", name);
  };
  const open = async (input) => {
    await page.locator("#firmware-file").setInputFiles(input);
    await page.locator("#editor-shell").waitFor({ state: "visible" });
    await page.waitForFunction(
      (name) => document.querySelector("#file-name").textContent === name,
      typeof input === "string" ? path.basename(input) : input.name,
    );
  };
  await check(
    "Empty desktop/mobile layout and keyboard-visible entry point",
    async () => {
      assert.equal(await page.locator("#choose-file").isVisible(), true);
      await noOverflow();
      await page.screenshot({
        path: path.join(out, "full-desktop-empty.png"),
        fullPage: true,
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await noOverflow();
      await page.screenshot({ path: path.join(out, "full-mobile-empty.png") });
      await page.setViewportSize({ width: 1440, height: 1000 });
    },
  );
  await check(
    "Practice file uses real edits, byte review, navigation, export, and undo",
    async () => {
      await page.locator("#open-practice").click();
      await page.locator("#practice-guide").waitFor({ state: "visible" });
      assert.match(await page.locator("#compatibility").textContent(), /device-format validation is not applicable/);
      assert.equal(await page.locator("#compatibility").evaluate((element) => element.classList.contains("unsupported")), false);
      assert.equal(await page.locator("#panel-raw").isVisible(), true);
      await page.locator("#practice-edit").click();
      await waitCount(1);
      assert.match(await page.locator("#review-integrity").textContent(), /Practice sample: raw-byte review only/);
      assert.equal(await page.locator("#review-integrity").evaluate((element) => element.classList.contains("unsupported")), false);
      assert.equal(await page.locator("#diff-bytes").textContent(), "5");
      assert.equal(await page.locator("#diff-ranges").textContent(), "1");
      assert.match(await page.locator("#diff-list").textContent(), /0x40–0x44/);
      await page.setViewportSize({ width: 390, height: 844 });
      await noOverflow();
      await page.screenshot({ path: path.join(out, "comparison-mobile.png"), fullPage: true });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.screenshot({ path: path.join(out, "comparison-desktop.png"), fullPage: true });
      await page.getByRole("button", { name: "Inspect current bytes at 0x40", exact: true }).click();
      assert.equal(await page.locator("#raw-view-offset").inputValue(), "0x40");
      const bytes = await readFile(await exportFile("practice-edited.bin"));
      assert.equal(bytes.subarray(0x40, 0x4b).toString(), "LOCAL WORLD");
      assert.equal(await page.locator("#download-firmware").textContent(), "Download practice bytes");
      await page.locator("#undo").click();
      await waitCount(0);
      assert.equal(await page.locator("#diff-bytes").textContent(), "0");
      assert.equal(await page.locator("#practice-edit").isEnabled(), true);
    },
  );
  await check(
    "Unrecognized binary supports exact raw patching and undo",
    async () => {
      await open({
        name: "unknown.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from([1, 2, 3, 4]),
      });
      await tab("raw");
      assert.equal(await page.locator("#practice-guide").isVisible(), false);
      assert.equal(await page.locator("#compatibility").evaluate((element) => element.classList.contains("unsupported")), true);
      await page.locator("#raw-patch-offset").fill("0x1");
      await page.locator("#raw-value").fill("AA");
      await page.locator("#apply-raw").click();
      await waitCount(1);
      const file = await exportFile("unknown-patched.bin");
      assert.deepEqual(await readFile(file), Buffer.from([1, 170, 3, 4]));
      await page.locator("#undo").click();
      await waitCount(0);
      assert.equal(await page.locator("#prepare-download").isDisabled(), true);
    },
  );
  await check(
    "ASCII patches retain meaningful leading and trailing whitespace",
    async () => {
      await tab("raw");
      await page.locator("#raw-type").selectOption("ascii");
      await page.locator("#raw-patch-offset").fill("0x0");
      await page.locator("#raw-value").fill(" A ");
      await page.locator("#apply-raw").click();
      await waitCount(1);
      assert.deepEqual(
        await readFile(await exportFile("ascii-spaces.bin")),
        Buffer.from([32, 65, 32, 4]),
      );
      await page.locator("#undo").click();
      await waitCount(0);
      await tab("raw");
      await page.locator("#raw-type").selectOption("hex");
    },
  );
  await check("Whole-file insertion and deletion are reversible", async () => {
    await tab("raw");
    await page.locator("#splice-form").locator("..").locator("summary").click();
    await page.locator("#splice-offset").fill("0x2");
    await page.locator("#splice-delete").fill("1");
    await page.locator("#splice-bytes").fill("BB CC");
    await page.locator("#apply-splice").click();
    await waitCount(1);
    const file = await exportFile("unknown-spliced.bin");
    assert.deepEqual(await readFile(file), Buffer.from([1, 2, 187, 204, 4]));
    await page.locator("#reset-all").click();
    await waitCount(0);
  });
  if (fixture) {
    await check(
      "Stock R7 unlocks all named editors and retains exact band precision",
      async () => {
        await open(fixture);
        await tab("bands");
        await page.locator("#band-low-0").waitFor();
        assert.equal(
          await page.locator("#band-low-0").inputValue(),
          "10499.250",
        );
        assert.equal(await page.locator("#bands-body tr").count(), 33);
        assert.equal(await count(), 0);
      },
    );
    await check(
      "Invalid band bounds reject atomically; valid bounds match Python byte-for-byte",
      async () => {
        await page.locator("#band-low-0").fill("10500.123");
        await page.locator("#band-high-0").fill("10000");
        await page.locator("#apply-bands").click();
        await page.locator("#error").waitFor({ state: "visible" });
        assert.equal(await count(), 0);
        await page.locator("#band-high-0").fill("10551.250");
        await page.locator("#apply-bands").click();
        await waitCount(1);
        verifyDownload(await exportFile("full-bands.bin"), 1);
      },
    );
    await check(
      "Common and searched text edits preserve their exact slots",
      async () => {
        await tab("text");
        await page.locator("#selfTest").fill("ROAD TEST");
        await page.locator("#apply-text").click();
        await waitCount(2);
        await page.locator("#text-search").fill("Highway");
        const row = page
          .locator("#strings-body tr")
          .filter({ hasText: "Highway" })
          .first();
        await row.locator("button").click();
        await page.locator("#string-value").fill("ROADWAY");
        await page.locator("#apply-string").click();
        await waitCount(3);
        verifyDownload(await exportFile("full-text.bin"), 2);
      },
    );
    await check(
      "Bitmap import and Apply produce exact packed 2-bit pixels",
      async () => {
        await tab("graphics");
        const png = await page.evaluate(() => {
          const c = document.createElement("canvas");
          c.width = 176;
          c.height = 60;
          const x = c.getContext("2d"),
            d = x.createImageData(176, 60);
          for (let i = 0; i < 176 * 60; i++) {
            const q = [0, 90, 180, 255][i % 4];
            d.data.set([q, q, q, 255], i * 4);
          }
          x.putImageData(d, 0, 0);
          return c.toDataURL("image/png").split(",")[1];
        });
        await page.locator("#logo-file").setInputFiles({
          name: "four-shades.png",
          mimeType: "image/png",
          buffer: Buffer.from(png, "base64"),
        });
        await page.waitForFunction(
          () => !document.querySelector("#apply-graphics").disabled,
        );
        assert.equal(await count(), 3);
        await page.locator("#apply-graphics").click();
        await waitCount(4);
        verifyDownload(await exportFile("full-bitmap.bin"), 3);
      },
    );
    await check(
      "Scan motion recompiles startup data exactly like the Python compressor",
      async () => {
        await tab("scan");
        const cell = page.locator("#scan-0-0");
        const original = Number(await cell.inputValue());
        await cell.fill(original === 4 ? "0" : "4");
        await page.locator("#apply-scan").click();
        await waitCount(5);
        verifyDownload(await exportFile("full-scan.bin"), 4);
      },
    );
    await check(
      "GPS record addition preserves all existing records and matches Python rebuild",
      async () => {
        await tab("gps");
        await page.locator("#gps-add").click();
        for (const [id, value] of Object.entries({
          "gps-lat": "42.123456789",
          "gps-lon": "-71.987654321",
          "gps-type": "1",
          "gps-speed": "45",
          "gps-heading": "360",
          "gps-f2": "2",
          "gps-category": "2",
          "gps-reserved": "65535",
        }))
          await page.locator("#" + id).fill(value);
        await page.locator("#gps-save").click();
        await page.locator("#gps-date").fill("2026-10-15");
        await page.locator("#apply-gps").click();
        await waitCount(6);
        verifyDownload(await exportFile("full-gps.bin"), 5);
      },
    );
    let codeFile;
    await check(
      "Typed code-section patch is exact and leaves other decoded bytes intact",
      async () => {
        await tab("raw");
        await page.locator("#raw-section").selectOption("gps_nu");
        await page.locator("#raw-decoded").check();
        await page.locator("#raw-patch-offset").fill("0x400");
        await page.locator("#raw-type").selectOption("u32");
        await page.locator("#raw-value").fill("3735928559");
        await page.locator("#raw-label").fill("QA instruction word");
        await page.locator("#apply-raw").click();
        await waitCount(7);
        codeFile = await exportFile("full-code.bin");
        verifyDownload(codeFile, 6);
        const report = JSON.parse(
          await readFile(
            await download("#download-manifest", "full-manifest.json"),
            "utf8",
          ),
        );
        assert.equal(report.operationCount, 7);
        assert.equal(report.containerValid, true);
        assert.notEqual(report.inputSha256, report.outputSha256);
      },
    );
    await check(
      "Decoded section replacement enforces size and exports exact re-encoded bytes",
      async () => {
        await tab("raw");
        await page.locator("#raw-section").selectOption("gps_nu");
        await page.locator("#raw-decoded").check();
        await page
          .locator("#raw-export")
          .locator("xpath=ancestor::details")
          .locator("summary")
          .click();
        const region = await readFile(
          await download("#raw-export", "gps-region.bin"),
        );
        assert.equal(region.length, 40960);
        region[0x450] ^= 0xff;
        await page.locator("#raw-file").setInputFiles({
          name: "short.bin",
          mimeType: "application/octet-stream",
          buffer: region.subarray(0, 4),
        });
        await page.locator("#error").waitFor({ state: "visible" });
        assert.equal(await count(), 7);
        await page.locator("#raw-file").setInputFiles({
          name: "replacement.bin",
          mimeType: "application/octet-stream",
          buffer: region,
        });
        await waitCount(8);
        const file = await exportFile("full-replacement.bin");
        python(
          String.raw`
import pathlib,sys
sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'tools'))
from r7_unpack import parse,decode_old_model,encode_old_model
before=bytearray(pathlib.Path(sys.argv[2]).read_bytes());s=next(s for s in parse(before) if s['name']=='gps_nu')
o=s['offset'];d=bytearray(decode_old_model(s['key'],before[o:o+s['length']]));d[0x450]^=255;before[o:o+s['length']]=encode_old_model(s['key'],d)
assert before==pathlib.Path(sys.argv[3]).read_bytes()
`,
          [codeFile, file],
        );
        await page.locator("#undo").click();
        await waitCount(7);
      },
    );
    await check(
      "Sound directory exposes all clip spans and exports their exact bytes",
      async () => {
        await tab("raw");
        await page.locator("#sound-directory summary").click();
        assert.equal(await page.locator("#sound-clip option").count(), 250);
        await page.locator("#sound-clip").selectOption({ index: 0 });
        await page.locator("#sound-jump").click();
        assert.equal(
          await page.locator("#raw-section").inputValue(),
          "sound_dbnu",
        );
        const file = await download("#sound-export", "sound-clip.bin"),
          offset = await page.locator("#raw-patch-offset").inputValue();
        python(
          String.raw`
import pathlib,sys
sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'tools'))
from r7_unpack import parse,decode_old_model
b=pathlib.Path(sys.argv[2]).read_bytes();s=next(s for s in parse(b) if s['name']=='sound_dbnu');d=decode_old_model(225,b[s['offset']:s['offset']+s['length']]);clip=pathlib.Path(sys.argv[3]).read_bytes();o=int(sys.argv[4],16)
assert len(clip)>0 and clip==d[o:o+len(clip)]
`,
          [codeFile, file, offset],
        );
        assert.equal(await count(), 7);
      },
    );
    await check(
      "Corrupting container framing is visible and reversible",
      async () => {
        await tab("raw");
        await page.locator("#raw-section").selectOption("file");
        await page.locator("#raw-type").selectOption("hex");
        await page.locator("#raw-patch-offset").fill("0x0");
        await page.locator("#raw-value").fill("FF FF FF FF");
        await page.locator("#apply-raw").click();
        await waitCount(8);
        await tab("review");
        assert.match(
          await page.locator("#review-integrity").innerText(),
          /invalid|raw|unrecognized|not valid|cannot/i,
        );
        await page.locator("#undo").click();
        await waitCount(7);
        verifyDownload(await exportFile("full-undone.bin"), 6);
      },
    );
    await check(
      "CSV replacement resizes GPS framing and preserves every later section",
      async () => {
        await tab("gps");
        await page.locator("#gps-csv-file").setInputFiles({
          name: "two-points.csv",
          mimeType: "text/csv",
          buffer: Buffer.from(
            "lat,lon,type,speed,heading,f2,category\n42.25,-71.25,speed,45,360,2,2\n41.25,-70.25,redlight,0,180,1,1\n",
          ),
        });
        await page.waitForFunction(
          () => !document.querySelector("#apply-gps").disabled,
        );
        await page.locator("#gps-date").fill("2026-10-15");
        await page.locator("#apply-gps").click();
        await waitCount(8);
        const resized = await exportFile("full-gps-resized.bin");
        python(
          String.raw`
import pathlib,sys,struct
sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'tools'))
from r7_unpack import parse,decode_old_model
before=pathlib.Path(sys.argv[2]).read_bytes();after=pathlib.Path(sys.argv[3]).read_bytes()
a=next(s for s in parse(before) if s['name'].startswith('GPSD'));b=next(s for s in parse(after) if s['name'].startswith('GPSD'))
assert b['length']==512
assert before[:a['offset']-4]==after[:b['offset']-4]
assert before[a['offset']+a['length']+19:]==after[b['offset']+b['length']+19:]
dec=decode_old_model(210,after[b['offset']:b['offset']+b['length']]);assert struct.unpack_from('<ff',dec)==(42.25,-71.25)
assert struct.unpack('<I',decode_old_model(210,after[b['offset']+b['length']:b['offset']+b['length']+4]))[0]==2
`,
          [codeFile, resized],
        );
        await page.locator("#undo").click();
        await waitCount(7);
      },
    );
    await check(
      "Exported custom code can regain named controls with an original reference",
      async () => {
        await open(codeFile);
        await tab("overview");
        assert.match(
          await page.locator("#profile-state").textContent(),
          /raw|reference|unverified|unrecognized|not|unknown/i,
        );
        await page.locator("#reference-file").setInputFiles(fixture);
        await page.waitForFunction(() =>
          /reference|verified/i.test(
            document.querySelector("#reference-status").textContent,
          ),
        );
        await tab("bands");
        assert.equal(
          await page.locator("#band-low-0").inputValue(),
          "10500.123",
        );
        assert.equal(await count(), 0);
      },
    );
    await check(
      "A delayed CSV import cannot replace records beneath an open edit form",
      async () => {
        await tab("gps");
        const originalCount = await page.locator("#gps-count").textContent();
        await page.evaluate(() => {
          const original = File.prototype.text;
          window.__csvFinished = false;
          File.prototype.text = async function () {
            if (this.name === "delayed.csv")
              await new Promise((resolve) => (window.__releaseCsv = resolve));
            const text = await original.call(this);
            window.__csvFinished = true;
            File.prototype.text = original;
            return text;
          };
        });
        await page.locator("#gps-csv-file").setInputFiles({
          name: "delayed.csv",
          mimeType: "text/csv",
          buffer: Buffer.from(
            "lat,lon,type,speed,heading,f2,category\n1,2,speed,45,360,2,2\n",
          ),
        });
        await page.waitForFunction(
          () => typeof window.__releaseCsv === "function",
        );
        await page.locator("#gps-add").click();
        await page.locator("#gps-lat").fill("42.125");
        await page.evaluate(() => window.__releaseCsv());
        await page.waitForFunction(() => window.__csvFinished);
        assert.equal(await page.locator("#gps-form").isVisible(), true);
        assert.equal(await page.locator("#gps-lat").inputValue(), "42.125");
        assert.equal(
          await page.locator("#gps-count").textContent(),
          originalCount,
        );
        assert.equal(await count(), 0);
        await page.locator("#gps-cancel").click();
      },
    );
    await check(
      "Pixel painting survives tab changes and patches only the intended packed pixel",
      async () => {
        await tab("graphics");
        await page.locator("#graphics-preset").selectOption("boot");
        await page.locator("#paint-enabled").check();
        await page.locator("#paint-color").fill("#ffffff");
        await page.locator("#bitmap-preview").scrollIntoViewIfNeeded();
        const box = await page.locator("#bitmap-preview").boundingBox();
        await page.mouse.click(
          box.x + box.width / 352,
          box.y + box.height / 120,
        );
        await tab("overview");
        await tab("graphics");
        assert.equal(await page.locator("#apply-graphics").isDisabled(), false);
        assert.equal(await count(), 0);
        await page.locator("#apply-graphics").click();
        await waitCount(1);
        const file = await exportFile("full-painted.bin");
        python(
          String.raw`
import pathlib,sys
sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'tools'))
from r7_unpack import parse,decode_old_model,encode_old_model
b=bytearray(pathlib.Path(sys.argv[2]).read_bytes());s=next(s for s in parse(b) if s['name']=='ui_nu');o=s['offset'];d=bytearray(decode_old_model(s['key'],b[o:o+s['length']]));d[0x2d526]|=0xc0;b[o:o+s['length']]=encode_old_model(s['key'],d)
assert b==pathlib.Path(sys.argv[3]).read_bytes()
`,
          [codeFile, file],
        );
        await page.locator("#undo").click();
        await waitCount(0);
      },
    );
    await check(
      "Pending edits survive another editor applying and undoing changes",
      async () => {
        await tab("bands");
        await page.locator("#band-low-0").fill("10501.123");
        await tab("text");
        await page.locator("#selfTest").fill("DRAFT TEST");
        await page.locator("#apply-text").click();
        await waitCount(1);
        await tab("bands");
        assert.equal(
          await page.locator("#band-low-0").inputValue(),
          "10501.123",
        );
        await page.locator("#undo").click();
        await waitCount(0);
        assert.equal(
          await page.locator("#band-low-0").inputValue(),
          "10501.123",
        );
        await page.locator("#apply-bands").click();
        await waitCount(1);
        await page.locator("#reset-all").click();
        await waitCount(0);
      },
    );
    await check(
      "Band drafts merge unrelated changes and reject overlapping byte conflicts",
      async () => {
        await tab("bands");
        await page.locator("#band-low-0").fill("10501.123");
        await tab("raw");
        await page.locator("#raw-section").selectOption("dsp_nu");
        await page.locator("#raw-decoded").check();
        await page.locator("#raw-type").selectOption("u32");
        await page.locator("#raw-patch-offset").fill("0xdd48");
        await page.locator("#raw-value").fill("24050000");
        await page.locator("#apply-raw").click();
        await waitCount(1);
        await tab("bands");
        await page.locator("#apply-bands").click();
        await waitCount(2);
        const file = await exportFile("full-merged-bands.bin");
        python(
          String.raw`
import pathlib,sys,struct
sys.path.insert(0,str(pathlib.Path(sys.argv[1])/'tools'))
from r7_unpack import parse,decode_old_model,encode_old_model
b=bytearray(pathlib.Path(sys.argv[2]).read_bytes());s=next(s for s in parse(b) if s['name']=='dsp_nu');o=s['offset'];d=bytearray(decode_old_model(s['key'],b[o:o+s['length']]));struct.pack_into('<I',d,0xdd38,10501123);struct.pack_into('<I',d,0xdd48,24050000);b[o:o+s['length']]=encode_old_model(s['key'],d)
assert b==pathlib.Path(sys.argv[3]).read_bytes()
`,
          [codeFile, file],
        );
        await page.locator("#reset-all").click();
        await waitCount(0);
        await tab("bands");
        await page.locator("#band-low-0").fill("10501.123");
        await tab("raw");
        await page.locator("#raw-patch-offset").fill("0xdd38");
        await page.locator("#raw-value").fill("10502000");
        await page.locator("#apply-raw").click();
        await waitCount(1);
        await tab("bands");
        await page.locator("#apply-bands").click();
        await page.locator("#error").waitFor({ state: "visible" });
        assert.equal(await count(), 1);
        assert.match(
          await page.locator("#error").textContent(),
          /changed|conflict|reload|discard/i,
        );
        await page.locator("#reset-all").click();
        await waitCount(0);
      },
    );
    await check(
      "Desktop and mobile editors remain usable without horizontal page overflow",
      async () => {
        await tab("bands");
        await noOverflow();
        await page.screenshot({
          path: path.join(out, "full-desktop-bands.png"),
          fullPage: true,
        });
        await page.setViewportSize({ width: 390, height: 844 });
        for (const name of [
          "overview",
          "bands",
          "text",
          "graphics",
          "scan",
          "gps",
          "raw",
          "review",
        ]) {
          await tab(name);
          await noOverflow();
          await page.locator(`#panel-${name}`).scrollIntoViewIfNeeded();
          await page.screenshot({
            path: path.join(out, `full-mobile-${name}.png`),
          });
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
      },
    );
  } else
    console.log(
      "SKIP Private R7 fixture not supplied; tested generic raw workflow only.",
    );
  await check(
    "All file handling stays local and causes no uncaught browser errors",
    async () => {
      assert.deepEqual(network, []);
      assert.deepEqual(errors, []);
    },
  );
  console.log(
    `${passed} browser checks passed. Artifacts: ${path.relative(root, out)}`,
  );
} finally {
  await browser.close();
}
