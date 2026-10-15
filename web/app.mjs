import { inspectFirmware, exportFirmware, TEXT_FIELDS, LOGO_WIDTH, LOGO_HEIGHT } from './firmware.mjs';

const $ = (id) => document.getElementById(id);
const MAX_FIRMWARE_SIZE = 32 * 1024 * 1024;
const MAX_IMAGE_SIZE = 16 * 1024 * 1024;
const elements = Object.fromEntries(['firmware-file', 'logo-file', 'upload-panel', 'loaded-panel', 'text-editor', 'logo-editor', 'review', 'error', 'status', 'load-status', 'drop-zone', 'prepare-download', 'reset-all', 'reset-logo', 'downloads', 'review-list', 'no-changes', 'logo-status', 'preview-empty', 'logo-preview'].map((id) => [id, $(id)]));
const canvas = elements['logo-preview'];
const context = canvas.getContext('2d');
const state = { model: null, fileName: '', texts: {}, logoPixels: null, importToken: 0, imageToken: 0, revision: 0, busy: false, imageBusy: false, urls: [], prepared: false };

function setError(message = '') {
  elements.error.textContent = message;
  elements.error.hidden = !message;
}

function formatSize(size) {
  if (size < 1024) return `${size.toLocaleString()} bytes`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function samePixels(a, b) {
  return !!a && !!b && a.length === b.length && a.every((value, index) => value === b[index]);
}

function invalidateDownloads() {
  for (const url of state.urls) URL.revokeObjectURL(url);
  state.urls = [];
  state.prepared = false;
  elements.downloads.hidden = true;
  for (const id of ['download-firmware', 'download-manifest']) {
    $(id).removeAttribute('href');
    $(id).removeAttribute('download');
  }
}

function drawLogo(pixels) {
  context.fillStyle = '#000';
  context.fillRect(0, 0, LOGO_WIDTH, LOGO_HEIGHT);
  elements['preview-empty'].hidden = !!pixels;
  if (!pixels) return;
  const image = context.createImageData(LOGO_WIDTH, LOGO_HEIGHT);
  for (let index = 0; index < pixels.length; index += 1) {
    image.data[index * 4] = pixels[index];
    image.data[index * 4 + 1] = pixels[index];
    image.data[index * 4 + 2] = pixels[index];
    image.data[index * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
}

function currentChanges() {
  if (!state.model?.supported) return [];
  const changes = TEXT_FIELDS.filter(({ id }) => state.texts[id] !== state.model.texts[id]).map(({ id, label }) => ({ label, before: state.model.texts[id], after: state.texts[id] }));
  if (!samePixels(state.logoPixels, state.model.logoPixels)) changes.push({ label: 'Boot image', before: 'Original image', after: 'Custom image, 176 × 60 pixels' });
  return changes;
}

function renderChanges(changes) {
  elements['review-list'].replaceChildren();
  elements['no-changes'].hidden = changes.length > 0;
  for (const change of changes) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'review-label';
    label.textContent = change.label;
    const values = document.createElement('span');
    values.className = 'review-value';
    const before = document.createElement('span');
    before.className = 'before';
    before.textContent = change.before === '' ? '(empty)' : String(change.before);
    const after = document.createElement('span');
    after.className = 'after';
    after.textContent = change.after === '' ? '(empty)' : String(change.after);
    const separator = document.createElement('span');
    separator.className = 'visually-hidden';
    separator.textContent = ' changed to ';
    values.append(before, separator, after);
    item.append(label, values);
    elements['review-list'].append(item);
  }
}

function fieldsValid() {
  let valid = true;
  for (const field of TEXT_FIELDS) {
    const input = $(field.id);
    const value = state.texts[field.id] ?? '';
    const message = value.length > field.maxLength ? `Use ${field.maxLength} characters or fewer.` : /[^\x20-\x7e]/.test(value) ? 'Use standard letters, numbers, and punctuation (ASCII).' : '';
    input.setCustomValidity(message);
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    $(`${field.id}-error`).textContent = message;
    $(`${field.id}-error`).hidden = !message;
    $(`${field.id}-count`).textContent = `${value.length} / ${field.maxLength}`;
    if (message) valid = false;
  }
  return valid;
}

function refreshEdits() {
  const changes = currentChanges();
  const valid = fieldsValid();
  renderChanges(changes);
  elements['prepare-download'].disabled = !changes.length || !valid || state.busy || state.imageBusy;
  elements['reset-all'].disabled = !changes.length || state.busy || state.imageBusy;
  elements['reset-logo'].disabled = samePixels(state.logoPixels, state.model?.logoPixels) || state.busy || state.imageBusy;
  $('choose-logo').disabled = state.busy || state.imageBusy;
  elements.status.textContent = !valid ? 'Some text contains unsupported characters. Use standard letters, numbers, and punctuation.' : state.imageBusy ? 'Converting your image…' : changes.length ? `${changes.length} ${changes.length === 1 ? 'change' : 'changes'} ready to review. Prepare downloads to create your edited copy.` : 'No changes yet. Your original file stays untouched.';
}

function markChanged() {
  state.revision += 1;
  invalidateDownloads();
  setError();
  refreshEdits();
}

function clearModel() {
  state.model = null;
  state.fileName = '';
  state.texts = {};
  state.logoPixels = null;
  state.imageToken += 1;
  state.imageBusy = false;
  state.busy = false;
  state.revision += 1;
  invalidateDownloads();
  document.body.classList.remove('has-file');
  elements['upload-panel'].hidden = false;
  for (const id of ['loaded-panel', 'text-editor', 'logo-editor', 'review']) elements[id].hidden = true;
  elements['logo-status'].textContent = '';
  elements['logo-file'].value = '';
  for (const field of TEXT_FIELDS) $(field.id).disabled = true;
  elements['prepare-download'].disabled = true;
  elements['reset-all'].disabled = true;
  elements['reset-logo'].disabled = true;
  drawLogo(null);
}

function renderFile() {
  const { model } = state;
  document.body.classList.add('has-file');
  elements['upload-panel'].hidden = true;
  elements['loaded-panel'].hidden = false;
  $('file-name').textContent = state.fileName;
  $('file-summary').textContent = `${formatSize(model.fileSize)} · ${model.sections.length} sections`;
  $('file-hash').textContent = model.sha256;
  $('compatibility').textContent = model.supported ? 'Verified R7 v153.150.127 layout. Messages and boot image are available to edit.' : (model.reason || 'This firmware is available for inspection. Editing is not supported for this version.');
  $('compatibility').classList.toggle('unsupported', !model.supported);
  $('firmware-details').open = !model.supported;
  $('sections-body').replaceChildren();
  for (const section of model.sections) {
    const row = document.createElement('tr');
    for (const value of [section.name, section.version ?? '—', formatSize(section.size)]) {
      const cell = document.createElement('td');
      cell.textContent = String(value);
      row.append(cell);
    }
    $('sections-body').append(row);
  }
  for (const id of ['text-editor', 'logo-editor', 'review']) elements[id].hidden = !model.supported;
  if (model.supported) {
    state.texts = { ...model.texts };
    state.logoPixels = model.logoPixels.slice();
    for (const field of TEXT_FIELDS) {
      $(field.id).value = state.texts[field.id];
      $(field.id).maxLength = field.maxLength;
      $(field.id).disabled = false;
    }
    drawLogo(state.logoPixels);
    refreshEdits();
  }
}

async function loadFirmware(file) {
  if (!file) return;
  const token = ++state.importToken;
  clearModel();
  setError();
  elements['load-status'].textContent = `Reading ${file.name}…`;
  $('choose-file').disabled = true;
  elements['drop-zone'].setAttribute('aria-busy', 'true');
  try {
    if (!/\.bin$/i.test(file.name)) throw new Error('Choose a firmware file with a .bin extension. Images belong in the boot image editor after loading firmware.');
    if (!file.size) throw new Error('This file is empty. Choose a complete firmware .bin file.');
    if (file.size > MAX_FIRMWARE_SIZE) throw new Error('This file exceeds the 32 MB limit. Choose a smaller firmware file.');
    const bytes = await file.arrayBuffer();
    if (token !== state.importToken) return;
    const model = await inspectFirmware(bytes);
    if (token !== state.importToken) return;
    state.model = model;
    state.fileName = file.name;
    renderFile();
    elements['load-status'].textContent = model.supported ? 'Firmware loaded. Your file remains in this browser.' : 'Firmware inspected. This file is read-only.';
  } catch (error) {
    if (token !== state.importToken) return;
    clearModel();
    setError(error instanceof Error ? error.message : 'The firmware could not be read. Choose a complete .bin file.');
    elements['load-status'].textContent = 'File not loaded. Choose another firmware file to continue.';
  } finally {
    if (token === state.importToken) {
      $('choose-file').disabled = false;
      elements['drop-zone'].removeAttribute('aria-busy');
      elements['firmware-file'].value = '';
    }
  }
}

function decodeImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image could not be decoded. Choose a valid PNG, JPEG, or WebP.')); };
    image.src = url;
  });
}

async function loadLogo(file) {
  if (!file || !state.model?.supported) return;
  const token = ++state.imageToken;
  const importToken = state.importToken;
  state.imageBusy = true;
  invalidateDownloads();
  setError();
  refreshEdits();
  try {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Choose a PNG, JPEG, or WebP image.');
    if (!file.size || file.size > MAX_IMAGE_SIZE) throw new Error('Choose a nonempty image smaller than 16 MB.');
    const image = await decodeImage(file);
    if (token !== state.imageToken || importToken !== state.importToken) return;
    if (image.naturalWidth * image.naturalHeight > 40_000_000) throw new Error('This image is too large to process. Resize it below 40 megapixels and try again.');
    const scratch = document.createElement('canvas');
    scratch.width = LOGO_WIDTH;
    scratch.height = LOGO_HEIGHT;
    const scratchContext = scratch.getContext('2d', { willReadFrequently: true });
    scratchContext.fillStyle = '#000';
    scratchContext.fillRect(0, 0, LOGO_WIDTH, LOGO_HEIGHT);
    scratchContext.drawImage(image, 0, 0, LOGO_WIDTH, LOGO_HEIGHT);
    const rgba = scratchContext.getImageData(0, 0, LOGO_WIDTH, LOGO_HEIGHT).data;
    const pixels = new Uint8Array(LOGO_WIDTH * LOGO_HEIGHT);
    const ramp = [0, 90, 180, 255];
    for (let index = 0; index < pixels.length; index += 1) {
      const average = Math.floor((rgba[index * 4] + rgba[index * 4 + 1] + rgba[index * 4 + 2]) / 3);
      pixels[index] = ramp[Math.min(3, Math.floor(average * 4 / 256))];
    }
    state.logoPixels = pixels;
    drawLogo(pixels);
    elements['logo-status'].textContent = `${file.name} · ${image.naturalWidth} × ${image.naturalHeight} → 176 × 60 pixels`;
    state.revision += 1;
  } catch (error) {
    if (token !== state.imageToken || importToken !== state.importToken) return;
    setError(error instanceof Error ? error.message : 'The image could not be processed.');
  } finally {
    if (token === state.imageToken && importToken === state.importToken) {
      state.imageBusy = false;
      elements['logo-file'].value = '';
      refreshEdits();
    }
  }
}

function outputBaseName(name) {
  return name.replace(/\.bin$/i, '').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'R7-firmware';
}

async function prepareDownloads() {
  if (!state.model?.supported || state.busy || state.imageBusy || !currentChanges().length || !fieldsValid()) return;
  const model = state.model;
  const revision = state.revision;
  const importToken = state.importToken;
  state.busy = true;
  invalidateDownloads();
  setError();
  refreshEdits();
  elements.status.textContent = 'Preparing your edited copy and checking the result…';
  try {
    const result = await exportFirmware(model, { texts: { ...state.texts }, logoPixels: state.logoPixels.slice() });
    if (revision !== state.revision || importToken !== state.importToken) return;
    if (!result.changes.length) throw new Error('No firmware bytes changed. Make an edit before downloading.');
    const baseName = outputBaseName(state.fileName);
    const firmwareUrl = URL.createObjectURL(new Blob([result.bytes], { type: 'application/octet-stream' }));
    const manifestUrl = URL.createObjectURL(new Blob([`${JSON.stringify(result.manifest, null, 2)}\n`], { type: 'application/json' }));
    state.urls = [firmwareUrl, manifestUrl];
    $('download-firmware').href = firmwareUrl;
    $('download-firmware').download = `${baseName}-custom.bin`;
    $('download-manifest').href = manifestUrl;
    $('download-manifest').download = `${baseName}-custom.manifest.json`;
    renderChanges(result.changes);
    state.prepared = true;
    elements.downloads.hidden = false;
    elements.status.textContent = 'Edited copy prepared. Download the firmware and its change manifest below.';
  } catch (error) {
    if (revision !== state.revision || importToken !== state.importToken) return;
    setError(error instanceof Error ? error.message : 'The edited file could not be prepared.');
    elements.status.textContent = 'No download was created. Resolve the error and try again.';
  } finally {
    if (importToken === state.importToken) {
      state.busy = false;
      elements['prepare-download'].disabled = !currentChanges().length || !fieldsValid() || state.imageBusy;
      elements['reset-all'].disabled = !currentChanges().length || state.imageBusy;
      elements['reset-logo'].disabled = samePixels(state.logoPixels, state.model?.logoPixels) || state.imageBusy;
      $('choose-logo').disabled = state.imageBusy;
    }
  }
}

$('choose-file').addEventListener('click', () => elements['firmware-file'].click());
$('choose-another').addEventListener('click', () => elements['firmware-file'].click());
elements['firmware-file'].addEventListener('change', (event) => loadFirmware(event.target.files[0]));
$('choose-logo').addEventListener('click', () => elements['logo-file'].click());
elements['logo-file'].addEventListener('change', (event) => loadLogo(event.target.files[0]));
for (const field of TEXT_FIELDS) {
  $(field.id).addEventListener('input', (event) => {
    if (!state.model?.supported) return;
    state.texts[field.id] = event.target.value;
    markChanged();
  });
}
elements['reset-logo'].addEventListener('click', () => {
  if (!state.model?.supported) return;
  state.imageToken += 1;
  state.logoPixels = state.model.logoPixels.slice();
  elements['logo-status'].textContent = '';
  elements['logo-file'].value = '';
  drawLogo(state.logoPixels);
  markChanged();
});
elements['reset-all'].addEventListener('click', () => {
  if (!state.model?.supported) return;
  state.imageToken += 1;
  state.texts = { ...state.model.texts };
  state.logoPixels = state.model.logoPixels.slice();
  for (const field of TEXT_FIELDS) $(field.id).value = state.texts[field.id];
  elements['logo-status'].textContent = '';
  elements['logo-file'].value = '';
  drawLogo(state.logoPixels);
  markChanged();
});
elements['prepare-download'].addEventListener('click', prepareDownloads);

let dragDepth = 0;
document.addEventListener('dragover', (event) => {
  if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
});
document.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  dragDepth = 0;
  elements['drop-zone'].classList.remove('is-dragging');
  // Only the firmware drop zone loads a file; dropping elsewhere cannot navigate away.
});
elements['drop-zone'].addEventListener('dragenter', (event) => {
  if (!Array.from(event.dataTransfer?.types || []).includes('Files')) return;
  event.preventDefault();
  dragDepth += 1;
  elements['drop-zone'].classList.add('is-dragging');
});
elements['drop-zone'].addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) elements['drop-zone'].classList.remove('is-dragging');
});
elements['drop-zone'].addEventListener('drop', (event) => {
  event.preventDefault();
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  if (files.length !== 1) { setError('Choose one firmware file at a time.'); return; }
  loadFirmware(files[0]);
});
window.addEventListener('pagehide', invalidateDownloads);
drawLogo(null);
