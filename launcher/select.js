'use strict';

/*
 * Wrapped: classic scripts share one global scope and this file declares helpers
 * that app.js and tv.js also declare. Only the entry point is published.
 */
(function () {

/**
 * Selects.
 *
 * A native <select> cannot be themed. Its closed state is a styled box, but the
 * moment it opens, the list is drawn by the operating system in the system
 * colours -- a white dropdown in the middle of a dark settings screen, with no
 * CSS able to reach it and `color-scheme` only ever affecting some of it.
 *
 * So the native element is kept, and the thing you see is built here. Keeping it
 * matters: the form, the keyboard, the value, and every line of existing code
 * that reads `select.value` or listens for `change` keep working exactly as they
 * did. Only the painted parts are ours.
 */

const OPEN_CLASS = 'is-open';

let openMenu = null;

/**
 * Close a list.
 *
 * Takes the wrapper, not the select, because every caller already has one and
 * passing the wrong kind of thing here fails quietly: the wrapper has no
 * `_wrap`, so the function returns having done nothing at all and the list stays
 * on screen after you have chosen from it.
 */
function close(wrap) {
  if (!wrap) return;
  const menu = wrap.querySelector('.select-menu');
  // Hidden as well as un-highlighted: dropping the class alone leaves a
  // fixed-position list painted on top of the screen.
  if (menu) menu.hidden = true;
  wrap.classList.remove(OPEN_CLASS);
  const select = wrap.querySelector('select');
  const trigger = wrap.querySelector('.select-trigger');
  if (select) select.setAttribute('aria-expanded', 'false');
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
}

function closeAny(except) {
  if (openMenu && openMenu !== except) close(openMenu);
  openMenu = null;
}

/** Where the list should sit, so it never runs off the bottom of the screen. */
function placeMenu(wrap, trigger) {
  const menu = wrap.querySelector('.select-menu');
  const rect = trigger.getBoundingClientRect();
  menu.classList.remove('select-up');
  menu.style.maxHeight = '';
  menu.style.left = `${rect.left}px`;
  menu.style.width = `${rect.width}px`;

  // Measured after the width is set, because the decision depends on the height
  // the list will want.
  const wanted = menu.scrollHeight + 12;
  const below = window.innerHeight - rect.bottom;
  const above = rect.top;
  if (below < wanted && above > below) {
    menu.classList.add('select-up');
    menu.style.maxHeight = `${Math.max(120, above - 16)}px`;
  } else {
    menu.style.maxHeight = `${Math.max(120, below - 16)}px`;
  }
}

function sync(select) {
  const wrap = select._wrap;
  if (!wrap) return;
  const trigger = select._trigger;
  const chosen = select.options[select.selectedIndex];
  trigger.querySelector('.select-value').textContent = chosen ? chosen.textContent : '';

  for (const li of wrap.querySelectorAll('.select-option')) {
    const on = li.dataset.value === select.value;
    li.classList.toggle('is-selected', on);
    li.setAttribute('aria-selected', String(on));
  }
}

function build(select) {
  const wrap = document.createElement('div');
  wrap.className = 'select';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'select-trigger';
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-labelledby', select.id ? `${select.id}-label` : null);
  trigger.innerHTML =
    '<span class="select-value"></span>' +
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>';
  wrap.appendChild(trigger);

  const menu = document.createElement('ul');
  menu.className = 'select-menu';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  wrap.appendChild(menu);

  select._wrap = wrap;
  select._trigger = trigger;
  select._menu = menu;

  // Hidden but not display:none, so it keeps its place in the tab order and
  // screen readers still see the real control behind the painted one.
  select.classList.add('select-native');
  select.setAttribute('aria-hidden', 'true');
  select.tabIndex = -1;

  const label = select.id ? document.getElementById(`${select.id}-label`) : null;
  if (label) {
    label.classList.add('field-select');
    wrap.insertBefore(wrap, label);
  }

  select.after(wrap);

  const menuOpen = () => {
    if (wrap.classList.contains(OPEN_CLASS)) return true;
    closeAny(wrap);
    wrap.classList.add(OPEN_CLASS);
    menu.hidden = false;
    select.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-expanded', 'true');
    openMenu = wrap;
    placeMenu(wrap, trigger);
    const current = wrap.querySelector('.select-option.is-selected');
    if (current) current.scrollIntoView({ block: 'nearest' });
    return false;
  };

  trigger.addEventListener('click', () => {
    if (menuOpen()) {
      close(wrap);
      openMenu = null;
    }
  });

  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('.select-option')];
    const at = items.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = Math.min(items.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)));
      if (items[next]) items[next].focus();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close(wrap);
      openMenu = null;
      trigger.focus();
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      (event.key === 'Home' ? items[0] : items[items.length - 1]).focus();
    }
  });

  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      menuOpen();
      const first = menu.querySelector('.select-option.is-selected') || menu.firstElementChild;
      if (first) first.focus();
    }
  });

  // A select filled in later -- the channel editor builds its genre list when it
  // opens -- has to redraw itself.
  const observer = new MutationObserver(() => fill(select));
  observer.observe(select, { childList: true });
  select._observer = observer;

  fill(select);
  return wrap;
}

function fill(select) {
  const wrap = select._wrap;
  if (!wrap) return;
  const menu = wrap.querySelector('.select-menu');
  if (!menu) return;
  menu.replaceChildren();
  // Into the menu, not the wrapper. Appending to the wrapper leaves the options
  // as loose siblings of a fixed-position list, so the list renders empty at zero
  // width and the options spill into the field as stray rows.
  for (const option of select.options) menu.appendChild(buildOption(select, option));
  sync(select);
}

/** One painted row per native option, which stays the thing that holds the value. */
function buildOption(select, option) {
  const li = document.createElement('li');
  li.className = 'select-option';
  li.setAttribute('role', 'option');
  li.textContent = option.textContent;
  li.dataset.value = option.value;
  li.tabIndex = -1;

  li.addEventListener('click', () => {
    select.value = option.value;
    sync(select);
    close(select._wrap);
    select._trigger.focus();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return li;
}

/** Move, close and re-place on scroll and resize, so the menu never floats free. */
function reposition() {
  if (openMenu) placeMenu(openMenu, openMenu.querySelector('.select-trigger'));
}

document.addEventListener('click', (event) => {
  if (openMenu && !openMenu.contains(event.target)) closeAny();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openMenu) {
    const trigger = openMenu.querySelector('.select-trigger');
    closeAny();
    if (trigger) trigger.focus();
  }
});

window.addEventListener('resize', reposition);
window.addEventListener('scroll', reposition, true);

/**
 * Build every select on the page.
 *
 * Returned so a select filled in after startup can be upgraded too, which the
 * channel editor needs: its genre options only exist once the list has loaded.
 */
function mountSelects(root = document) {
  const built = [];
  for (const select of root.querySelectorAll('select')) {
    if (select._wrap) continue;
    build(select);
    built.push(select);
  }
  return built;
}

  window.mountSelects = mountSelects;
})();