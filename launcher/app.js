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
  railProfiles: document.getElementById('rail-profiles'),
  stage: document.querySelector('.stage'),
  picker: document.getElementById('picker'),
  pickerGrid: document.getElementById('picker-grid'),
  pickerManage: document.getElementById('picker-manage'),
  pickerHint: document.getElementById('picker-hint'),
  profileAvatarPreview: document.getElementById('profile-avatar-preview'),
  profileAvatarInput: document.getElementById('profile-avatar-input'),
  profileAvatarClear: document.getElementById('profile-avatar-clear'),
  profileEditor: document.getElementById('profile-editor'),
  profileTitle: document.getElementById('profile-title'),
  profileHint: document.getElementById('profile-hint'),
  profileSave: document.getElementById('profile-save'),
  profileForm: document.getElementById('profile-form'),
  profileName: document.getElementById('profile-name'),
  tabs: document.getElementById('tabs'),
  tv: document.getElementById('tv'),
  tvGrid: document.getElementById('tv-grid'),
  tvGenres: document.getElementById('tv-genres'),
  tvSummary: document.getElementById('tv-summary'),
  tvEmpty: document.getElementById('tv-empty'),
  railSettings: document.getElementById('rail-settings'),
  settingsDialog: document.getElementById('settings-dialog'),
  settingsCheckNow: document.getElementById('settings-check-now'),
  settingsHidden: document.getElementById('settings-hidden'),
  tvSweepOpen: document.getElementById('tv-sweep'),
  tvHiddenToggle: document.getElementById('tv-hidden-toggle'),
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
}

async function goBack() {
  await bridge.back();
  activeUrl = null;
  render();
}

/** Swap the shared bar between launcher controls and site controls. */
function setBarMode(mode, title = '') {
  // Over a site the launcher page sits behind the site view, so the bar has
  // nothing left to show: the controls are injected into the page itself
  // (src/site-controls.js).
  const siteOpen = mode === 'site';
  el.search.hidden = siteOpen;
  el.add.hidden = siteOpen;
  el.siteTitle.hidden = true;
  el.siteTitle.textContent = title;
}

/*
 * Whether the bar hides is decided in the main process: when it is hidden the
 * site view covers the whole window, so this page receives no pointer events at
 * all and could never reveal it. All this side does is reflect the decision.
 */
/*
 * The bar's position is driven from the main process on the same clock that
 * moves the site view, so the two cannot disagree. A CSS transition here could
 * be throttled in an unfocused window and leave the bar stranded off-screen
 * while the view had already moved.
 */
document.documentElement.style.setProperty('--chrome-offset', '0px');

bridge.onChromeOffset((offset) => {
  document.documentElement.style.setProperty('--chrome-offset', `${offset}px`);
});

/*
 * The loading screen. Startup blocks the main process for several seconds while
 * the filter lists are parsed, so the window says so rather than going dead.
 */
const boot = document.getElementById('boot');
const bootNote = document.getElementById('boot-note');

bridge.onBootNote((note) => {
  if (note && bootNote) bootNote.textContent = note;
});

bridge.onAppReady(() => {
  if (boot) boot.hidden = true;
});

// Start-up may already have finished by the time this page loaded -- on a slow
// machine the two race, and waiting only for the event would hang here forever.
bridge.isAppReady().then((ready) => {
  if (ready && boot) boot.hidden = true;
});

/*
 * A loading screen that cannot be dismissed is the worst possible failure: the
 * app looks broken, and the one thing that could fix it -- restarting -- is the
 * thing the screen is asking for. Main sends app:ready as soon as the window is
 * usable, but if that message is ever lost the screen would sit there for ever,
 * so it gives up on its own.
 */
setTimeout(() => {
  if (boot && !boot.hidden) {
    boot.hidden = true;
    console.warn('loading screen gave up waiting for the app');
  }
}, 8000);

bridge.onChromeVisible((visible) => {
  el.bar.classList.toggle('bar-hidden', !visible);
});

// Pointer is on the bar itself, which is the launcher page's own strip.
el.bar.addEventListener('mouseenter', () => bridge.chromeHover(true));
el.bar.addEventListener('mouseleave', () => bridge.chromeHover(false));


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

el.search.addEventListener('input', () => {
  filter = el.search.value;
  render();
});

/* ------------------------------- TV ---------------------------------- */

const tv = window.mountTv({
  root: el.tv,
  grid: el.tvGrid,
  genresBar: el.tvGenres,
  summaryEl: el.tvSummary,
  emptyEl: el.tvEmpty,
  load: () => bridge.channels(),
  // Passed in rather than reached for. Classic scripts share one global scope,
  // and this file has already been bitten once by borrowing a name it should
  // not have.
  api: bridge,
  toast,
  play: async (channel) => {
    const result = await bridge.playChannel(channel.url);
    if (!result || !result.ok) {
      toast(`Could not open ${channel.name}`);
    }
  },
});

/* ---------------------------- settings -------------------------------- */

// Guarded, because settings.js is a separate script and a failure in it would
// otherwise throw here and take the tab wiring below it down as well -- one
// broken screen should not cost you the rest of the launcher, least of all the
// button you pressed to find out what went wrong.
const settingsScreen = typeof window.mountSettings === 'function'
  ? window.mountSettings({
    api: bridge,
    toast,
    // Genres and region both change what the TV page shows, so it has to redraw
    // rather than keep a grid the settings no longer describe.
    onChannelChange: () => tv.loadData(),
  })
  : {
    open: () => toast('Settings could not load. Restart the launcher.'),
  };

el.railSettings.addEventListener('click', () => {
  // Wrapped because a throw inside open() would leave the viewer clicking a
  // button that silently does nothing -- which is the worst thing a settings
  // button can do, and looks exactly like a broken app rather than a bug.
  try {
    settingsScreen.open();
  } catch (err) {
    toast(`Settings could not open: ${err && err.message ? err.message : err}`);
    console.error('settings failed to open', err);
  }
});

// Channel management belongs in settings as well as on the TV page: the gear is
// where somebody looks for "how do I get rid of this", and the TV page is where
// the channels are. Both open the same dialogs rather than two copies of them.
el.settingsCheckNow.addEventListener('click', () => {
  el.settingsDialog.close();
  document.querySelector('.rail-btn[data-tab="tv"]').click();
  setTimeout(() => el.tvSweepOpen.click(), 900);
});

el.settingsHidden.addEventListener('click', () => {
  el.settingsDialog.close();
  document.querySelector('.rail-btn[data-tab="tv"]').click();
  setTimeout(() => el.tvHiddenToggle.click(), 900);
});

// The painted selects. Built before anything can be clicked, because a native
// one that opens is a system-drawn popup no stylesheet can reach.
if (typeof window.mountSelects === 'function') window.mountSelects();

/* ------------------------------ tabs --------------------------------- */

function setTab(next) {
  tab = next;
  for (const button of document.querySelectorAll('.tab, .rail-btn[data-tab]')) {
    button.classList.toggle('is-active', button.dataset.tab === tab);
  }
  // The banner belongs to the For You view. Leaving it up over the grid made
  // that tab feel like a detail page rather than a list.
  el.stage.classList.toggle('no-banner', tab !== 'home');

  // TV replaces the apps grid entirely rather than sitting under it.
  const onTv = tab === 'tv';
  if (onTv) tv.show();
  else tv.hide();
  el.grid.hidden = onTv;
  el.tabs.hidden = onTv;

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
let editingProfileAvatar = null;
let pickerManageMode = false;

async function loadProfiles() {
  profiles = await bridge.listProfiles();
}

/** Stable colour per profile name, used when it has no picture. */
function profileHue(name) {
  let hash = 0;
  const text = String(name || '');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

/* ------------------------- the picker itself -------------------------- */

function showPicker({ manage = false } = {}) {
  pickerManageMode = manage;
  el.picker.hidden = false;
  el.pickerManage.hidden = manage;
  el.pickerHint.hidden = manage;
  renderPicker();
}

function hidePicker() {
  el.picker.hidden = true;
}

function renderPicker() {
  el.pickerGrid.replaceChildren();

  for (const profile of profiles.profiles) {
    const item = document.createElement('button');
    item.className = 'picker-item';
    item.dataset.id = profile.id;
    item.setAttribute('aria-label', profile.name);

    const face = document.createElement('div');
    face.className = 'picker-face';
    if (profile.avatar) {
      const img = document.createElement('img');
      img.src = `app-icon://favicon/${profile.avatar}`;
      img.alt = '';
      img.style.borderRadius = '12px';
      face.replaceWith(img);
      img.className = 'picker-face';
      img.addEventListener('error', () => {
        img.replaceWith(face);
        paintFace(face, profile);
      }, { once: true });
      paintFace(img, profile);
      item.append(img);
    } else {
      paintFace(face, profile);
      item.append(face);
    }

    const name = document.createElement('span');
    name.className = 'picker-name';
    name.textContent = profile.name;
    item.append(name);

    if (pickerManageMode) {
      const tools = document.createElement('span');
      tools.className = 'picker-tools';

      const edit = document.createElement('button');
      edit.className = 'picker-tool';
      edit.textContent = '✎';
      edit.title = 'Edit';
      edit.addEventListener('click', (e) => {
        e.stopPropagation();
        openProfileDialog(profile);
      });

      const del = document.createElement('button');
      del.className = 'picker-tool';
      del.textContent = '×';
      del.title = profiles.profiles.length <= 1 ? 'Cannot delete the only profile' : 'Delete';
      del.disabled = profiles.profiles.length <= 1;
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (del.disabled) return;
        deleteProfileFromPicker(profile);
      });

      tools.append(edit, del);
      item.append(tools);
    }

    item.addEventListener('click', () => enterProfile(profile.id));
    item.addEventListener('focus', () => {
      for (const other of el.pickerGrid.querySelectorAll('.picker-item')) {
        other.classList.remove('is-selected');
      }
      item.classList.add('is-selected');
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        enterProfile(profile.id);
      }
    });

    el.pickerGrid.append(item);
  }

  // Netflix puts the add tile at the end of the row.
  const add = document.createElement('button');
  add.className = 'picker-item picker-add';
  add.innerHTML = '<span class="picker-face">+</span><span class="picker-name">Add Profile</span>';
  add.addEventListener('click', () => openProfileDialog(null));
  el.pickerGrid.append(add);
}

function paintFace(node, profile) {
  const hue = profileHue(profile.name);
  if (node.tagName === 'IMG') {
    node.src = `app-icon://favicon/${profile.avatar}`;
    return;
  }
  node.textContent = initials(profile.name);
  node.style.background = `linear-gradient(140deg, hsl(${hue} 56% 48%), hsl(${(hue + 40) % 360} 52% 34%))`;
}

async function enterProfile(id) {
  if (id && id !== profiles.active) {
    profiles = await bridge.activateProfile(id);
  }
  filter = '';
  el.search.value = '';
  selectedUrl = null;
  el.hero.hidden = true;
  hidePicker();
  await load();
}

/** Delete straight from the picker, with an inline confirm on the tile. */
async function deleteProfileFromPicker(profile) {
  const confirmBtn = el.pickerGrid.querySelector(
    `.picker-item[data-id="${profile.id}"] .picker-tool[title="Delete"]`,
  );
  if (confirmBtn && !confirmBtn.classList.contains('is-armed')) {
    confirmBtn.classList.add('is-armed');
    confirmBtn.textContent = '!';
    confirmBtn.title = 'Click again to delete';
    setTimeout(() => {
      if (!confirmBtn.isConnected) return;
      confirmBtn.classList.remove('is-armed');
      confirmBtn.textContent = '×';
      confirmBtn.title = 'Delete';
    }, 4000);
    return;
  }

  profiles = await bridge.deleteProfile(profile.id);
  selectedUrl = null;
  renderPicker();
  toast('Profile deleted');
}

el.pickerManage.addEventListener('click', () => showPicker({ manage: true }));

// The way back to the picker once inside a profile.
el.railProfiles.addEventListener('click', () => showPicker());

/* ---------------------------- profile dialog --------------------------- */

/**
 * Open the profile dialog in create or edit mode.
 *
 * No window.prompt/confirm anywhere here on purpose: Electron implements
 * neither, so they silently do nothing. That made the new-profile button look
 * dead, and a test that stubbed them hid it.
 */
function openProfileDialog(profile) {
  const creating = !profile;
  editingProfileId = creating ? null : profile.id;
  editingProfileAvatar = creating ? null : profile.avatar || null;

  el.profileTitle.textContent = creating ? 'Add Profile' : 'Edit Profile';
  el.profileSave.textContent = creating ? 'Create' : 'Save';
  el.profileName.value = creating ? '' : profile.name;

  const only = !creating && profiles.profiles.length <= 1;
  el.profileDelete.hidden = creating;
  el.profileDelete.disabled = only;
  el.profileDelete.textContent = 'Delete';
  el.profileDelete.classList.remove('is-armed');

  if (creating) {
    el.profileMeta.textContent = 'Starts empty. You can add apps afterwards.';
    el.profileHint.textContent = 'Each profile keeps its own set of apps.';
  } else {
    el.profileMeta.textContent = only
      ? 'This is your only profile, so it cannot be deleted.'
      : `${profile.count} app${profile.count === 1 ? '' : 's'} in this profile.`;
    el.profileHint.textContent = 'The link of an app is never changed by editing it.';
  }

  paintAvatarPreview();
  el.profileEditor.showModal();
  el.profileName.focus();
  el.profileName.select();
}

function paintAvatarPreview() {
  if (editingProfileAvatar) {
    el.profileAvatarPreview.src = `app-icon://favicon/${editingProfileAvatar}`;
  } else {
    el.profileAvatarPreview.removeAttribute('src');
    el.profileAvatarPreview.style.background = '';
  }
}

el.profileAvatarInput.addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  // Bytes rather than a path: a picked File has no usable path once it crosses
  // context isolation.
  let name = null;
  try {
    const bytes = await file.arrayBuffer();
    ({ name } = await bridge.storeIconBytes(bytes, bridge.pathForFile(file)));
  } catch {
    name = null;
  }
  if (name) {
    editingProfileAvatar = name;
    paintAvatarPreview();
  } else {
    toast('That file is not a usable image');
  }
  e.target.value = '';
});

el.profileAvatarClear.addEventListener('click', () => {
  editingProfileAvatar = null;
  paintAvatarPreview();
});

el.profileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = el.profileName.value.trim();

  if (editingProfileId) {
    profiles = await bridge.renameProfile(editingProfileId, name, {
      avatar: editingProfileAvatar,
    });
  } else {
    profiles = await bridge.createProfile(name || undefined);
    if (editingProfileAvatar) {
      profiles = await bridge.setProfileAvatar(profiles.active, editingProfileAvatar);
    }
    filter = '';
    el.search.value = '';
    selectedUrl = null;
  }

  el.profileEditor.close();
  renderPicker();
  await load();
  toast(editingProfileId ? 'Profile saved' : 'Profile created');
});

el.profileCancel.addEventListener('click', () => el.profileEditor.close());

el.profileDelete.addEventListener('click', async () => {
  if (!editingProfileId || profiles.profiles.length <= 1) return;

  // Two-step confirmation in place, since confirm() is unavailable.
  if (!el.profileDelete.classList.contains('is-armed')) {
    el.profileDelete.classList.add('is-armed');
    el.profileDelete.textContent = 'Really delete?';
    setTimeout(() => {
      el.profileDelete.classList.remove('is-armed');
      el.profileDelete.textContent = 'Delete';
    }, 4000);
    return;
  }

  profiles = await bridge.deleteProfile(editingProfileId);
  selectedUrl = null;
  el.profileEditor.close();
  renderPicker();
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
  render();
});

async function load() {
  sites = await bridge.listSites();
  if (!profiles.profiles.length) await loadProfiles();
  setBarMode('launcher');
  await render();
}

// First paint goes through the picker, the way a TV service asks who is
// watching. window.load() later on is the in-app reload and leaves it closed.
(async () => {
  await loadProfiles();
  await load();
  showPicker();
})();