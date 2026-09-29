import {
  CATEGORIES, detectCategory, targetsFor, extOf, baseName,
  convert, mergeImagesToPdf, renderPdfThumbnail, zipFiles,
} from './converters.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  dropzone: $('#dropzone'),
  fileInput: $('#fileInput'),
  formatChips: $('#formatChips'),
  workspace: $('#workspace'),
  queueTitle: $('#queueTitle'),
  bulkBox: $('#bulkBox'),
  bulkTargets: $('#bulkTargets'),
  fileList: $('#fileList'),
  convertAll: $('#convertAllBtn'),
  downloadAll: $('#downloadAllBtn'),
  clear: $('#clearBtn'),
  merge: $('#mergeBtn'),
  settingsBtn: $('#settingsBtn'),
  settings: $('#settings'),
  quality: $('#quality'),
  qualityVal: $('#qualityVal'),
  pdfScale: $('#pdfScale'),
  background: $('#background'),
  backgroundVal: $('#backgroundVal'),
  autoDownload: $('#autoDownload'),
  overlay: $('#dragOverlay'),
  toasts: $('#toasts'),
  themeToggle: $('#themeToggle'),
};

const CATEGORY_COLORS = {
  image: '#e0529c', pdf: '#e5484d', sheet: '#17a567', json: '#d69e2e',
  docx: '#2f6fed', text: '#6b7086', html: '#f06a2a',
};

const ICONS = {
  download: '<svg viewBox="0 0 24 24"><path d="M12 4v12M7 11l5 5 5-5M4 20h16"/></svg>',
  remove: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5L20 7"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>',
  arrow: '<svg viewBox="0 0 24 24"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

/** @type {{id:number, file:File, category:string, targets:string[], target:string, status:'idle'|'working'|'done'|'error', progress:number|null, results:{name:string,blob:Blob}[], error:string, thumb:string|null}[]} */
let items = [];
let nextId = 1;

// ---------------------------------------------------------------------------
// Settings & theme
// ---------------------------------------------------------------------------

function loadPref(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}
applyTheme(loadPref('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
els.themeToggle.addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  savePref('theme', next);
});

els.quality.value = loadPref('quality', '92');
els.pdfScale.value = loadPref('pdfScale', '2');
els.background.value = loadPref('background', '#ffffff');
els.autoDownload.checked = loadPref('autoDownload', 'false') === 'true';

function syncSettingLabels() {
  els.qualityVal.textContent = `${els.quality.value}%`;
  els.backgroundVal.textContent = els.background.value;
}
syncSettingLabels();

for (const el of [els.quality, els.pdfScale, els.background, els.autoDownload]) {
  el.addEventListener('input', () => {
    savePref(el.id, el.type === 'checkbox' ? String(el.checked) : el.value);
    syncSettingLabels();
  });
}

els.settingsBtn.addEventListener('click', () => {
  const open = els.settings.classList.toggle('hidden') === false;
  els.settingsBtn.setAttribute('aria-expanded', String(open));
});

function getOptions() {
  return {
    quality: Number(els.quality.value) / 100,
    pdfScale: Number(els.pdfScale.value),
    background: els.background.value,
  };
}

// ---------------------------------------------------------------------------
// Supported format chips on the dropzone
// ---------------------------------------------------------------------------

els.formatChips.innerHTML = Object.values(CATEGORIES)
  .map((c) => {
    const from = [...new Set(c.exts.map((e) => (e === 'jpeg' ? 'jpg' : e === 'markdown' ? null : e)).filter(Boolean))];
    return `<span class="format-group"><b>${from.join(' · ').toUpperCase()}</b><span class="arrow">→</span>${c.targets.join(' · ').toUpperCase()}</span>`;
  })
  .join('');

// ---------------------------------------------------------------------------
// Adding files
// ---------------------------------------------------------------------------

function addFiles(fileList) {
  const rejected = [];
  let added = 0;
  for (const file of fileList) {
    const category = detectCategory(file);
    if (!category) { rejected.push(file.name); continue; }
    const targets = targetsFor(file, category);
    const item = {
      id: nextId++, file, category, targets,
      target: pickDefaultTarget(category, targets),
      status: 'idle', progress: null, results: [], error: '', thumb: null,
    };
    items.push(item);
    added++;
    makeThumbnail(item);
  }
  if (rejected.length) {
    toast(`Unsupported: ${rejected.slice(0, 3).join(', ')}${rejected.length > 3 ? ` +${rejected.length - 3} more` : ''}`, 'error');
  }
  if (added) render();
}

// Remember the last format chosen per category so repeat work is one click.
function pickDefaultTarget(category, targets) {
  const saved = loadPref(`target:${category}`, null);
  return saved && targets.includes(saved) ? saved : targets[0];
}

async function makeThumbnail(item) {
  try {
    if (item.category === 'image') {
      item.thumb = URL.createObjectURL(item.file);
    } else if (item.category === 'pdf') {
      item.thumb = await renderPdfThumbnail(item.file);
    } else {
      return;
    }
    updateCard(item);
  } catch {
    // Keep the extension badge when a preview can't be produced.
  }
}

els.fileInput.addEventListener('change', () => {
  addFiles(els.fileInput.files);
  els.fileInput.value = '';
});

els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); }
});

// Window-wide drag & drop with a full-screen overlay.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (++dragDepth === 1) {
    els.overlay.classList.add('visible');
    els.dropzone.classList.add('active');
  }
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) resetDrag();
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  resetDrag();
  addFiles(e.dataTransfer.files);
});
function resetDrag() {
  dragDepth = 0;
  els.overlay.classList.remove('visible');
  els.dropzone.classList.remove('active');
}

// Paste images (e.g. screenshots) straight from the clipboard.
window.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  addFiles(files.map((f, i) => {
    const ext = extOf(f.name) || (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
    const name = f.name && f.name !== 'image.png' ? f.name : `pasted-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${ext}`;
    return new File([f], name, { type: f.type });
  }));
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const hasItems = items.length > 0;
  els.workspace.classList.toggle('hidden', !hasItems);
  els.dropzone.classList.toggle('compact', hasItems);

  // Rebuild only the cards that are new; drop cards for removed items.
  const existing = new Map([...els.fileList.children].map((li) => [Number(li.dataset.id), li]));
  for (const [id, li] of existing) {
    if (!items.some((it) => it.id === id)) li.remove();
  }
  for (const item of items) {
    if (!existing.has(item.id)) els.fileList.append(createCard(item));
    updateCard(item);
  }
  renderToolbar();
}

function renderToolbar() {
  const total = items.length;
  const done = items.filter((i) => i.status === 'done').length;
  els.queueTitle.textContent = `${total} file${total === 1 ? '' : 's'}${done ? ` · ${done} converted` : ''}`;

  // "Convert all to" chips: formats every queued file can be converted to.
  const common = items.reduce((acc, it) => (acc === null ? [...it.targets] : acc.filter((t) => it.targets.includes(t))), null) || [];
  els.bulkBox.classList.toggle('hidden', common.length === 0 || total < 2);
  els.bulkTargets.innerHTML = common
    .map((t) => `<button class="chip ${items.every((i) => i.target === t) ? 'selected' : ''}" data-target="${t}">${t}</button>`)
    .join('');

  const busy = items.some((i) => i.status === 'working');
  els.convertAll.disabled = busy || !items.some((i) => i.status !== 'done' && i.status !== 'working');
  els.downloadAll.disabled = !items.some((i) => i.results.length);
  els.clear.disabled = busy;
  els.merge.classList.toggle('hidden', items.filter((i) => i.category === 'image').length < 2);
}

els.bulkTargets.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-target]');
  if (!chip) return;
  for (const item of items) {
    if (item.status === 'working') continue;
    setTarget(item, chip.dataset.target);
  }
  render();
});

function setTarget(item, target) {
  if (item.target === target) return;
  item.target = target;
  savePref(`target:${item.category}`, target);
  // Changing the format invalidates previous output.
  if (item.status !== 'working') {
    item.status = 'idle';
    item.results = [];
    item.error = '';
  }
}

function createCard(item) {
  const li = document.createElement('li');
  li.className = 'file-card';
  li.dataset.id = item.id;
  const ext = extOf(item.file.name) || item.category;
  li.innerHTML = `
    <div class="thumb" style="background:${CATEGORY_COLORS[item.category]}">${escapeHtml(ext.toUpperCase().slice(0, 4))}</div>
    <div class="file-info">
      <p class="file-name" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</p>
      <div class="file-meta">
        <span class="badge">${CATEGORIES[item.category].label}</span>
        <span>${formatSize(item.file.size)}</span>
        <span class="status"></span>
      </div>
    </div>
    <div class="file-actions">
      <label class="target-select">${ICONS.arrow}
        <select aria-label="Convert to">${item.targets.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
      </label>
      <span class="action-slot"></span>
      <button class="icon-action remove" title="Remove" aria-label="Remove">${ICONS.remove}</button>
    </div>
    <div class="outputs hidden"></div>
    <div class="progress" style="width:0"></div>`;

  li.querySelector('select').addEventListener('change', (e) => {
    setTarget(item, e.target.value);
    updateCard(item);
    renderToolbar();
  });
  li.querySelector('.remove').addEventListener('click', () => {
    if (item.thumb?.startsWith('blob:')) URL.revokeObjectURL(item.thumb);
    items = items.filter((i) => i !== item);
    render();
  });
  li.querySelector('.action-slot').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.action === 'convert') runItem(item);
    if (btn.dataset.action === 'download') downloadItem(item);
  });
  li.querySelector('.outputs').addEventListener('click', (e) => {
    const pill = e.target.closest('[data-index]');
    if (pill) {
      const r = item.results[Number(pill.dataset.index)];
      downloadBlob(r.blob, r.name);
    }
  });
  return li;
}

function updateCard(item) {
  const li = els.fileList.querySelector(`[data-id="${item.id}"]`);
  if (!li) return;
  li.classList.toggle('done', item.status === 'done');
  li.classList.toggle('error', item.status === 'error');

  const thumb = li.querySelector('.thumb');
  if (item.thumb && !thumb.querySelector('img')) {
    thumb.innerHTML = `<img src="${item.thumb}" alt="">`;
    thumb.style.background = '';
    thumb.classList.toggle('pdf', item.category === 'pdf');
  }

  const select = li.querySelector('select');
  select.value = item.target;
  select.disabled = item.status === 'working';

  const status = li.querySelector('.status');
  status.className = `status ${item.status}`;
  status.innerHTML = {
    idle: '',
    working: `<span class="spinner"></span> Converting${item.progress != null ? ` ${Math.round(item.progress * 100)}%` : '…'}`,
    done: `${ICONS.check} Done${item.results.length > 1 ? ` · ${item.results.length} files` : ''}`,
    error: `${ICONS.alert} ${escapeHtml(item.error)}`,
  }[item.status];

  const slot = li.querySelector('.action-slot');
  slot.innerHTML = {
    idle: `<button class="btn secondary small" data-action="convert">Convert</button>`,
    working: '',
    done: `<button class="btn success small" data-action="download">${ICONS.download} ${item.results.length > 1 ? 'ZIP' : 'Save'}</button>`,
    error: `<button class="icon-action" data-action="convert" title="Retry" aria-label="Retry">${ICONS.retry}</button>`,
  }[item.status];

  const outputs = li.querySelector('.outputs');
  const showOutputs = item.status === 'done' && item.results.length > 1;
  outputs.classList.toggle('hidden', !showOutputs);
  if (showOutputs) {
    const max = 12;
    outputs.innerHTML = item.results.slice(0, max)
      .map((r, i) => `<button class="output-pill" data-index="${i}" title="Download ${escapeHtml(r.name)}">${ICONS.download}${escapeHtml(r.name)}</button>`)
      .join('') + (item.results.length > max ? `<span class="output-pill">+${item.results.length - max} more in ZIP</span>` : '');
  }

  const bar = li.querySelector('.progress');
  bar.classList.toggle('indeterminate', item.status === 'working' && item.progress == null);
  bar.style.width = item.status === 'working' ? `${(item.progress || 0) * 100}%` : '0';
}

// ---------------------------------------------------------------------------
// Converting & downloading
// ---------------------------------------------------------------------------

async function runItem(item) {
  if (item.status === 'working') return;
  item.status = 'working';
  item.progress = null;
  item.error = '';
  item.results = [];
  updateCard(item);
  renderToolbar();

  const target = item.target;
  try {
    // Yield a frame so the spinner paints before heavy synchronous work.
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
    const results = await convert(item.file, item.category, target, getOptions(), (p) => {
      item.progress = p;
      updateCard(item);
    });
    if (!items.includes(item)) return;
    if (item.target !== target) { item.status = 'idle'; return; }
    item.results = results;
    item.status = 'done';
    if (els.autoDownload.checked) downloadItem(item);
  } catch (err) {
    console.error(err);
    item.status = 'error';
    item.error = friendlyError(err);
  } finally {
    updateCard(item);
    renderToolbar();
  }
}

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/password/i.test(msg)) return 'This PDF is password-protected';
  if (/Invalid PDF|InvalidPDF/i.test(msg)) return 'This PDF looks damaged or invalid';
  if (/zip|central directory|end of data/i.test(msg)) return 'Could not read the file. Is it damaged?';
  return msg.length > 120 ? msg.slice(0, 117) + '…' : msg;
}

els.convertAll.addEventListener('click', async () => {
  const pending = items.filter((i) => i.status === 'idle' || i.status === 'error');
  // Run a few at a time: parallel enough to be fast, without freezing the tab.
  const queue = [...pending];
  const worker = async () => {
    while (queue.length) await runItem(queue.shift());
  };
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, worker));
  const ok = pending.filter((i) => i.status === 'done').length;
  const failed = pending.filter((i) => i.status === 'error').length;
  if (pending.length) {
    toast(failed ? `Converted ${ok}, ${failed} failed` : `Converted ${ok} file${ok === 1 ? '' : 's'}`, failed ? 'error' : 'info');
  }
});

async function downloadItem(item) {
  if (!item.results.length) return;
  if (item.results.length === 1) {
    downloadBlob(item.results[0].blob, item.results[0].name);
  } else {
    downloadBlob(await zipFiles(item.results), `${baseName(item.file.name)}_${item.target}.zip`);
  }
}

els.downloadAll.addEventListener('click', async () => {
  const all = items.flatMap((i) => i.results);
  if (all.length === 1) return downloadBlob(all[0].blob, all[0].name);
  els.downloadAll.disabled = true;
  try {
    downloadBlob(await zipFiles(all), `converted-files.zip`);
  } finally {
    renderToolbar();
  }
});

els.clear.addEventListener('click', () => {
  for (const item of items) if (item.thumb?.startsWith('blob:')) URL.revokeObjectURL(item.thumb);
  items = [];
  render();
});

els.merge.addEventListener('click', async () => {
  const images = items.filter((i) => i.category === 'image');
  els.merge.disabled = true;
  try {
    const blob = await mergeImagesToPdf(images.map((i) => i.file), getOptions());
    downloadBlob(blob, 'merged-images.pdf');
    toast(`Merged ${images.length} images into one PDF`);
  } catch (err) {
    toast(friendlyError(err), 'error');
  } finally {
    els.merge.disabled = false;
  }
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  els.toasts.append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove());
  }, 3200);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
