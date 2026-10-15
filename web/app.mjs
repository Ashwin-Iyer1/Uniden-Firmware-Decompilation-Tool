import { openWorkspace, TEXT_FIELDS } from "./firmware.mjs";
import { practiceBytes } from "./practice.mjs";
import {
  readBands,
  bandPatch,
  scanStrings,
  patchString,
  GRAPHICS_PRESETS,
  bitmapLength,
  decodeBitmap,
  encodeBitmap,
  readScanFrames,
  makeScanFramesPatch,
  decodeGpsDatabase,
  buildGpsRecord,
  parseGpsCsv,
  gpsToCsv,
  readSoundDirectory,
} from "./resources.mjs";

const $ = (id) => document.getElementById(id);
const MAX_SIZE = 32 * 1024 * 1024;
const state = {
  ws: null,
  fileName: "",
  panel: "overview",
  token: 0,
  urls: [],
  history: [],
  textPage: 0,
  strings: [],
  selectedString: null,
  bitmap: null,
  gps: null,
  gpsPage: 0,
  gpsEdit: null,
  rawOffset: 0,
  busy: false,
  rendered: {},
  drafts: new Set(),
  practice: false,
  comparisonRevision: -1,
  comparisonCursors: [0],
  comparisonPage: 0,
};
const hex = (value) => `0x${value.toString(16)}`;
const size = (value) =>
  value < 1024
    ? `${value} bytes`
    : value < 1048576
      ? `${(value / 1024).toFixed(1)} KB`
      : `${(value / 1048576).toFixed(2)} MB`;
const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
function error(message = "") {
  $("error").textContent = message;
  $("error").hidden = !message;
}
function status(message) {
  $("status").textContent = message;
}
function guard(action) {
  return async (event) => {
    event?.preventDefault();
    try {
      error();
      await action(event);
    } catch (cause) {
      error(cause.message || String(cause));
      status("The edit was not applied. Check the message above.");
    }
  };
}
function numberOffset(text) {
  const value = String(text).trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]+$/i.test(value))
    throw new Error("Enter a hexadecimal offset, such as 0x2268.");
  const n = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(n)) throw new Error("Offset is too large.");
  return n;
}
function bytesFromHex(text) {
  const value = text.trim().replace(/0x/gi, "").replace(/[\s,]/g, "");
  if (!value) return new Uint8Array();
  if (!/^(?:[0-9a-f]{2})+$/i.test(value))
    throw new Error("Hex bytes need complete pairs, such as 00 1A FF.");
  return Uint8Array.from(value.match(/../g), (part) => parseInt(part, 16));
}
function equal(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function invalidateDownloads() {
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls = [];
  $("downloads").hidden = true;
  for (const id of ["download-firmware", "download-manifest"]) {
    $(id).removeAttribute("href");
    $(id).removeAttribute("download");
  }
}
function download(bytes, name, type = "application/octet-stream") {
  const url = URL.createObjectURL(new Blob([bytes], { type }));
  const anchor = make("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function fillSelect(id, options, preferred) {
  const select = $(id),
    value = preferred ?? select.value;
  select.replaceChildren();
  for (const item of options) {
    const option = make("option", item.label ?? item.value);
    option.value = item.value;
    select.append(option);
  }
  if (options.some((item) => item.value === value)) select.value = value;
}
function sectionOptions(includeFile = false) {
  return [
    ...(includeFile
      ? [{ value: "file", label: "Whole file (encoded on-disk bytes)" }]
      : []),
    ...state.ws.sections.map((s) => ({
      value: s.name,
      label: `${s.name} — ${size(s.size)}`,
    })),
  ];
}
function ensureUnchanged(section, offset, original, label) {
  if (
    !equal(
      state.ws.getBytes(section).subarray(offset, offset + original.length),
      original,
    )
  )
    throw new Error(
      `${label} changed after this draft was opened. Discard this draft and reopen the resource before applying it.`,
    );
}
function textDraftChanged() {
  return (
    TEXT_FIELDS.some((f) => $(f.id)?.value !== state.quickTexts?.[f.id]) ||
    !!(
      state.selectedString &&
      !$("string-form").hidden &&
      $("string-value").value !== state.selectedString.text
    )
  );
}
function updateTextDraft() {
  const dirty = textDraftChanged();
  setDraft("text", dirty);
  $("apply-text").disabled = !dirty;
  $("apply-string").disabled = !dirty;
}
function known() {
  if (!state.ws?.info.profileKnown)
    throw new Error(
      "This editor needs a verified R7 profile. Use Raw / sections or load a matching original reference in Overview.",
    );
}
function setDraft(panel, dirty) {
  delete state.rendered.review;
  if (dirty) state.drafts.add(panel);
  else state.drafts.delete(panel);
  renderDraft();
}
function renderDraft() {
  $("draft-bar").hidden = !state.drafts.has(state.panel);
  $("draft-note").textContent =
    "This editor has an unapplied draft. Apply it to include it in your download.";
}
function transaction(label, action, sourcePanel = state.panel) {
  const before = state.ws.info.revision;
  action();
  if (state.ws.info.revision === before) {
    state.drafts.delete(sourcePanel);
    delete state.rendered[sourcePanel];
    if (sourcePanel === "gps") state.gps = null;
    if (sourcePanel === "graphics") state.bitmap = null;
    refresh();
    status("No bytes changed.");
    return;
  }
  state.history.push(label);
  state.drafts.delete(sourcePanel);
  for (const panel of state.drafts)
    state.rendered[panel] = state.ws.info.revision;
  if (!state.drafts.has("graphics")) state.bitmap = null;
  if (!state.drafts.has("gps")) state.gps = null;
  invalidateDownloads();
  error();
  refresh();
  status(
    `${label} applied. Undo is available.${state.drafts.size ? " Other editors still have unapplied drafts." : ""}`,
  );
}
function switchPanel(panel, focus = false) {
  state.panel = panel;
  document.querySelectorAll("[role=tab]").forEach((button) => {
    const active = button.dataset.panel === panel;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll("[role=tabpanel]").forEach((element) => {
    element.hidden = element.id !== `panel-${panel}`;
  });
  if (state.ws) {
    try {
      renderPanel();
    } catch (cause) {
      error(cause.message);
    }
  }
  renderDraft();
  if (focus) $(`tab-${panel}`).focus();
}
function refresh() {
  const { ws } = state,
    info = ws.info;
  document.body.classList.add("has-file");
  $("upload-panel").hidden = true;
  $("loaded-panel").hidden = false;
  $("editor-shell").hidden = false;
  $("review-shortcut").hidden = false;
  $("file-name").textContent = state.fileName;
  $("file-summary").textContent =
    `${size(info.fileSize)} · ${ws.sections.length} recognized sections`;
  $("compatibility").textContent = state.practice
    ? "Practice sample: raw-byte review only; device-format validation is not applicable."
    : info.profileKnown
    ? `R7 v153.150.127 layout identified. ${info.profileReason || "Mapped editors and raw editing are available."}`
    : `Raw editing is available. ${info.profileReason || info.error || "The mapped R7 profile is not identified."}`;
  $("compatibility").classList.toggle(
    "unsupported",
    !state.practice && (!info.profileKnown || !info.containerValid),
  );
  $("undo").disabled = !info.canUndo;
  $("reset-all").disabled = !info.canUndo && !info.changeCount;
  $("change-badge").textContent = String(info.changeCount);
  $("practice-guide").hidden = !state.practice;
  $("practice-edit").disabled = state.practice && info.changeCount > 0;
  $("operation-count").textContent = String(info.changeCount);
  $("prepare-download").disabled = !info.changeCount;
  document.querySelectorAll(".profile-required").forEach((element) => {
    element.hidden = info.profileKnown;
    element.textContent =
      "Mapped editors require an identified R7 v153.150.127 layout. Open a matching original reference in Overview, or use Raw / sections to edit this file directly.";
  });
  document.querySelectorAll(".named-content").forEach((element) => {
    element.hidden = !info.profileKnown;
  });
  renderPanel();
  renderDraft();
}
function renderPanel() {
  state.rendered ??= {};
  if (state.rendered[state.panel] === state.ws.info.revision) return;
  ({
    overview: renderOverview,
    bands: renderBands,
    text: renderText,
    graphics: renderGraphics,
    scan: renderScan,
    gps: renderGps,
    raw: renderRaw,
    review: renderReview,
  })[state.panel]();
  state.rendered[state.panel] = state.ws.info.revision;
}
async function loadFirmware(file, { practice = false } = {}) {
  if (!file) return;
  if (!/\.bin$/i.test(file.name))
    throw new Error("Choose a .bin firmware file.");
  if (!file.size || file.size > MAX_SIZE)
    throw new Error("Choose a nonempty firmware file no larger than 32 MB.");
  const token = ++state.token;
  status("Opening firmware and identifying its sections…");
  $("load-status").textContent = "Opening firmware…";
  const ws = await openWorkspace(new Uint8Array(await file.arrayBuffer()));
  if (token !== state.token) return;
  invalidateDownloads();
  Object.assign(state, {
    ws,
    fileName: file.name,
    history: [],
    textPage: 0,
    bitmap: null,
    gps: null,
    rawOffset: 0,
    rendered: {},
    drafts: new Set(),
    soundRevision: null,
    practice,
    comparisonRevision: -1,
  });
  $("firmware-file").value = "";
  $("reference-status").textContent = "";
  $("string-form").hidden = true;
  $("gps-form").hidden = true;
  switchPanel("overview");
  refresh();
  status("Firmware is open. Choose an editor to begin.");
  $("load-status").textContent = "Firmware opened.";
}
function renderOverview() {
  const { ws } = state;
  $("container-state").textContent = state.practice
    ? "Practice sample · not applicable"
    : ws.info.containerValid
    ? "Framing parsed"
    : "Unrecognized or invalid";
  $("profile-state").textContent = ws.info.profileKnown
    ? "R7 v153.150.127"
    : "Raw editing only";
  $("file-hash").textContent = ws.info.sha256;
  const body = $("sections-body");
  body.replaceChildren();
  for (const s of ws.sections) {
    const tr = make("tr");
    for (const value of [s.name, hex(s.offset), s.version ?? "—", size(s.size)])
      tr.append(make("td", String(value)));
    body.append(tr);
  }
  const canvas = $("logo-preview"),
    ctx = canvas.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, 176, 60);
  $("preview-empty").hidden = ws.info.profileKnown;
  if (ws.info.profileKnown) {
    const rgba = decodeBitmap(
      ws.getBytes("ui_nu").slice(0x2d526),
      176,
      60,
      "2bpp",
    );
    ctx.putImageData(new ImageData(rgba, 176, 60), 0, 0);
  }
}
function renderBands() {
  if (!state.ws.info.profileKnown) return;
  const bands = readBands(state.ws.getBytes("dsp_nu"));
  state.bands = bands;
  state.bandOriginal = state.ws.getBytes("dsp_nu");
  const body = $("bands-body");
  body.replaceChildren();
  for (const band of bands) {
    const tr = make("tr");
    tr.dataset.search =
      `${band.index} ${band.bandName} ${band.bandType} ${band.lowKhz / 1000} ${band.highKhz / 1000}`.toLowerCase();
    tr.append(
      make("td", `${band.index} · ${band.bandName}`),
      make("td", hex(band.offset)),
      make("td", String(band.bandType)),
    );
    for (const side of ["low", "high"]) {
      const td = make("td"),
        input = make("input");
      input.type = "number";
      input.step = "0.001";
      input.min = "0";
      input.value = (band[`${side}Khz`] / 1000).toFixed(3);
      input.id = `band-${side}-${band.index}`;
      input.setAttribute(
        "aria-label",
        `Band ${band.index} ${side === "low" ? "start" : "end"} MHz`,
      );
      input.addEventListener("input", () => {
        tr.classList.add("is-edited");
        updateBandDraft();
        $("band-status").textContent =
          "Unapplied band edits. Apply band changes to include them in your download.";
      });
      td.append(input);
      tr.append(td);
    }
    tr.append(make("td", String(band.ifConstant)));
    body.append(tr);
  }
  filterBands();
  $("apply-bands").disabled = true;
}
function updateBandDraft() {
  const dirty = state.bands.some(
    (b) =>
      Number($(`band-low-${b.index}`).value) !== b.lowKhz / 1000 ||
      Number($(`band-high-${b.index}`).value) !== b.highKhz / 1000,
  );
  $("apply-bands").disabled = !dirty;
  setDraft("bands", dirty);
}

function filterBands() {
  const query = $("band-search").value.trim().toLowerCase();
  $("bands-body")
    .querySelectorAll("tr")
    .forEach((tr) => {
      tr.hidden = !tr.dataset.search.includes(query);
    });
}
function applyBands() {
  known();
  const patches = [];
  for (const band of state.bands) {
    const patch = bandPatch(
      band.index,
      $(`band-low-${band.index}`).value,
      $(`band-high-${band.index}`).value,
    );
    if (
      $(`band-low-${band.index}`).value !== (band.lowKhz / 1000).toFixed(3) ||
      $(`band-high-${band.index}`).value !== (band.highKhz / 1000).toFixed(3)
    ) {
      ensureUnchanged(
        "dsp_nu",
        patch.offset,
        state.bandOriginal.slice(patch.offset, patch.offset + 8),
        `Band ${band.index}`,
      );
      patches.push(patch);
    }
  }
  transaction(`Band boundaries (${patches.length} records)`, () =>
    state.ws.applyPatches(
      patches,
      `Band boundaries (${patches.length} records)`,
    ),
  );
  $("band-status").textContent = "Offsets refer to the decoded DSP section.";
}
function renderText() {
  if (!state.ws.info.profileKnown) return;
  const ui = state.ws.getBytes("ui_nu"),
    quick = $("quick-fields");
  quick.replaceChildren();
  state.quickTexts = {};
  state.quickOriginal = ui;
  state.selectedString = null;
  $("string-form").hidden = true;
  for (const field of TEXT_FIELDS) {
    const label = make("label", field.label),
      input = make("input");
    input.id = field.id;
    input.maxLength = field.maxLength;
    input.value = String.fromCharCode(
      ...ui.subarray(field.offset, field.offset + field.size),
    ).split("\0")[0];
    state.quickTexts[field.id] = input.value;
    input.addEventListener("input", updateTextDraft);
    input.autocomplete = "off";
    input.spellcheck = false;
    const help = make(
      "span",
      `${hex(field.offset)} · up to ${field.maxLength} characters`,
      "field-help",
    );
    label.append(input, help);
    quick.append(label);
  }
  fillSelect(
    "text-section",
    sectionOptions().filter((option) =>
      ["ui_nu", "dsp_nu", "gps_nu"].includes(option.value),
    ),
  );
  state.strings = scanStrings(state.ws.getBytes($("text-section").value));
  renderStringRows();
  $("apply-text").disabled = true;
}
function filteredStrings() {
  const query = $("text-search").value.trim().toLowerCase();
  return state.strings.filter((item) =>
    `${hex(item.offset)} ${item.text}`.toLowerCase().includes(query),
  );
}
function renderStringRows() {
  const rows = filteredStrings(),
    pages = Math.max(1, Math.ceil(rows.length / 50));
  state.textPage = Math.min(state.textPage, pages - 1);
  const body = $("strings-body");
  body.replaceChildren();
  for (const item of rows.slice(
    state.textPage * 50,
    state.textPage * 50 + 50,
  )) {
    const tr = make("tr");
    tr.append(
      make("td", hex(item.offset)),
      make("td", String(item.size)),
      make("td", item.text),
    );
    const td = make("td"),
      button = make("button", "Edit", "text-button");
    button.type = "button";
    button.addEventListener("click", () => {
      if (
        state.selectedString &&
        !$("string-form").hidden &&
        $("string-value").value !== state.selectedString.text
      ) {
        error(
          "Apply or discard the selected string draft before choosing another string.",
        );
        return;
      }
      state.selectedString = {
        ...item,
        section: $("text-section").value,
        original: state.ws
          .getBytes($("text-section").value)
          .slice(item.offset, item.offset + item.size),
      };
      $("string-location").textContent =
        `${state.selectedString.section} ${hex(item.offset)} · ${item.maxLength} character capacity`;
      $("string-value").value = item.text;
      $("string-value").maxLength = item.maxLength;
      $("string-form").hidden = false;
      updateTextDraft();
      $("string-value").focus();
    });
    td.append(button);
    tr.append(td);
    body.append(tr);
  }
  $("text-count").textContent =
    `${rows.length.toLocaleString()} candidates. Storage capacity includes following zero padding; review code references before expanding a candidate.`;
  $("text-page").textContent = `Page ${state.textPage + 1} of ${pages}`;
  $("text-prev").disabled = !state.textPage;
  $("text-next").disabled = state.textPage + 1 >= pages;
}
function applyQuickText() {
  known();
  const ui = state.ws.getBytes("ui_nu"),
    patches = [];
  for (const field of TEXT_FIELDS.filter(
    (field) => $(field.id).value !== state.quickTexts[field.id],
  )) {
    ensureUnchanged(
      "ui_nu",
      field.offset,
      state.quickOriginal.slice(field.offset, field.offset + field.size),
      field.label,
    );
    patches.push({
      section: "ui_nu",
      offset: field.offset,
      bytes: patchString(ui, field.offset, field.size, $(field.id).value),
      decoded: true,
    });
  }
  const item = state.selectedString;
  if (
    item &&
    !$("string-form").hidden &&
    $("string-value").value !== item.text
  ) {
    ensureUnchanged(
      item.section,
      item.offset,
      item.original,
      "Selected string",
    );
    if (
      patches.some(
        (p) =>
          p.section === item.section &&
          p.offset < item.offset + item.size &&
          item.offset < p.offset + p.bytes.length,
      )
    )
      throw new Error(
        "The selected string overlaps a changed display label. Edit that text in one place before applying.",
      );
    patches.push({
      section: item.section,
      offset: item.offset,
      bytes: patchString(
        state.ws.getBytes(item.section),
        item.offset,
        item.size,
        $("string-value").value,
      ),
      decoded: true,
    });
  }
  transaction("Text resources", () =>
    state.ws.applyPatches(patches, "Text resources"),
  );
}
function renderGraphics() {
  if (!state.ws.info.profileKnown) return;
  if (!$("graphics-preset").options.length) {
    let group = null,
      optgroup = null;
    for (const preset of GRAPHICS_PRESETS) {
      if (group !== preset.group) {
        group = preset.group;
        optgroup = make("optgroup");
        optgroup.label = group;
        $("graphics-preset").append(optgroup);
      }
      const option = make("option", preset.name);
      option.value = preset.id;
      optgroup.append(option);
    }
    const custom = make("option", "Custom bitmap range");
    custom.value = "custom";
    $("graphics-preset").append(custom);
  }
  fillSelect(
    "graphics-section",
    sectionOptions().filter((option) =>
      ["ui_nu", "dsp_nu", "gps_nu"].includes(option.value),
    ),
  );
  if (!state.bitmap) {
    selectGraphicsPreset();
  }
}
function selectGraphicsPreset() {
  const preset = GRAPHICS_PRESETS.find(
    (item) => item.id === $("graphics-preset").value,
  );
  if (preset) {
    $("graphics-section").value = "ui_nu";
    $("graphics-offset").value = hex(preset.offset);
    $("graphics-width").value = preset.width;
    $("graphics-height").value = preset.height;
    $("graphics-format").value = preset.format;
  }
  readGraphics();
}
function bitmapSettings() {
  const width = Number($("graphics-width").value),
    height = Number($("graphics-height").value),
    format = $("graphics-format").value;
  const length = bitmapLength(width, height, format);
  if (width > 1024 || height > 1024 || length > 1048576)
    throw new Error("Bitmap dimensions must be at most 1024 × 1024.");
  return {
    section: $("graphics-section").value,
    offset: numberOffset($("graphics-offset").value),
    width,
    height,
    format,
    length,
  };
}
function readGraphics() {
  known();
  const settings = bitmapSettings(),
    bytes = state.ws.getBytes(settings.section);
  if (settings.offset > bytes.length - settings.length)
    throw new Error("The bitmap extends beyond this section.");
  const original = bytes.slice(
    settings.offset,
    settings.offset + settings.length,
  );
  state.bitmap = {
    ...settings,
    original,
    rgba: decodeBitmap(
      original,
      settings.width,
      settings.height,
      settings.format,
    ),
    dirty: false,
  };
  setDraft("graphics", false);
  drawBitmap();
  $("apply-graphics").disabled = true;
  $("logo-status").textContent = "Preview matches the current firmware bytes.";
}
function drawBitmap() {
  const bitmap = state.bitmap;
  if (!bitmap) return;
  const canvas = $("bitmap-preview");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas
    .getContext("2d")
    .putImageData(
      new ImageData(bitmap.rgba, bitmap.width, bitmap.height),
      0,
      0,
    );
  $("graphics-details").textContent =
    `${bitmap.section} ${hex(bitmap.offset)} · ${bitmap.width} × ${bitmap.height} · ${bitmap.format} · ${bitmap.length.toLocaleString()} bytes`;
  const preset = GRAPHICS_PRESETS.find(
    (item) => item.id === $("graphics-preset").value,
  );
  if (preset?.widthOffset != null)
    $("graphics-details").textContent +=
      ` · Glyph advance byte at ${hex(preset.widthOffset)} (editable in Raw / sections).`;
}
function changedBitmap() {
  const bitmap = state.bitmap;
  bitmap.editRevision = (bitmap.editRevision || 0) + 1;
  const encoded = encodeBitmap(
    bitmap.rgba,
    bitmap.width,
    bitmap.height,
    bitmap.format,
    bitmap.original,
  );
  bitmap.rgba = decodeBitmap(
    encoded,
    bitmap.width,
    bitmap.height,
    bitmap.format,
  );
  bitmap.dirty = !equal(encoded, bitmap.original);
  setDraft("graphics", bitmap.dirty);
  $("apply-graphics").disabled = !bitmap.dirty;
  $("logo-status").textContent = bitmap.dirty
    ? "Unapplied image preview. Apply bitmap to include it in your download."
    : "Preview matches the current firmware bytes.";
  drawBitmap();
}
async function importImage(file) {
  if (!file) return;
  known();
  if (!state.bitmap) readGraphics();
  if (file.size > 16 * 1024 * 1024)
    throw new Error("Choose an image no larger than 16 MB.");
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  const token = state.token,
    bitmap = state.bitmap,
    bitmapRevision = bitmap.editRevision || 0,
    request = (state.imageRequest = (state.imageRequest || 0) + 1),
    image = await createImageBitmap(file);
  try {
    if (
      token !== state.token ||
      bitmap !== state.bitmap ||
      bitmapRevision !== (bitmap.editRevision || 0) ||
      request !== state.imageRequest
    )
      return;
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = $("image-smoothing").checked;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    bitmap.rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    changedBitmap();
  } finally {
    image.close();
    $("logo-file").value = "";
  }
}
let painting = false;
function paintPixel(event) {
  if (!state.bitmap || !$("paint-enabled").checked) return;
  const bitmap = state.bitmap,
    rect = $("bitmap-preview").getBoundingClientRect();
  const x = Math.floor(
      ((event.clientX - rect.left) / rect.width) * bitmap.width,
    ),
    y = Math.floor(((event.clientY - rect.top) / rect.height) * bitmap.height);
  if (x < 0 || y < 0 || x >= bitmap.width || y >= bitmap.height) return;
  const color = $("paint-color").value;
  const at = (y * bitmap.width + x) * 4;
  bitmap.rgba.set(
    [
      parseInt(color.slice(1, 3), 16),
      parseInt(color.slice(3, 5), 16),
      parseInt(color.slice(5, 7), 16),
      255,
    ],
    at,
  );
  changedBitmap();
}
function renderScan() {
  if (!state.ws.info.profileKnown) return;
  const frames = readScanFrames(state.ws.getBytes("ui_nu"));
  state.scanFrames = frames;
  state.scanOriginal = state.ws.getBytes("ui_nu").slice(0x2f7ac, 0x2fa00);
  const body = $("scan-body");
  body.replaceChildren();
  frames.forEach((frame, index) => {
    const tr = make("tr");
    tr.append(make("td", String(index + 1)));
    frame.forEach((value, col) => {
      const td = make("td"),
        input = make("input");
      input.id = `scan-${index}-${col}`;
      input.type = "number";
      input.min = "0";
      input.max = "4";
      input.step = "1";
      input.value = value;
      input.setAttribute("aria-label", `Frame ${index + 1}, column ${col + 1}`);
      input.addEventListener("input", () => {
        drawScanPreview();
        const dirty = state.scanFrames.some((f, i) =>
          f.some((v, j) => String(v) !== $(`scan-${i}-${j}`).value),
        );
        $("apply-scan").disabled = !dirty;
        setDraft("scan", dirty);
      });
      td.append(input);
      tr.append(td);
    });
    body.append(tr);
  });
  drawScanPreview();
  $("apply-scan").disabled = true;
}
function drawScanPreview() {
  const index = Number($("scan-frame").value),
    preview = $("scan-preview");
  preview.replaceChildren();
  $("scan-frame-label").textContent = `Frame ${index + 1}`;
  for (let col = 0; col < 8; col++) {
    const value = Number($(`scan-${index}-${col}`)?.value || 0);
    const bar = make("i");
    bar.className = `scan-level-${Math.max(0, Math.min(4, value))}`;
    bar.setAttribute("aria-label", `Column ${col + 1}: ${value}`);
    preview.append(bar);
  }
}
function applyScan() {
  known();
  if (
    [...$("scan-body").querySelectorAll("input")].some(
      (input) => input.value.trim() === "",
    )
  )
    throw new Error("Every scan cell needs a level from 0 to 4.");
  const frames = Array.from({ length: 20 }, (_, f) =>
    Array.from({ length: 8 }, (_, c) => Number($(`scan-${f}-${c}`).value)),
  );
  ensureUnchanged("ui_nu", 0x2f7ac, state.scanOriginal, "Scan startup data");
  const patch = makeScanFramesPatch(state.ws.getBytes("ui_nu"), frames);
  transaction("Scan motion table", () =>
    state.ws.applyPatches([patch], "Scan motion table"),
  );
}
function gpsSection() {
  const section = state.ws.sections.find((item) => item.name === "GPSD:LRDB");
  if (!section)
    throw new Error(
      "This file does not contain a supported GPSD:LRDB database. Its bytes remain available in Raw / sections.",
    );
  return section;
}
function renderGps() {
  if (!state.ws.info.profileKnown) return;
  if (!state.gps) {
    const section = gpsSection(),
      bytes = state.ws.getBytes();
    const gps = decodeGpsDatabase(
      state.ws.getBytes(section.name, false),
      bytes.slice(
        section.offset + section.size,
        section.offset + section.size + 12,
      ),
    );
    state.gps = {
      ...gps,
      dirty: false,
      original: bytes.slice(
        section.offset - 12,
        section.offset + section.size + 19,
      ),
    };
    state.gpsFormOpen = false;
    state.gpsPage = 0;
    const d = String(gps.date);
    $("gps-date").value = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    $("gps-form").hidden = true;
    $("gps-status").textContent = "";
  }
  renderGpsRows();
}
function filteredGps() {
  const query = $("gps-search").value.trim().toLowerCase();
  return state.gps.records
    .map((record, index) => ({ record, index }))
    .filter(({ record: r }) =>
      `${r.lat} ${r.lon} ${r.type} ${r.speed} ${r.type === 1 ? "speed" : r.type === 2 ? "red light" : ""}`
        .toLowerCase()
        .includes(query),
    );
}
function renderGpsRows() {
  const rows = filteredGps(),
    pages = Math.max(1, Math.ceil(rows.length / 50));
  state.gpsPage = Math.min(state.gpsPage, pages - 1);
  const body = $("gps-body");
  body.replaceChildren();
  for (const { record: r, index } of rows.slice(
    state.gpsPage * 50,
    state.gpsPage * 50 + 50,
  )) {
    const tr = make("tr");
    for (const v of [
      r.lat.toFixed(6),
      r.lon.toFixed(6),
      r.type === 1 ? "1 · Speed" : r.type === 2 ? "2 · Red light" : r.type,
      r.speed,
      r.heading,
    ])
      tr.append(make("td", String(v)));
    const td = make("td");
    for (const [title, action] of [
      ["Edit", () => editGps(index)],
      [
        "Delete",
        () => {
          if (state.gpsFormOpen) {
            error("Save or cancel the open record before deleting a record.");
            return;
          }
          state.gps.records.splice(index, 1);
          gpsDirty("Record removed from draft.");
          renderGpsRows();
          $("gps-form").hidden = true;
        },
      ],
    ]) {
      const button = make("button", title, "text-button");
      button.type = "button";
      button.addEventListener("click", action);
      td.append(button);
    }
    tr.append(td);
    body.append(tr);
  }
  $("gps-count").textContent =
    `${state.gps.records.length.toLocaleString()} total records · ${rows.length.toLocaleString()} matching${state.gps.dirty ? " · unapplied database draft" : ""}`;
  $("gps-page").textContent = `Page ${state.gpsPage + 1} of ${pages}`;
  $("gps-prev").disabled = !state.gpsPage;
  $("gps-next").disabled = state.gpsPage + 1 >= pages;
  $("apply-gps").disabled = !state.gps.dirty || !!state.gpsFormOpen;
}
const GPS_FIELDS = {
  lat: "lat",
  lon: "lon",
  type: "type",
  speed: "speed",
  heading: "heading",
  f2: "mode",
  category: "category",
  reserved: "tail",
};
function editGps(index = null) {
  if (state.gpsFormOpen) {
    error("Save or cancel the open record before choosing another record.");
    return;
  }
  state.gpsFormOpen = true;
  setDraft("gps", true);
  $("apply-gps").disabled = true;
  state.gpsEdit = index;
  const r =
    index === null
      ? {
          lat: 0,
          lon: 0,
          type: 1,
          speed: 0,
          heading: 360,
          mode: 2,
          category: 1,
          tail: 65535,
        }
      : state.gps.records[index];
  for (const [id, key] of Object.entries(GPS_FIELDS))
    $(`gps-${id}`).value = Object.is(r[key], -0) ? "-0" : String(r[key]);
  $("gps-form-title").textContent =
    index === null ? "Add GPS record" : `Edit GPS record ${index + 1}`;
  $("gps-form").hidden = false;
  $("gps-lat").focus();
}
function gpsDirty(message) {
  state.gps.dirty = true;
  state.gps.editRevision = (state.gps.editRevision || 0) + 1;
  setDraft("gps", true);
  $("apply-gps").disabled = !!state.gpsFormOpen;
  $("gps-status").textContent =
    message + " Apply database to include this draft in your download.";
}
function gpsDate() {
  const value = $("gps-date").value;
  if (!value) throw new Error("Choose a database date.");
  return Number(value.replaceAll("-", ""));
}
function saveGps() {
  const record = Object.fromEntries(
    Object.entries(GPS_FIELDS).map(([id, key]) => [
      key,
      Number($(`gps-${id}`).value),
    ]),
  );
  buildGpsRecord([record], gpsDate());
  if (state.gpsEdit === null) state.gps.records.push(record);
  else state.gps.records[state.gpsEdit] = record;
  $("gps-form").hidden = true;
  state.gpsFormOpen = false;
  gpsDirty("Record saved to draft.");
  renderGpsRows();
}
function applyGps() {
  known();
  if (state.gpsFormOpen)
    throw new Error(
      "Save or cancel the open GPS record before applying the database.",
    );
  const section = gpsSection();
  ensureUnchanged(
    "file",
    section.offset - 12,
    state.gps.original,
    "GPS database",
  );
  const record = buildGpsRecord(state.gps.records, gpsDate()),
    count = state.gps.records.length;
  transaction(`GPS database (${count.toLocaleString()} records)`, () =>
    state.ws.spliceFile(
      section.offset - 12,
      section.size + 31,
      record,
      `GPS database (${count.toLocaleString()} records)`,
    ),
  );
}
function rawSelection() {
  return {
    section: $("raw-section").value || "file",
    decoded: $("raw-decoded").checked,
  };
}
function renderRaw() {
  fillSelect("raw-section", sectionOptions(true));
  const { section, decoded } = rawSelection(),
    meta = state.ws.sections.find((item) => item.name === section),
    bytes = state.ws.getBytes(section, decoded);
  $("raw-decoded").disabled = section === "file" || meta?.key == null;
  $("raw-location").disabled = !state.ws.info.profileKnown;
  $("raw-description").textContent =
    section === "file"
      ? `Absolute file offsets · exact encoded bytes · ${size(bytes.length)}`
      : `Offsets relative to ${section} · ${decoded && meta?.key != null ? `decoded with key ${meta.key}` : "on-disk bytes; no decoding applied"} · file base ${hex(meta.offset)} · ${size(bytes.length)}`;
  state.rawOffset = Math.max(
    0,
    Math.min(state.rawOffset, Math.max(0, bytes.length - 1)),
  );
  $("raw-view-offset").value = hex(state.rawOffset);
  const lines = [
    "Offset     00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F   ASCII",
  ];
  for (
    let offset = state.rawOffset;
    offset < Math.min(bytes.length, state.rawOffset + 256);
    offset += 16
  ) {
    const row = bytes.subarray(offset, Math.min(bytes.length, offset + 16));
    const hexes = Array.from(row, (b) =>
      b.toString(16).padStart(2, "0").toUpperCase(),
    )
      .join(" ")
      .padEnd(47, " ");
    const ascii = Array.from(row, (b) =>
      b >= 32 && b <= 126 ? String.fromCharCode(b) : ".",
    ).join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}   ${hexes}   ${ascii}`);
  }
  $("hex-view").textContent = lines.join("\n");
  renderSoundDirectory();
  $("raw-prev").disabled = state.rawOffset === 0;
  $("raw-next").disabled = state.rawOffset + 256 >= bytes.length;
}
function renderSoundDirectory() {
  const section = state.ws.sections.find((s) => s.name === "sound_dbnu");
  $("sound-directory").hidden = !section || !state.ws.info.profileKnown;
  if ($("sound-directory").hidden) return;
  if (state.soundRevision !== state.ws.info.revision) {
    try {
      state.soundClips = readSoundDirectory(state.ws.getBytes(section.name));
      state.soundRevision = state.ws.info.revision;
      fillSelect(
        "sound-clip",
        state.soundClips.map((clip) => ({
          value: String(clip.index),
          label: `Clip ${clip.index} · ${hex(clip.offset)} · ${clip.length.toLocaleString()} bytes`,
        })),
      );
      $("sound-status").textContent =
        `${state.soundClips.length} clips. Offsets are relative to the decoded sound_dbnu section.`;
    } catch (cause) {
      state.soundClips = [];
      $("sound-directory").hidden = true;
    }
  }
}
function typedBytes() {
  const type = $("raw-type").value,
    value =
      type === "ascii" ? $("raw-value").value : $("raw-value").value.trim();
  if (type === "hex") return bytesFromHex(value);
  if (type === "ascii") {
    if (/[^\x20-\x7e\r\n\t]/.test(value))
      throw new Error("ASCII input must contain ASCII characters.");
    return Uint8Array.from(value, (c) => c.charCodeAt(0));
  }
  if (value === "") throw new Error("Enter a value.");
  const number = Number(value),
    bytes = new Uint8Array({ u8: 1, u16: 2, u32: 4, f32: 4 }[type]),
    view = new DataView(bytes.buffer);
  if (type === "f32") {
    if (!Number.isFinite(number) || !Number.isFinite(Math.fround(number)))
      throw new Error("Enter a finite Float32 value.");
    view.setFloat32(0, number, true);
  } else {
    const max = { u8: 255, u16: 65535, u32: 4294967295 }[type];
    if (!Number.isInteger(number) || number < 0 || number > max)
      throw new Error(`Enter an integer from 0 to ${max}.`);
    if (type === "u8") view.setUint8(0, number);
    else if (type === "u16") view.setUint16(0, number, true);
    else view.setUint32(0, number, true);
  }
  return bytes;
}
function applyRaw() {
  const selection = rawSelection(),
    offset = numberOffset($("raw-patch-offset").value),
    bytes = typedBytes();
  if (!bytes.length) throw new Error("Enter at least one byte to patch.");
  const label =
    $("raw-label").value.trim() ||
    `${selection.section} byte patch at ${hex(offset)}`;
  transaction(label, () =>
    state.ws.applyPatches([{ ...selection, offset, bytes }], label),
  );
}
function findRaw() {
  const { section, decoded } = rawSelection(),
    bytes = state.ws.getBytes(section, decoded),
    query = $("raw-search-value").value;
  const needle =
    $("raw-search-type").value === "hex"
      ? bytesFromHex(query)
      : Uint8Array.from(query, (c) => c.charCodeAt(0));
  if (!needle.length) throw new Error("Enter bytes or ASCII text to find.");
  if ($("raw-search-type").value === "ascii" && /[^\x00-\x7f]/.test(query))
    throw new Error("Search text must be ASCII.");
  let found = -1;
  const start = state.rawOffset + 1;
  for (let step = 0; step < bytes.length; step++) {
    const at = (start + step) % bytes.length;
    if (at > bytes.length - needle.length) continue;
    let match = true;
    for (let i = 0; i < needle.length; i++)
      if (bytes[at + i] !== needle[i]) {
        match = false;
        break;
      }
    if (match) {
      found = at;
      break;
    }
  }
  if (found < 0) {
    $("raw-search-result").textContent = "No matching bytes in this region.";
    return;
  }
  state.rawOffset = found;
  $("raw-patch-offset").value = hex(found);
  renderRaw();
  $("raw-search-result").textContent =
    `Found at ${hex(found)}. Find next continues after this match and wraps at the end.`;
}
function renderReview() {
  const info = state.ws.info,
    changes = state.ws.changes || state.history.map((label) => ({ label }));
  $("review-count").textContent =
    `${info.changeCount} applied operations${state.drafts.size ? ` · ${state.drafts.size} unapplied drafts` : ""}`;
  $("review-integrity").textContent = state.practice
    ? "Practice sample: raw-byte review only; device-format validation is not applicable."
    : info.containerValid
    ? `Container framing parses. ${info.profileKnown ? "Mapped R7 layout is available; edited bytes are not stock-verified." : "The named R7 profile is not identified."}`
    : `Container is unrecognized or invalid: ${info.error || "framing could not be parsed"}. Export remains available for raw work.`;
  $("review-integrity").classList.toggle(
    "unsupported",
    !state.practice && (!info.containerValid || !info.profileKnown),
  );
  $("no-changes").hidden = info.changeCount > 0;
  const list = $("review-list");
  list.replaceChildren();
  for (const change of changes) {
    const item = make("li");
    item.append(make("strong", change.label));
    if (change.before || change.after) {
      const details = make("details"),
        summary = make("summary", "Byte details");
      details.append(
        summary,
        make("p", `Before: ${change.before || "—"}`),
        make("p", `After: ${change.after || "—"}`),
      );
      item.append(details);
    }
    list.append(item);
  }
  $("prepare-download").disabled = !info.changeCount;
  renderComparison();
}
function jumpToRaw(offset) {
  if (state.drafts.has("raw"))
    throw new Error("Apply or discard your raw draft before jumping to a different region.");
  fillSelect("raw-section", sectionOptions(true), "file");
  $("raw-decoded").checked = false;
  state.rawOffset = offset;
  $("raw-patch-offset").value = hex(offset);
  delete state.rendered.raw;
  switchPanel("raw", true);
  $("hex-view").focus();
}
function renderComparison() {
  if (state.comparisonRevision !== state.ws.info.revision) {
    state.comparisonRevision = state.ws.info.revision;
    state.comparisonCursors = [0];
    state.comparisonPage = 0;
  }
  const result = state.ws.reviewChanges({ offset: state.comparisonCursors[state.comparisonPage] });
  state.comparisonNext = result.nextOffset;
  $("diff-bytes").textContent = result.changedBytes.toLocaleString();
  $("diff-ranges").textContent = result.rangeCount.toLocaleString();
  const delta = result.outputSize - result.inputSize;
  $("diff-size").textContent = `${delta > 0 ? "+" : ""}${delta.toLocaleString()} B`;
  $("diff-resize-note").hidden = delta === 0;
  $("diff-empty").hidden = result.changedBytes > 0;
  const list = $("diff-list");
  list.replaceChildren();
  for (const range of result.ranges) {
    const card = make("article", undefined, "diff-card");
    const heading = make("div", undefined, "diff-heading");
    heading.append(make("strong", `${hex(range.offset)}–${hex(range.offset + range.size - 1)}`), make("span", `${range.size.toLocaleString()} ${range.size === 1 ? "byte" : "bytes"}`));
    const columns = make("div", undefined, "diff-columns");
    for (const [label, values, kind] of [["Original input", range.before, "before"], ["Current bytes", range.after, "after"]]) {
      const column = make("div", undefined, `diff-column ${kind}`);
      column.append(make("span", label, "diff-label"));
      const code = make("code", undefined, "diff-hex");
      for (const byte of values) code.append(make("span", byte === null ? "—" : byte.toString(16).padStart(2, "0").toUpperCase()));
      column.append(code);
      columns.append(column);
    }
    card.append(heading, columns);
    const footer = make("div", undefined, "diff-footer");
    footer.append(make("span", range.truncated ? `First ${range.before.length} bytes shown. Explore the full range in Raw / sections.` : "Complete range shown.", "field-help"));
    if (range.offset < result.outputSize) {
      const jump = make("button", "Inspect current bytes", "text-button");
      jump.type = "button";
      jump.setAttribute("aria-label", `Inspect current bytes at ${hex(range.offset)}`);
      jump.addEventListener("click", guard(() => jumpToRaw(range.offset)));
      footer.append(jump);
    } else footer.append(make("span", "Removed from the current file", "field-help"));
    card.append(footer);
    list.append(card);
  }
  $("diff-pagination").hidden = state.comparisonPage === 0 && result.nextOffset === null;
  $("diff-prev").disabled = state.comparisonPage === 0;
  $("diff-next").disabled = result.nextOffset === null;
  $("diff-page").textContent = `Page ${state.comparisonPage + 1} · ${result.ranges.length} ranges shown`;
}
async function prepareDownloads() {
  if (!state.ws?.info.changeCount) return;
  const ws = state.ws,
    revision = ws.info.revision,
    token = state.token;
  $("prepare-download").disabled = true;
  status("Hashing the edited copy and building its change manifest…");
  const result = await ws.export();
  if (token !== state.token || ws !== state.ws || revision !== ws.info.revision)
    return;
  invalidateDownloads();
  const base = state.fileName.replace(/\.bin$/i, "");
  for (const [id, bytes, name, type] of [
    [
      "download-firmware",
      result.bytes,
      `${base}_edited.bin`,
      "application/octet-stream",
    ],
    [
      "download-manifest",
      JSON.stringify(result.manifest, null, 2),
      `${base}_changes.json`,
      "application/json",
    ],
  ]) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    state.urls.push(url);
    $(id).href = url;
    $(id).download = name;
  }
  $("downloads").hidden = false;
  $("download-firmware").textContent = state.practice ? "Download practice bytes" : "Download modified firmware";
  $("prepare-download").disabled = false;
  status("Downloads are ready. Your original file is unchanged.");
}

$("choose-file").addEventListener("click", () => $("firmware-file").click());
$("open-practice").addEventListener("click", guard(async () => {
  await loadFirmware(new File([practiceBytes()], "workbench-practice.bin", { type: "application/octet-stream" }), { practice: true });
  jumpToRaw(0x40);
  status("Practice file opened. Apply the example edit, then compare its bytes and try Undo. This sample is not firmware.");
}));
$("practice-edit").addEventListener("click", guard(() => {
  if (!state.practice || state.ws.info.changeCount) return;
  transaction("Practice: change HELLO to LOCAL", () => state.ws.applyPatches([
    { section: "file", offset: 0x40, bytes: new TextEncoder().encode("LOCAL") },
  ], "Practice: change HELLO to LOCAL"), "practice");
  switchPanel("review", true);
}));
$("practice-inspect").addEventListener("click", guard(() => jumpToRaw(0x40)));
$("diff-prev").addEventListener("click", () => {
  if (state.comparisonPage > 0) { state.comparisonPage--; renderComparison(); }
});
$("diff-next").addEventListener("click", () => {
  if (state.comparisonNext === null) return;
  state.comparisonCursors[++state.comparisonPage] = state.comparisonNext;
  renderComparison();
});
$("choose-another").addEventListener("click", () => $("firmware-file").click());
$("firmware-file").addEventListener(
  "change",
  guard((event) => loadFirmware(event.target.files[0])),
);
$("choose-reference").addEventListener("click", () =>
  $("reference-file").click(),
);
$("reference-file").addEventListener(
  "change",
  guard(async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (!file.size || file.size > MAX_SIZE)
      throw new Error("Reference must be between 1 byte and 32 MB.");
    if (state.ws.info.changeCount || state.drafts.size)
      throw new Error(
        "A reference starts a new session. Download or reset applied edits and discard unapplied drafts before loading a reference.",
      );
    const ws = state.ws,
      token = state.token,
      revision = ws.info.revision,
      request = (state.referenceRequest = (state.referenceRequest || 0) + 1);
    const reference = new Uint8Array(await file.arrayBuffer());
    const next = await openWorkspace(ws.getBytes(), { reference });
    if (
      ws !== state.ws ||
      token !== state.token ||
      revision !== ws.info.revision ||
      request !== state.referenceRequest
    )
      return;
    state.ws = next;
    state.bitmap = null;
    state.gps = null;
    state.rendered = {};
    state.soundRevision = null;
    $("reference-status").textContent =
      `Reference loaded: ${file.name}. Named editors use its layout; changed firmware bytes are not verified against stock.`;
    refresh();
    status("Matching reference identified. Mapped editors are available.");
    event.target.value = "";
  }),
);
for (const button of document.querySelectorAll("[role=tab]"))
  button.addEventListener("click", () => switchPanel(button.dataset.panel));
document.querySelector(".editor-nav").addEventListener("keydown", (event) => {
  const tabs = [...document.querySelectorAll("[role=tab]")],
    at = tabs.indexOf(document.activeElement);
  if (at < 0) return;
  let next = at;
  if (["ArrowDown", "ArrowRight"].includes(event.key))
    next = (at + 1) % tabs.length;
  else if (["ArrowUp", "ArrowLeft"].includes(event.key))
    next = (at + tabs.length - 1) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else return;
  event.preventDefault();
  switchPanel(tabs[next].dataset.panel, true);
});
$("review-shortcut").addEventListener("click", () => switchPanel("review"));
$("undo").addEventListener(
  "click",
  guard(() => {
    if (!state.ws) return;
    state.ws.undo();
    state.history.pop();
    if (!state.drafts.has("graphics")) state.bitmap = null;
    if (!state.drafts.has("gps")) state.gps = null;
    state.rendered = {};
    for (const panel of state.drafts)
      state.rendered[panel] = state.ws.info.revision;
    invalidateDownloads();
    refresh();
    status("Last applied operation undone. Unapplied drafts are retained.");
  }),
);
$("reset-all").addEventListener(
  "click",
  guard(() => {
    if (!state.ws) return;
    state.ws.reset();
    state.history = [];
    state.bitmap = null;
    state.gps = null;
    state.drafts.clear();
    state.rendered = {};
    state.soundRevision = null;
    invalidateDownloads();
    refresh();
    status("Reset to the file opened at the start of this session.");
  }),
);
$("band-search").addEventListener("input", filterBands);
$("apply-bands").addEventListener("click", guard(applyBands));
$("apply-text").addEventListener("click", guard(applyQuickText));
$("text-section").addEventListener(
  "change",
  guard(() => {
    state.textPage = 0;
    state.strings = scanStrings(state.ws.getBytes($("text-section").value));
    renderStringRows();
  }),
);
$("text-search").addEventListener("input", () => {
  state.textPage = 0;
  renderStringRows();
});
$("text-prev").addEventListener("click", () => {
  state.textPage--;
  renderStringRows();
});
$("text-next").addEventListener("click", () => {
  state.textPage++;
  renderStringRows();
});
$("string-value").addEventListener("input", updateTextDraft);
$("string-form").addEventListener("submit", guard(applyQuickText));
$("graphics-preset").addEventListener("change", guard(selectGraphicsPreset));
$("graphics-read").addEventListener(
  "click",
  guard(() => {
    $("graphics-preset").value = "custom";
    readGraphics();
  }),
);
$("choose-logo").addEventListener("click", () => $("logo-file").click());
$("logo-file").addEventListener(
  "change",
  guard((event) => importImage(event.target.files[0])),
);
$("reset-logo").addEventListener("click", guard(readGraphics));
$("apply-graphics").addEventListener(
  "click",
  guard(() => {
    known();
    const bitmap = state.bitmap;
    if (!bitmap) return;
    ensureUnchanged(bitmap.section, bitmap.offset, bitmap.original, "Bitmap");
    const bytes = encodeBitmap(
      bitmap.rgba,
      bitmap.width,
      bitmap.height,
      bitmap.format,
      bitmap.original,
    );
    const label = `Bitmap ${bitmap.section} ${hex(bitmap.offset)} (${bitmap.width}×${bitmap.height})`;
    transaction(label, () =>
      state.ws.applyPatches(
        [
          {
            section: bitmap.section,
            offset: bitmap.offset,
            bytes,
            decoded: true,
          },
        ],
        label,
      ),
    );
  }),
);
$("export-image").addEventListener(
  "click",
  guard(() => {
    if (!state.bitmap) return;
    const { section, offset } = state.bitmap;
    $("bitmap-preview").toBlob((blob) => {
      if (blob)
        download(blob, `${section}_${offset.toString(16)}.png`, "image/png");
    }, "image/png");
  }),
);
$("bitmap-preview").addEventListener("pointerdown", (event) => {
  if (!$("paint-enabled").checked) return;
  painting = true;
  event.target.setPointerCapture(event.pointerId);
  paintPixel(event);
});
$("bitmap-preview").addEventListener("pointermove", (event) => {
  if (painting) paintPixel(event);
});
$("bitmap-preview").addEventListener("pointerup", () => {
  painting = false;
});
$("bitmap-preview").addEventListener("pointercancel", () => {
  painting = false;
});
$("scan-frame").addEventListener("input", drawScanPreview);
$("apply-scan").addEventListener("click", guard(applyScan));
$("gps-search").addEventListener("input", () => {
  state.gpsPage = 0;
  if (state.gps) renderGpsRows();
});
$("gps-prev").addEventListener("click", () => {
  state.gpsPage--;
  renderGpsRows();
});
$("gps-next").addEventListener("click", () => {
  state.gpsPage++;
  renderGpsRows();
});
$("gps-add").addEventListener("click", () => editGps());
$("gps-cancel").addEventListener("click", () => {
  $("gps-form").hidden = true;
  state.gpsFormOpen = false;
  setDraft("gps", state.gps.dirty);
  renderGpsRows();
});
$("gps-form").addEventListener("submit", guard(saveGps));
$("apply-gps").addEventListener("click", guard(applyGps));
$("gps-date").addEventListener("change", () => {
  if (state.gps) gpsDirty("Database date updated.");
});
$("gps-export").addEventListener(
  "click",
  guard(() =>
    download(
      gpsToCsv(state.gps.records),
      `${state.fileName.replace(/\.bin$/i, "")}_gps.csv`,
      "text/csv",
    ),
  ),
);
$("gps-import").addEventListener("click", () => $("gps-csv-file").click());
$("gps-csv-file").addEventListener(
  "change",
  guard(async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > MAX_SIZE) throw new Error("CSV must be at most 32 MB.");
    if (state.gpsFormOpen)
      throw new Error(
        "Save or cancel the open GPS record before importing CSV.",
      );
    const ws = state.ws,
      token = state.token,
      revision = ws.info.revision,
      gps = state.gps,
      draftRevision = gps.editRevision || 0,
      request = (state.csvRequest = (state.csvRequest || 0) + 1),
      records = parseGpsCsv(await file.text());
    if (
      ws !== state.ws ||
      token !== state.token ||
      revision !== ws.info.revision ||
      gps !== state.gps ||
      draftRevision !== (gps.editRevision || 0) ||
      request !== state.csvRequest ||
      state.gpsFormOpen
    )
      return;
    state.gps.records = records;
    state.gpsPage = 0;
    gpsDirty(
      `Imported ${records.length.toLocaleString()} records into the draft.`,
    );
    renderGpsRows();
    event.target.value = "";
  }),
);
$("raw-section").addEventListener(
  "change",
  guard(() => {
    state.rawOffset = 0;
    $("raw-patch-offset").value = "0x0";
    $("raw-search-result").textContent = "";
    renderRaw();
  }),
);
$("raw-decoded").addEventListener("change", guard(renderRaw));
$("raw-go").addEventListener(
  "click",
  guard(() => {
    const offset = numberOffset($("raw-view-offset").value),
      { section, decoded } = rawSelection();
    if (offset >= state.ws.getBytes(section, decoded).length)
      throw new Error("View offset is beyond this region.");
    state.rawOffset = offset;
    renderRaw();
  }),
);
$("raw-prev").addEventListener("click", () => {
  state.rawOffset = Math.max(0, state.rawOffset - 256);
  renderRaw();
});
$("raw-next").addEventListener("click", () => {
  state.rawOffset += 256;
  renderRaw();
});
$("raw-find").addEventListener("click", guard(findRaw));
$("raw-form").addEventListener("submit", guard(applyRaw));
$("raw-location").addEventListener(
  "change",
  guard(() => {
    known();
    const value = $("raw-location").value;
    if (!value) return;
    const [section, offset, type] = value.split(":");
    if (!state.ws.sections.some((s) => s.name === section))
      throw new Error("That section is not available in this file.");
    $("raw-section").value = section;
    $("raw-decoded").checked = true;
    state.rawOffset = numberOffset(offset);
    $("raw-patch-offset").value = offset;
    $("raw-type").value = type;
    renderRaw();
    const bytes = state.ws.getBytes(section);
    if (type === "u16" || type === "u32") {
      $("raw-value").value = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      )[type === "u16" ? "getUint16" : "getUint32"](state.rawOffset, true);
    } else $("raw-value").value = "";
    status(
      "Known coordinate selected. Verify the firmware profile and surrounding code before changing its value.",
    );
  }),
);
$("sound-jump").addEventListener(
  "click",
  guard(() => {
    const clip = state.soundClips.find(
      (c) => String(c.index) === $("sound-clip").value,
    );
    if (!clip) return;
    $("raw-section").value = "sound_dbnu";
    $("raw-decoded").checked = true;
    state.rawOffset = clip.offset;
    $("raw-patch-offset").value = hex(clip.offset);
    renderRaw();
    $("raw-search-result").textContent =
      `Clip ${clip.index}: ${hex(clip.offset)} through ${hex(clip.end)}, inclusive.`;
    $("hex-view").focus();
  }),
);
$("sound-export").addEventListener(
  "click",
  guard(() => {
    const clip = state.soundClips.find(
      (c) => String(c.index) === $("sound-clip").value,
    );
    if (!clip) return;
    download(
      state.ws.getBytes("sound_dbnu").slice(clip.offset, clip.end + 1),
      `sound_clip_${clip.index}.bin`,
    );
  }),
);
$("raw-export").addEventListener(
  "click",
  guard(() => {
    const { section, decoded } = rawSelection();
    download(
      state.ws.getBytes(section, decoded),
      `${state.fileName.replace(/\.bin$/i, "")}_${section.replaceAll(":", "_")}_${decoded && state.ws.sections.find((s) => s.name === section)?.key != null ? "decoded" : "raw"}.bin`,
    );
  }),
);
$("raw-import").addEventListener("click", () => $("raw-file").click());
$("raw-file").addEventListener(
  "change",
  guard(async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > MAX_SIZE)
      throw new Error("Replacement must be no larger than 32 MB.");
    const ws = state.ws,
      revision = ws.info.revision,
      selection = rawSelection(),
      bytes = new Uint8Array(await file.arrayBuffer());
    if (ws !== state.ws || revision !== ws.info.revision) return;
    transaction(
      `Replace ${selection.section}`,
      () =>
        state.ws.replaceSection(
          selection.section,
          bytes,
          `Replace ${selection.section}`,
          { decoded: selection.decoded },
        ),
      "raw",
    );
    event.target.value = "";
  }),
);
$("splice-form").addEventListener(
  "submit",
  guard(() => {
    const offset = numberOffset($("splice-offset").value),
      count = Number($("splice-delete").value),
      bytes = bytesFromHex($("splice-bytes").value);
    transaction(`File splice at ${hex(offset)}`, () =>
      state.ws.spliceFile(
        offset,
        count,
        bytes,
        `File splice at ${hex(offset)}`,
      ),
    );
  }),
);
$("discard-draft").addEventListener(
  "click",
  guard(() => {
    state.drafts.delete(state.panel);
    if (state.panel === "graphics") state.bitmap = null;
    if (state.panel === "gps") state.gps = null;
    delete state.rendered[state.panel];
    renderPanel();
    renderDraft();
    status("Current editor draft discarded. Applied changes are unchanged.");
  }),
);
$("prepare-download").addEventListener("click", guard(prepareDownloads));
let dragDepth = 0;
document.addEventListener("dragover", (event) => {
  if ([...(event.dataTransfer?.types || [])].includes("Files"))
    event.preventDefault();
});
document.addEventListener("drop", (event) => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  dragDepth = 0;
  $("drop-zone").classList.remove("is-dragging");
});
$("drop-zone").addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth++;
  $("drop-zone").classList.add("is-dragging");
});
$("drop-zone").addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("drop-zone").classList.remove("is-dragging");
});
$("drop-zone").addEventListener(
  "drop",
  guard((event) => {
    const files = event.dataTransfer?.files;
    if (files?.length !== 1)
      throw new Error("Choose one firmware file at a time.");
    return loadFirmware(files[0]);
  }),
);
window.addEventListener("pagehide", invalidateDownloads);
