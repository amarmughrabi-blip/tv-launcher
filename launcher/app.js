'use strict';

/**
 * Launcher renderer.
 *
 * Deliberately plain: render a grid, keep selection sane for arrow keys, and
 * let the edit dialog change a name or icon without ever touching the URL —
 * the link is the record's identity, so renaming must not disturb it.
 */

const bridge = window.api;

const el = {
  grid: document.getElementById('grid'),
  empty: document.getElementById('empty'),
  search: document.getElementById('search'),
  add: document.getElementById('add'),
  brave: document.getElementById('open-brave'),
  back: document.getElementById('back'),
  siteTitle: document.getElementById('site-title'),

  editor: document.getElementById('editor'),
  editForm: document.getElementById('edit-form'),
  editName: document.getElementById('edit-name'),
  editUrl: document.getElementById('edit-url'),
  editIconPreview: document.getElementById('edit-icon-preview'),
  editIconInput: document.getElementById('edit-icon-input'),
  editIconClear: document.getElementById('edit-icon-clear'),
  editRemove: document.getElementById('edit-remove'),
  editCancel: document.getElementById('edit-cancel'),
  editSave: document.getElementById('edit-save'),

  adder: document.getElementById('adder'),
  addForm: document.getElementById('add-form'),
  addUrl: document.getElementById('add-url'),
  addName: document.getElementById('add-name'),
  addCancel: document.getElementById('add-cancel'),

  toast: document.getElementById('toast'),
};

let sites = [];
let filter = '';
let editing = null; // the record being edited
let editingIcon = null; // pending custom icon name
let activeUrl = null; // site currently loaded in-window

/* ------------------------------ helpers ------------------------------- */

function toast(message) {
  el.toast.textContent = message;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.toast.hidden = true;
  }, 2600);
}

/** Icon URL for a record: custom image wins, otherwise the favicon cache. */
async function iconUrl(record) {
  if (record.icon) {
    // Custom icons are served through the same privileged scheme; the name is
    // already a hash, so it is safe to place in a path segment.
    return `app-icon://favicon/${record.icon}`;
  }
  return bridge.favicon(record.url);
}

function initials(label) {
  const word = String(label || '?').trim();
  return (word[0] || '?').toUpperCase();
}

/**
 * Stable hue from a label, so a site without a favicon still gets its own
 * colour instead of every tile looking the same.
 */
function badgeHue(label) {
  const text = String(label || '');
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) % 360;
  }
  return hash;
}

/* ------------------------------ rendering ----------------------------- */

async function render() {
  const term = filter.trim().toLowerCase();
  const visible = term
    ? sites.filter((s) => (s.label || '').toLowerCase().includes(term))
    : sites;

  el.grid.replaceChildren();
  el.empty.hidden = visible.length > 0 || sites.length > 0;

  for (const record of visible) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.tabIndex = 0;
    tile.dataset.url = record.url;
    tile.setAttribute('role', 'listitem');

    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = record.label;
    tile.append(label);

    // The badge goes in straight away so the grid is never half-empty, and is
    // upgraded only if a real icon turns up. Waiting on the network first left
    // tiles visibly blank for as long as the slowest site took.
    const placeholder = makeBadge(record);
    tile.prepend(placeholder);

    const edit = document.createElement('button');
    edit.className = 'tile-edit';
    edit.textContent = '✎';
    edit.title = 'Edit name and icon';
    edit.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditor(record);
    });
    tile.append(edit);

    tile.addEventListener('click', () => open(record.url));
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        open(record.url);
      }
    });

    el.grid.append(tile);

    paintIcon(placeholder, record);
  }

  // Selection survives a re-render, which matters when editing a tile.
  if (visible.length) {
    const first = el.grid.querySelector('.tile');
    if (first && !el.grid.querySelector('.tile:focus')) first.focus();
  }
}

/** Replace a tile's badge with a real icon once the favicon lookup finishes. */
async function paintIcon(placeholder, record) {
  let src = null;
  try {
    src = record.icon
      ? `app-icon://favicon/${record.icon}`
      : await bridge.favicon(record.url);
  } catch {
    src = null;
  }

  // The grid may have been re-rendered while the lookup was in flight.
  if (!src || !placeholder.isConnected) return;

  const img = document.createElement('img');
  img.className = 'tile-icon';
  img.src = src;
  img.alt = '';
  img.addEventListener('error', () => placeholder.replaceWith(img), { once: true });
  placeholder.replaceWith(img);
}

function makeBadge(record) {
  const badge = document.createElement('div');
  badge.className = 'badge';
  badge.textContent = initials(record.label);
  const hue = badgeHue(record.label);
  badge.style.background = `linear-gradient(140deg, hsl(${hue} 58% 52%), hsl(${(hue + 38) % 360} 55% 42%))`;
  return badge;
}

/* ------------------------------ actions ------------------------------- */

async function open(url) {
  activeUrl = url;
  await bridge.openSite(url);
  el.brave.hidden = !(await bridge.braveAvailable());
}

async function goBack() {
  await bridge.back();
  activeUrl = null;
  el.brave.hidden = true;
  render();
}

/** Swap the shared bar between launcher controls and site controls. */
function setBarMode(mode, title = '') {
  const siteOpen = mode === 'site';
  el.search.hidden = siteOpen;
  el.add.hidden = siteOpen;
  el.back.hidden = !siteOpen;
  el.siteTitle.hidden = !siteOpen;
  el.siteTitle.textContent = title;
}

el.back.addEventListener('click', goBack);

async function openEditor(record) {
  editing = record;
  editingIcon = record.icon || null;
  el.editName.value = record.label;
  el.editUrl.value = record.url;
  await paintEditPreview();
  el.editor.showModal();
  el.editName.focus();
  el.editName.select();
}

async function paintEditPreview() {
  if (editingIcon) {
    el.editIconPreview.src = `app-icon://favicon/${editingIcon}`;
  } else {
    const fav = await bridge.favicon(editing.url);
    el.editIconPreview.src = fav || '';
  }
}

el.editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editing) return;
  // Only the label and icon are sent. The URL is not part of the patch, so the
  // link survives a rename untouched.
  await bridge.updateSite(editing.url, el.editName.value.trim(), editingIcon);
  el.editor.close();
  await load();
  toast('Saved');
});

el.editIconInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const path = bridge.pathForFile(file);
  if (!path) {
    toast('Could not read that image');
    return;
  }
  const { name } = await bridge.storeIcon(path);
  if (name) {
    editingIcon = name;
    await paintEditPreview();
  } else {
    toast('That file is not a usable image');
  }
  e.target.value = ''; // allow re-picking the same file
});

el.editIconClear.addEventListener('click', async () => {
  editingIcon = null;
  await paintEditPreview();
});

el.editCancel.addEventListener('click', () => el.editor.close());

el.editRemove.addEventListener('click', async () => {
  if (!editing) return;
  await bridge.removeSite(editing.url);
  el.editor.close();
  await load();
  toast('Removed');
});

el.add.addEventListener('click', () => {
  el.addUrl.value = '';
  el.addName.value = '';
  el.adder.showModal();
  el.addUrl.focus();
});

el.addCancel.addEventListener('click', () => el.adder.close());

el.addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = el.addUrl.value.trim();
  if (!url) return;
  await bridge.addSite(url, el.addName.value.trim() || null);
  el.adder.close();
  await load();
  toast('Added');
});

el.brave.addEventListener('click', async () => {
  if (!activeUrl) return;
  const ok = await bridge.openInBrave(activeUrl);
  toast(ok ? 'Opened in Brave' : 'Could not launch a browser');
});

el.search.addEventListener('input', () => {
  filter = el.search.value;
  render();
});

/* --------------------------- keyboard nav ----------------------------- */

document.addEventListener('keydown', (e) => {
  if (el.editor.open || el.adder.open) return;

  if (e.key === 'Escape' && activeUrl) {
    e.preventDefault();
    goBack();
    return;
  }

  const tiles = [...el.grid.querySelectorAll('.tile')];
  if (!tiles.length) return;
  const current = tiles.indexOf(document.activeElement);

  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    tiles[Math.min(tiles.length - 1, current + 1)]?.focus();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    tiles[Math.max(0, current - 1)]?.focus();
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && current >= 0) {
    e.preventDefault();
    const record = sites.find((s) => s.url === tiles[current].dataset.url);
    if (record) openEditor(record);
  }
});

/* ------------------------------ startup ------------------------------- */

bridge.onSiteOpened(({ url, title }) => {
  activeUrl = url;
  setBarMode('site', title || url);
});

bridge.onSiteClosed(() => {
  activeUrl = null;
  setBarMode('launcher');
  el.brave.hidden = true;
  render();
});

async function load() {
  sites = await bridge.listSites();
  setBarMode('launcher');
  await render();
}

load();