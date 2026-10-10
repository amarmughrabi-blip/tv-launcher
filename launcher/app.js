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
  bar: document.getElementById('bar'),
  railAdd: document.getElementById('rail-add'),
  stage: document.querySelector('.stage'),
  profileChips: document.getElementById('profile-chips'),
  profileEditor: document.getElementById('profile-editor'),
  profileForm: document.getElementById('profile-form'),
  profileName: document.getElementById('profile-name'),
  profileMeta: document.getElementById('profile-meta'),
  profileDelete: document.getElementById('profile-delete'),
  profileCancel: document.getElementById('profile-cancel'),
  hero: document.getElementById('hero'),
  heroIcon: document.getElementById('hero-icon'),
  heroLabel: document.getElementById('hero-label'),
  heroHost: document.getElementById('hero-host'),
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
let tab = 'home';
let selectedUrl = null; // survives re-renders so filtering does not reset the selection

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

/** Strip a leading www. so labels read the way people say them. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
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

function buildTile(record) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.tabIndex = 0;
  tile.dataset.url = record.url;
  tile.dataset.hue = String(badgeHue(record.label));
  tile.setAttribute('role', 'listitem');

  // The badge goes in straight away so the row is never half-empty, and is
  // upgraded only if a real icon turns up. Waiting on the network first left
  // tiles visibly blank for as long as the slowest site took.
  const placeholder = makeBadge(record);
  tile.append(placeholder);

  const label = document.createElement('div');
  label.className = 'tile-label';
  label.textContent = record.label;
  tile.append(label);

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
  tile.addEventListener('focus', () => onTileFocus(tile));
  tile.addEventListener('mousedown', () => onTileFocus(tile));

  // Preserve the selection across re-renders so filtering does not reset it.
  if (record.url === selectedUrl) tile.classList.add('is-selected');

  paintIcon(placeholder, record);
  return tile;
}

/** Keep the selected tile centred and tint the room to match it. */
/** Select a tile: focus it, then drive the presentation from it. */
function selectTile(tile) {
  if (!tile) return;
  tile.focus();
  // focus() sets activeElement, but the focus event is not guaranteed to fire
  // when the window does not hold OS focus, and the selection has to look
  // right either way.
  onTileFocus(tile);
}

function onTileFocus(tile) {
  for (const other of el.grid.querySelectorAll('.tile.is-selected')) {
    other.classList.remove('is-selected');
  }
  tile.classList.add('is-selected');
  selectedUrl = tile.dataset.url;

  const track = tile.closest('.row-track');
  if (track) {
    const target = tile.offsetLeft - (track.clientWidth - tile.offsetWidth) / 2;
    track.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }
  const hue = Number(tile.dataset.hue);
  if (Number.isFinite(hue)) {
    document.documentElement.style.setProperty('--glow-hue', String(hue));
  }
  showHero(tile);
}

/** Present the selected app above the row. */
function showHero(tile) {
  const record = sites.find((s) => s.url === tile.dataset.url);
  if (!record) {
    el.hero.hidden = true;
    return;
  }

  el.hero.hidden = false;
  el.heroLabel.textContent = record.label;
  el.heroHost.textContent = hostOf(record.url);

  // Reuse whatever the tile is already showing, so the banner never flashes
  // empty or contradicts the tile beside it.
  const tileIcon = tile.querySelector('.tile-icon, .badge');
  const isImage = tileIcon && tileIcon.tagName === 'IMG';
  el.heroIcon.className = isImage ? 'hero-icon' : 'hero-icon hero-badge';

  if (isImage) {
    el.heroIcon.removeAttribute('src');
    el.heroIcon.textContent = '';
    el.heroIcon.style.background = '';
    el.heroIcon.src = tileIcon.src;
  } else {
    el.heroIcon.removeAttribute('src');
    el.heroIcon.style.background = tileIcon ? tileIcon.style.background : '';
    el.heroIcon.textContent = initials(record.label);
  }
}

async function render() {
  const term = filter.trim().toLowerCase();
  const visible = term
    ? sites.filter((s) => (s.label || '').toLowerCase().includes(term))
    : sites;

  el.grid.replaceChildren();
  el.grid.classList.toggle('is-grid', tab === 'apps');
  el.empty.hidden = visible.length > 0 || sites.length > 0;

  if (visible.length) {
    const row = document.createElement('section');
    row.className = 'row';

    const heading = document.createElement('h2');
    heading.className = 'row-label';
    heading.textContent = term
      ? `${visible.length} result${visible.length === 1 ? '' : 's'}`
      : tab === 'apps'
        ? 'All apps'
        : 'Your apps';
    row.append(heading);

    const track = document.createElement('div');
    track.className = 'row-track';
    track.setAttribute('role', 'list');
    row.append(track);

    el.grid.append(row);
    for (const record of visible) track.append(buildTile(record));
  }

  // Re-select after a re-render, but never steal focus from the search field:
  // typing re-renders on every keystroke, and focusing a tile here moved the
  // caret out of the box after a single character.
  const searching = document.activeElement === el.search;
  const previous = el.grid.querySelector('.tile.is-selected');
  const first = el.grid.querySelector('.tile');
  if (!visible.length) return;
  if (previous) return;
  if (searching) {
    // Keep the banner in sync without taking focus.
    onTileFocus(first);
    return;
  }
  selectTile(first);
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

  // Always yield once before checking. With a custom icon there is no network
  // await above, so this ran synchronously while buildTile was still
  // constructing the tile -- before the caller appended it -- and the icon was
  // dropped as disconnected.
  await Promise.resolve();

  // The row may also have been re-rendered while the lookup was in flight.
  if (!src || !placeholder.isConnected) return;

  const img = document.createElement('img');
  img.className = 'tile-icon';
  img.src = src;
  img.alt = '';
  img.addEventListener('error', () => placeholder.replaceWith(img), { once: true });

  // Capture the tile before the swap: replacing the placeholder detaches it, so
  // asking for its ancestor afterwards always yields null and the banner never
  // picked up the real icon.
  const tile = placeholder.closest('.tile');
  placeholder.replaceWith(img);

  // The banner mirrors the selected tile, so it has to pick the real icon up
  // once it arrives rather than staying on the letter badge.
  if (tile && tile.classList.contains('is-selected')) showHero(tile);
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

/*
 * Whether the bar hides is decided in the main process: when it is hidden the
 * site view covers the whole window, so this page receives no pointer events at
 * all and could never reveal it. All this side does is reflect the decision.
 */
bridge.onChromeVisible((visible) => {
  el.bar.classList.toggle('bar-hidden', !visible);
});

// Pointer is on the bar itself, which is the launcher page's own strip.
el.bar.addEventListener('mouseenter', () => bridge.chromeHover(true));
el.bar.addEventListener('mouseleave', () => bridge.chromeHover(false));

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

  // Bytes are the reliable route: a picked File has no dependable path once it
  // crosses context isolation. The path is passed along as a fallback only.
  let name = null;
  try {
    const bytes = await file.arrayBuffer();
    ({ name } = await bridge.storeIconBytes(bytes, bridge.pathForFile(file)));
  } catch {
    name = null;
  }

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

el.add.addEventListener('click', () => el.railAdd.click());

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

/* ------------------------------ tabs --------------------------------- */

function setTab(next) {
  tab = next;
  for (const button of document.querySelectorAll('.tab, .rail-btn[data-tab]')) {
    button.classList.toggle('is-active', button.dataset.tab === tab);
  }
  // The banner belongs to the For You view. Leaving it up over the grid made
  // that tab feel like a detail page rather than a list.
  el.stage.classList.toggle('no-banner', tab !== 'home');

  // Opening Search focuses the field so typing works straight away.
  if (tab === 'search') {
    el.search.focus();
    el.search.select();
  } else {
    el.search.blur();
  }
  render();
}

for (const button of document.querySelectorAll('.tab, .rail-btn[data-tab]')) {
  button.addEventListener('click', () => setTab(button.dataset.tab));
}

el.railAdd.addEventListener('click', () => {
  el.addUrl.value = '';
  el.addName.value = '';
  el.adder.showModal();
  el.addUrl.focus();
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

  // Left and right walk the row, which is the direction it scrolls. Up and down
  // stay useful for a remote: up returns to the first app, down to the last.
  switch (e.key) {
    case 'ArrowRight':
      e.preventDefault();
      selectTile(tiles[Math.min(tiles.length - 1, Math.max(0, current) + 1)]);
      break;
    case 'ArrowLeft':
      e.preventDefault();
      selectTile(tiles[Math.max(0, current - 1)]);
      break;
    case 'ArrowUp':
      e.preventDefault();
      selectTile(tiles[0]);
      break;
    case 'ArrowDown':
      e.preventDefault();
      selectTile(tiles[tiles.length - 1]);
      break;
    case 'Home':
      e.preventDefault();
      selectTile(tiles[0]);
      break;
    case 'End':
      e.preventDefault();
      selectTile(tiles[tiles.length - 1]);
      break;
    case 'Delete':
    case 'Backspace': {
      if (current < 0) return;
      e.preventDefault();
      const record = sites.find((s) => s.url === tiles[current].dataset.url);
      if (record) openEditor(record);
      break;
    }
    default:
  }
});

/* ---------------------------- profiles -------------------------------- */

let profiles = { active: null, profiles: [] };
let editingProfileId = null;

async function loadProfiles() {
  profiles = await bridge.listProfiles();
  renderProfiles();
}

/**
 * Render the profile switcher. The active chip carries an edit affordance;
 * a trailing chip creates a new profile.
 */
function renderProfiles() {
  el.profileChips.replaceChildren();

  for (const profile of profiles.profiles) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.dataset.id = profile.id;
    if (profile.id === profiles.active) chip.classList.add('is-active');

    const name = document.createElement('span');
    name.textContent = profile.name;
    chip.append(name);

    const count = document.createElement('span');
    count.className = 'chip-count';
    count.textContent = String(profile.count);
    chip.append(count);

    if (profile.id === profiles.active) {
      const edit = document.createElement('span');
      edit.className = 'chip-edit';
      edit.textContent = '✎';
      edit.title = 'Rename or delete this profile';
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        openProfileEditor(profile);
      });
      chip.append(edit);
    }

    chip.addEventListener('click', () => switchProfile(profile.id));
    el.profileChips.append(chip);
  }

  const add = document.createElement('button');
  add.className = 'chip chip-add';
  add.textContent = '+';
  add.title = 'New profile';
  add.addEventListener('click', createProfile);
  el.profileChips.append(add);
}

async function switchProfile(id) {
  if (!id || id === profiles.active) return;
  profiles = await bridge.activateProfile(id);
  filter = '';
  el.search.value = '';
  selectedUrl = null;
  el.hero.hidden = true;
  await load();
  toast(`Switched to ${profiles.profiles.find((p) => p.id === id)?.name ?? 'profile'}`);
}

async function createProfile() {
  const name = prompt('Name for the new profile');
  if (name === null) return;
  profiles = await bridge.createProfile(name.trim() || undefined);
  filter = '';
  el.search.value = '';
  selectedUrl = null;
  await load();
  toast('Profile created');
}

function openProfileEditor(profile) {
  editingProfileId = profile.id;
  el.profileName.value = profile.name;
  const only = profiles.profiles.length <= 1;
  el.profileDelete.disabled = only;
  el.profileMeta.textContent = only
    ? 'This is your only profile, so it cannot be deleted.'
    : `${profile.count} app${profile.count === 1 ? '' : 's'} in this profile.`;
  el.profileEditor.showModal();
  el.profileName.focus();
  el.profileName.select();
}

el.profileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!editingProfileId) return;
  profiles = await bridge.renameProfile(editingProfileId, el.profileName.value.trim());
  el.profileEditor.close();
  await load();
  toast('Profile saved');
});

el.profileCancel.addEventListener('click', () => el.profileEditor.close());

el.profileDelete.addEventListener('click', async () => {
  if (!editingProfileId || profiles.profiles.length <= 1) return;
  const profile = profiles.profiles.find((p) => p.id === editingProfileId);
  if (!confirm(`Delete "${profile?.name}" and its ${profile?.count ?? 0} app(s)?`)) return;
  profiles = await bridge.deleteProfile(editingProfileId);
  selectedUrl = null;
  el.profileEditor.close();
  await load();
  toast('Profile deleted');
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
  await loadProfiles();
  setBarMode('launcher');
  await render();
}

load();