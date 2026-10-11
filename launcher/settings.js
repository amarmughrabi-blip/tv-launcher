'use strict';

/*
 * Wrapped like tv.js, and for the same reason: classic scripts share one global
 * scope, and two files each declaring a helper is how the TV grid ended up painted
 * with app tiles once. Only the entry point is published.
 */
(function () {

/**
 * The settings screen.
 *
 * Every control saves the moment it is changed rather than on a Save button.
 * There is no batch to confirm here -- each setting is independent, nothing is
 * validated as a group, and a form that silently discards changes because the
 * dialog was closed is worse than one that just does it.
 *
 * The reasons are written next to the controls. A setting whose effect is not
 * obvious from its name gets changed by accident and then blamed for something
 * else entirely.
 */

/** Two-letter country codes, enough to filter 453 channels by region. */
const COUNTRIES = {
  AE: 'United Arab Emirates', AR: 'Argentina', AT: 'Austria', AU: 'Australia',
  BA: 'Bosnia', BE: 'Belgium', BG: 'Bulgaria', BR: 'Brazil', CA: 'Canada',
  CH: 'Switzerland', CL: 'Chile', CN: 'China', CO: 'Colombia', CZ: 'Czechia',
  DE: 'Germany', DK: 'Denmark', EC: 'Ecuador', EG: 'Egypt', ES: 'Spain',
  FI: 'Finland', FR: 'France', GB: 'United Kingdom', GR: 'Greece', HK: 'Hong Kong',
  HR: 'Croatia', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel',
  IN: 'India', IR: 'Iran', IS: 'Iceland', IT: 'Italy', JO: 'Jordan', JP: 'Japan',
  KE: 'Kenya', KR: 'South Korea', KW: 'Kuwait', LB: 'Lebanon', LK: 'Sri Lanka',
  LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', MA: 'Morocco', MK: 'North Macedonia',
  MT: 'Malta', MX: 'Mexico', MY: 'Malaysia', NG: 'Nigeria', NL: 'Netherlands',
  NO: 'Norway', NZ: 'New Zealand', PE: 'Peru', PH: 'Philippines', PL: 'Poland',
  PT: 'Portugal', QA: 'Qatar', RO: 'Romania', RS: 'Serbia', RU: 'Russia',
  SA: 'Saudi Arabia', SE: 'Sweden', SG: 'Singapore', SI: 'Slovenia', SK: 'Slovakia',
  TH: 'Thailand', TN: 'Tunisia', TR: 'Turkey', TW: 'Taiwan', UA: 'Ukraine',
  US: 'United States', UY: 'Uruguay', VE: 'Venezuela', VN: 'Vietnam', ZA: 'South Africa',
};

function el(id) {
  return document.getElementById(id);
}

function mountSettings({ api, toast, onChannelChange }) {
  const dialog = el('settings-dialog');
  const state = { values: {}, defaults: {}, genres: [] };

  /**
   * Counts saves, so a slow one knows it has been overtaken.
   *
   * Without it, toggling two chips quickly repaints the screen from the first
   * reply and the second chip visibly springs back -- while the setting behind it
   * did save. A form that lies about what is stored is worse than one that lags.
   */
  let saveToken = 0;

  /* ------------------------------ saving ------------------------------ */

  /**
   * Save one change and reflect it.
   *
   * Main returns the whole stored set, which is what gets written back into the
   * form. Values are clamped on the way in, so a typed-in 900 would otherwise
   * leave the field showing 900 while the app was using 72.
   */
  async function save(changes) {
    saveToken += 1;
    const mine = saveToken;
    const result = await api.setSettings(changes);
    if (result && result.settings) {
      state.values = result.settings;
      // Only repaint if this is still the newest answer.
      //
      // Every control saves as it is touched, so two saves are routinely in
      // flight at once. Main merges them and returns the whole stored set each
      // time, so the earlier response carries a value for the field the user has
      // since changed -- and painting it would put the form back the way it was,
      // over a setting that was in fact saved. The screen would then show one
      // thing and the app would do another, which is the worst outcome available.
      if (saveToken === mine) paint();
    }
    return result;
  }

  /* ------------------------------ painting ---------------------------- */

  function chip(text, on, onToggle, title) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chip${on ? ' is-on' : ''}`;
    b.textContent = text;
    if (title) b.title = title;
    b.setAttribute('aria-pressed', String(Boolean(on)));
    b.addEventListener('click', onToggle);
    return b;
  }

  function paintGenres() {
    const box = el('settings-genres');
    box.replaceChildren();
    const hidden = state.values.hiddenGenres || [];

    for (const entry of state.genres) {
      const shown = !hidden.includes(entry.genre);
      box.appendChild(chip(
        `${entry.genre} (${entry.count})`,
        shown,
        () => {
          const next = shown
            ? [...hidden, entry.genre]
            : hidden.filter((g) => g !== entry.genre);
          save({ hiddenGenres: next }).then(onChannelChange);
        },
        shown ? `Hide ${entry.genre} from the TV page` : `Show ${entry.genre}`,
      ));
    }
  }

  function paintRegion() {
    const box = el('settings-region');
    box.replaceChildren();
    const chosen = state.values.region || [];
    const filter = el('set-region-search').value.trim().toLowerCase();

    const codes = Object.keys(COUNTRIES).filter(
      (code) => !filter
        || code.toLowerCase().includes(filter)
        || COUNTRIES[code].toLowerCase().includes(filter),
    );

    if (!codes.length) {
      const none = document.createElement('p');
      none.className = 'settings-empty';
      none.textContent = 'No country matches that.';
      box.appendChild(none);
      return;
    }

    for (const code of codes) {
      const on = chosen.includes(code);
      box.appendChild(chip(`${COUNTRIES[code]} (${code})`, on, () => {
        const next = on ? chosen.filter((c) => c !== code) : [...chosen, code];
        save({ region: next }).then(onChannelChange);
      }));
    }
  }

  function paintExceptions() {
    const box = el('settings-exceptions');
    box.replaceChildren();
    const list = state.values.blockingExceptions || [];

    if (!list.length) {
      const none = document.createElement('p');
      none.className = 'settings-empty';
      none.textContent = 'Nothing excepted. Sites you visit appear here.';
      box.appendChild(none);
      el('set-exception-hint').hidden = true;
      return;
    }

    for (const host of list) {
      const b = chip(host, true, async () => {
        await api.toggleBlockingException(host);
        await refresh();
      });
      b.classList.add('chip-exception');
      box.appendChild(b);
    }
    el('set-exception-hint').textContent = 'Click one to remove it.';
    el('set-exception-hint').hidden = false;
  }

  function paint() {
    const v = state.values;
    el('set-check-schedule').value = v.checkSchedule;
    el('set-dead-days').value = v.deadDays;
    el('set-mute').checked = Boolean(v.muteOnOpen);
    el('set-quality').value = v.maxQuality;
    el('set-audio').value = v.audioLanguage;
    el('set-subtitles').value = v.subtitles;
    el('set-subtitle-size').value = v.subtitleSize;
    el('set-subtitle-size-out').textContent = `${v.subtitleSize}px`;
    el('set-blocking').checked = Boolean(v.adBlocking);
    el('set-cosmetics').checked = Boolean(v.hideInPageAds);

    paintGenres();
    paintRegion();
    paintExceptions();
  }

  /**
   * Load the settings and draw them.
   *
   * Never throws. This runs after the dialog is already on screen, so a failure
   * here leaves the viewer looking at a menu -- and the right thing to do with
   * that is say what went wrong, not disappear silently back to the launcher,
   * which is indistinguishable from the button not working.
   */
  async function refresh() {
    try {
      const data = await api.settings();
      state.values = data.settings || {};
      state.defaults = data.defaults || {};
      state.genres = data.genres || [];
      paint();
      setProblem('');
    } catch (err) {
      setProblem(`Settings could not be read: ${err && err.message ? err.message : err}`);
    }
  }

  function setProblem(text) {
    const box = el('settings-problem');
    if (!box) return;
    box.textContent = text || '';
    box.hidden = !text;
  }

  /* ------------------------------ wiring ----------------------------- */

  function wire() {
    // Tabs.
    el('settings-tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('.settings-tab');
      if (!tab) return;
      for (const t of dialog.querySelectorAll('.settings-tab')) {
        t.classList.toggle('is-active', t === tab);
      }
      for (const s of dialog.querySelectorAll('.settings-section')) {
        s.classList.toggle('is-active', s.dataset.section === tab.dataset.section);
      }
    });

    el('settings-close').addEventListener('click', () => dialog.close());

    el('settings-reset').addEventListener('click', async () => {
      await api.resetSettings();
      await refresh();
      onChannelChange();
      toast('Settings back to their defaults');
    });

    el('set-check-schedule').addEventListener('change', (e) => save({ checkSchedule: e.target.value }));
    // Saved on change rather than every keystroke: an intermediate value would
    // otherwise be written on the way to a real one.
    el('set-dead-days').addEventListener('change', (e) => save({ deadDays: Number(e.target.value) }));

    el('set-mute').addEventListener('change', (e) => save({ muteOnOpen: e.target.checked }));
    el('set-quality').addEventListener('change', (e) => save({ maxQuality: e.target.value }));
    el('set-audio').addEventListener('change', (e) => save({ audioLanguage: e.target.value }));
    el('set-subtitles').addEventListener('change', (e) => save({ subtitles: e.target.value }));
    el('set-subtitle-size').addEventListener('input', (e) => {
      el('set-subtitle-size-out').textContent = `${e.target.value}px`;
    });
    el('set-subtitle-size').addEventListener('change', (e) => save({ subtitleSize: Number(e.target.value) }));

    el('set-blocking').addEventListener('change', (e) => save({ adBlocking: e.target.checked }));
    el('set-cosmetics').addEventListener('change', (e) => save({ hideInPageAds: e.target.checked }));

    el('set-region-search').addEventListener('input', paintRegion);

    el('set-exception-add').addEventListener('click', async () => {
      const input = el('set-exception-input');
      const host = input.value.trim();
      if (!host) return;
      const result = await api.toggleBlockingException(host);
      input.value = '';
      if (result && result.ok) await refresh();
      else toast(result && result.error ? result.error : 'Could not add that');
    });
  }

  wire();

  return {
    /**
     * Open the screen.
     *
     * The dialog goes up first and the contents follow. It used to load the
     * settings and only then show, which meant a slow or failing round-trip to
     * main left the button doing nothing at all -- the viewer clicked Settings
     * and got no menu and no explanation, which reads as a broken app rather than
     * a failed request.
     */
    open: (section) => {
      if (!dialog.open) {
        setProblem('');
        dialog.showModal();
      }
      if (section) {
        const tab = dialog.querySelector(`.settings-tab[data-section="${section}"]`);
        if (tab) tab.click();
      }
      refresh();
    },
  };
}

  window.mountSettings = mountSettings;
})();