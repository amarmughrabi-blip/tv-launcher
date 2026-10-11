'use strict';

/*
 * Wrapped deliberately. Classic scripts share a single global scope, and
 * app.js declares its own buildTile -- which then overwrote this file's and
 * quietly painted the whole TV grid with app tiles instead. Everything
 * stays private; only the entry point is published.
 */
(function () {

/*
 * The TV grid.
 *
 * Kept apart from the apps grid on purpose: channels are not per-profile, and
 * they are not what the apps search box is for. Mixing them would make one of
 * the three lie about itself.
 *
 * Managing them happens here rather than in a settings screen, because a channel
 * is only ever managed because somebody is looking at it. A pencil sits on each
 * tile, a channel added by hand lands in the new-channel pile at the top until
 * it is filed somewhere better, and anything hidden can be brought back from
 * the same page.
 *
 * Logos: none of the source data carries any, so tiles are drawn from the
 * channel name and country rather than fetching an icon that is not there. If
 * real logos turn up later the <img> path already exists.
 */

const countryColour = {
  QA: '#8a1538', US: '#1f3a93', GB: '#012169', DE: '#000000', FR: '#002395',
  ES: '#aa151b', IT: '#008c45', PT: '#046a38', NL: '#ae1c28', RU: '#0039a6',
  CA: '#d80621', AU: '#012169', NZ: '#00247d', JP: '#bc002d', KR: '#003478',
  CN: '#de2910', IN: '#ff9933', BR: '#009c3b', AR: '#74acdf', MX: '#006847',
  TR: '#e30a17', GR: '#0d5eaf', PL: '#dc143c', SE: '#006aa7', NO: '#ba0c2f',
  DK: '#c8102e', FI: '#003580', IE: '#169b62', BE: '#fdda24', AT: '#ed2939',
  CH: '#d52b1e', CZ: '#d7141a', RO: '#002b7f', HU: '#cd2a3e',
  UA: '#005bbb', ZA: '#007a4d', NG: '#008751', EG: '#ce1126', SA: '#006c35',
  AE: '#00732f', IL: '#0038b8', IR: '#239f40', MA: '#c1272d', TN: '#e70013',
  AL: '#e41e20', BA: '#002395', MK: '#d20000', RS: '#c6363c', BG: '#00966e',
  LT: '#fdb913', LV: '#9e3039', EE: '#0072ce', IS: '#02529c', LU: '#ed2939',
};

/** Stable colour per country so the grid reads as a set, not as noise. */
function colourFor(country) {
  if (!country) return '#3a4152';
  if (countryColour[country]) return countryColour[country];
  // Unknown code: derive something stable from it rather than picking randomly,
  // so the same channel keeps the same tile on every launch.
  let hash = 0;
  for (let i = 0; i < country.length; i += 1) hash = (hash * 31 + country.charCodeAt(i)) % 360;
  return `hsl(${hash} 34% 32%)`;
}

function initials(name) {
  const words = String(name)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** "1920x1080" -> "1080p". Stripping the separator gave "19201080". */
function shortRes(res) {
  if (!res) return null;
  const match = /(\d+)\s*[x×]\s*(\d+)/i.exec(String(res));
  if (!match) return String(res);
  const height = Number(match[2]);
  return height >= 720 ? `${height}p` : `${height}`;
}

function makeMark(channel) {
  const mark = document.createElement('span');
  mark.className = 'tv-mark';
  mark.textContent = initials(channel.name);
  return mark;
}

/** Turn a channel into a clickable, editable tile. */
function buildTile(channel, handlers) {
  const tile = document.createElement('button');
  tile.className = 'tv-tile';
  tile.type = 'button';
  tile.dataset.url = channel.url;
  tile.title = `${channel.name}${channel.country ? ` (${channel.country})` : ''}`;
  tile.setAttribute('aria-label', `Watch ${channel.name}`);

  const face = document.createElement('div');
  face.className = 'tv-face';
  face.style.background = colourFor(channel.country);

  if (channel.logo) {
    const img = document.createElement('img');
    img.className = 'tv-logo';
    img.src = `app-icon://favicon/${channel.logo}`;
    img.alt = '';
    img.addEventListener('error', () => {
      // A logo that will not load must not leave a broken tile behind.
      img.remove();
      face.appendChild(makeMark(channel));
    });
    face.appendChild(img);
  } else {
    face.appendChild(makeMark(channel));
  }

  // The resolution sits on the corner of the face, not on the initials. As a
  // child of the mark it was absolutely positioned over the letters and both
  // became unreadable.
  const res = shortRes(channel.res);
  if (res) {
    const tag = document.createElement('i');
    tag.className = 'tv-res';
    tag.textContent = res;
    face.appendChild(tag);
  }

  const name = document.createElement('span');
  name.className = 'tv-name';
  name.textContent = channel.name;

  // A pencil rather than a right-click: on a television there is no right
  // button to speak of, and a channel that can only be edited by right-clicking
  // cannot be edited at all.
  const pencil = document.createElement('span');
  pencil.className = 'tv-pencil';
  pencil.setAttribute('role', 'button');
  pencil.tabIndex = 0;
  pencil.title = `Edit ${channel.name}`;
  pencil.setAttribute('aria-label', `Edit ${channel.name}`);
  pencil.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/></svg>';
  pencil.addEventListener('click', (event) => {
    event.stopPropagation();
    handlers.edit(channel);
  });
  pencil.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    event.stopPropagation();
    handlers.edit(channel);
  });

  if (channel.source === 'added') tile.classList.add('is-added');

  tile.append(face, name, pencil);
  tile.addEventListener('click', () => handlers.play(channel));
  return tile;
}

/* ------------------------------ the page ------------------------------ */

const WHO_HINT = {
  unchecked: 'Channels nobody has opened yet. These are the ones doing nothing for you.',
  failed: 'Channels that have failed before, for a second opinion on ones already on their way out.',
  all: 'Every channel in the list. This is a lot of requests.',
};

const DEPTH_HINT = {
  quick: "Fetches each channel's playlist only. Catches dead hosts and missing streams.",
  deep: 'Also fetches the first video segment. Slower, and the only way to be sure a channel that answers is actually watchable.',
};

const WHY = {
  dns: 'the stream address no longer exists',
  refused: 'nothing is listening there',
  gone: 'the stream has been taken down',
  notManifest: 'there is no stream at that address',
  noSegments: 'the channel is not broadcasting',
  timeout: 'it did not respond in time',
  reset: 'the connection dropped',
  blocked: 'the broadcaster refused this, which usually means a regional block',
  unreachable: 'the address cannot be reached from here',
  server: 'the broadcaster had a server problem',
  refusedPlay: 'the stream started but would not play',
  unknown: 'something went wrong',
};

function why(reason) {
  return WHY[reason] || WHY.unknown;
}

function mountTv({ root, grid, genresBar, summaryEl, emptyEl, load, play, api, toast }) {
  const els = {
    hiddenToggle: document.getElementById('tv-hidden-toggle'),
    hiddenPanel: document.getElementById('tv-hidden'),
    hiddenRow: document.getElementById('tv-hidden-row'),
    sweepOpen: document.getElementById('tv-sweep'),
    addOpen: document.getElementById('tv-add'),
  };

  let data = null;
  let active = 'all';
  let showHidden = false;

  /* ------------------------------ painting ---------------------------- */

  const paint = () => {
    grid.replaceChildren();
    if (!data || !data.grouped.length) {
      emptyEl.hidden = false;
      grid.hidden = true;
      return;
    }
    emptyEl.hidden = true;
    grid.hidden = false;

    const sections = active === 'all'
      ? data.grouped
      : data.grouped.filter((g) => g.genre === active);

    for (const { genre, channels } of sections) {
      const section = document.createElement('section');
      section.className = 'tv-section';

      const heading = document.createElement('h2');
      heading.className = 'row-label';
      heading.textContent = `${genre} · ${channels.length}`;

      const row = document.createElement('div');
      row.className = 'tv-row';
      for (const channel of channels) row.appendChild(buildTile(channel, handlers));

      section.append(heading, row);
      grid.appendChild(section);
    }
  };

  const paintHidden = () => {
    const list = (data && data.hidden) || [];
    els.hiddenPanel.hidden = !showHidden || !list.length;
    if (els.hiddenPanel.hidden) return;

    els.hiddenRow.replaceChildren();
    for (const channel of list) {
      const item = document.createElement('div');
      item.className = 'tv-hidden-item';
      item.dataset.url = channel.url;

      const face = document.createElement('div');
      face.className = 'tv-face tv-face-small';
      face.style.background = colourFor(channel.country);
      face.appendChild(makeMark(channel));

      const text = document.createElement('div');
      text.className = 'tv-hidden-text';
      const title = document.createElement('strong');
      title.textContent = channel.name;
      const whyLine = document.createElement('span');
      // The stored reason is the last thing seen, not a verdict: say which, and
      // be honest that it may have been a bad moment rather than a dead stream.
      whyLine.textContent = `last seen failing: ${why(channel.reason)}`;
      text.append(title, whyLine);

      const restore = document.createElement('button');
      restore.type = 'button';
      restore.className = 'btn btn-small';
      restore.textContent = 'Put back';
      restore.addEventListener('click', async () => {
        restore.disabled = true;
        restore.textContent = 'Putting back…';
        await api.restoreChannel(channel.url);
        await loadData();
        toast(`${channel.name} is back in the grid`);
      });

      item.append(face, text, restore);
      els.hiddenRow.appendChild(item);
    }
  };

  const paintGenres = () => {
    genresBar.replaceChildren();
    if (!data || !data.grouped.length) return;

    const make = (key, label, count) => {
      const b = document.createElement('button');
      b.className = 'tv-genre';
      b.type = 'button';
      b.dataset.genre = key;
      b.setAttribute('aria-selected', String(key === active));
      b.classList.toggle('is-active', key === active);
      b.textContent = count ? `${label} ${count}` : label;
      b.addEventListener('click', () => {
        active = key;
        paintGenres();
        paint();
        grid.scrollIntoView({ block: 'start' });
      });
      return b;
    };

    genresBar.appendChild(make('all', 'All', data.summary.live));
    for (const { genre, channels } of data.grouped) {
      genresBar.appendChild(make(genre, genre, channels.length));
    }
  };

  const paintTools = () => {
    const hidden = (data && data.summary.hidden) || 0;
    els.hiddenToggle.textContent = showHidden ? 'Hide the hidden' : `${hidden} hidden`;
    els.hiddenToggle.hidden = hidden === 0;
    els.hiddenToggle.classList.toggle('is-active', showHidden);
    els.hiddenToggle.setAttribute('aria-pressed', String(showHidden));
  };

  const loadData = async () => {
    data = await load();
    if (data.summary.hidden > 0) {
      summaryEl.textContent =
        `${data.summary.hidden} of ${data.summary.total} channels are hidden because they stopped working.`;
      summaryEl.hidden = false;
    } else {
      summaryEl.hidden = true;
    }
    // Keep the current genre if it still exists, so a reload does not throw the
    // viewer back to "All".
    if (active !== 'all' && !data.grouped.some((g) => g.genre === active)) active = 'all';
    paintTools();
    paintGenres();
    paint();
    paintHidden();
  };

  /* ------------------------- adding and filing ------------------------ */

  const dialog = document.getElementById('channel-editor');
  const form = document.getElementById('channel-form');
  const fName = document.getElementById('channel-name');
  const fUrl = document.getElementById('channel-url');
  const fGenre = document.getElementById('channel-genre');
  const fCountry = document.getElementById('channel-country');
  const fRes = document.getElementById('channel-res');
  const fTitle = document.getElementById('channel-title');
  const fError = document.getElementById('channel-error');
  const fRemove = document.getElementById('channel-remove');
  const fHint = document.getElementById('channel-genre-hint');

  let editing = null;

  function fillGenres(selected) {
    const genres = [...new Set([...(data && data.genres ? data.genres : []), ...genresInList()])];
    fGenre.replaceChildren();
    for (const genre of genres) {
      const option = document.createElement('option');
      option.value = genre;
      option.textContent = genre;
      fGenre.appendChild(option);
    }
    if (selected) fGenre.value = selected;
  }

  function genresInList() {
    if (!data) return [];
    return data.grouped.map((g) => g.genre);
  }

  function say(message) {
    fError.textContent = message;
    fError.hidden = !message;
  }

  function openEditor(channel) {
    editing = channel || null;
    say('');
    fRemove.disabled = false;
    if (channel) {
      fTitle.textContent = 'Edit channel';
      fillGenres(channel.genre);
      fHint.innerHTML = 'Moving a channel here is how it gets out of <strong>new channel</strong>.';
    } else {
      fTitle.textContent = 'Add channel';
      fillGenres(data ? data.newGenre : null);
      fHint.innerHTML =
        `New channels start in <strong>${data ? data.newGenre : 'new channel'}</strong> until you file them somewhere better.`;
    }
    fName.value = channel ? channel.name : '';
    fUrl.value = channel ? channel.url : '';
    fCountry.value = channel && channel.country ? channel.country : '';
    fRes.value = channel && channel.res ? channel.res : '';
    dialog.showModal();
    fName.focus();
  }

  els.addOpen.addEventListener('click', () => openEditor(null));

  document.getElementById('channel-cancel').addEventListener('click', () => dialog.close());

  fRemove.addEventListener('click', async () => {
    if (!editing) return;
    const name = editing.name;
    const result = await api.removeChannel(editing.url);
    dialog.close();
    if (!result.ok) {
      toast(result.error || 'Could not remove that channel');
      return;
    }
    await loadData();
    toast(`Removed ${name}. Importing the list again will bring it back if it came from there.`);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const record = {
      name: fName.value.trim(),
      url: fUrl.value.trim(),
      genre: fGenre.value,
      country: fCountry.value.trim().toUpperCase(),
      res: fRes.value.trim(),
    };
    if (!record.name) return say('Give it a name.');
    if (!record.url) return say('Give it a stream link.');

    const result = editing
      ? await api.updateChannel(editing.url, record)
      : await api.addChannel(record);

    if (!result.ok) {
      say(result.error || 'That did not work.');
      return;
    }
    dialog.close();
    await loadData();
    toast(editing ? `Saved ${result.channel.name}` : `Added ${result.channel.name} to ${result.channel.genre}`);
  });

  /* --------------------------- hidden list --------------------------- */

  els.hiddenToggle.addEventListener('click', () => {
    showHidden = !showHidden;
    paintTools();
    paintHidden();
    if (showHidden) els.hiddenPanel.scrollIntoView({ block: 'nearest' });
  });

  /* ----------------------------- checking ---------------------------- */

  const sweepDialog = document.getElementById('sweep-dialog');
  const sweepWhich = document.getElementById('sweep-which');
  const sweepDepth = document.getElementById('sweep-depth');
  const sweepWhichHint = document.getElementById('sweep-which-hint');
  const sweepDepthHint = document.getElementById('sweep-depth-hint');
  const sweepProgress = document.getElementById('sweep-progress');
  const sweepResult = document.getElementById('sweep-result');
  const sweepCounts = document.getElementById('sweep-counts');
  const sweepLists = document.getElementById('sweep-lists');
  const sweepStart = document.getElementById('sweep-start');
  const sweepApply = document.getElementById('sweep-apply');
  const sweepCancel = document.getElementById('sweep-cancel');

  let sweepToken = null;

  function chosen(group, name) {
    const picked = sweepDialog.querySelector(`input[name="${name}"]:checked`);
    return picked ? picked.value : null;
  }

  function wireChoices() {
    sweepWhich.addEventListener('change', () => {
      sweepWhichHint.textContent = WHO_HINT[chosen('sweep-which', 'which')] || '';
    });
    sweepDepth.addEventListener('change', () => {
      sweepDepthHint.textContent = DEPTH_HINT[chosen('sweep-depth', 'depth')] || '';
    });
  }

  function showOutcome(result) {
    sweepResult.hidden = false;
    sweepToken = result.token;

    const bits = [`${result.checked} checked`, `${result.live} still answering`];
    if (result.failing) bits.push(`${result.failing} not answering`);
    if (result.recovered) bits.push(`${result.recovered} recovered`);
    if (result.uncertain) bits.push(`${result.uncertain} could not be judged`);
    if (result.wouldHide) bits.push(`${result.wouldHide} would be hidden`);
    sweepCounts.textContent = bits.join(' · ');

    sweepLists.replaceChildren();
    const section = (title, entries, note) => {
      const h = document.createElement('h3');
      h.className = 'sweep-subhead';
      h.textContent = `${title} (${entries.length})`;
      const p = document.createElement('p');
      p.className = 'sweep-note';
      p.textContent = note;
      const list = document.createElement('ul');
      list.className = 'sweep-list';
      for (const entry of entries.slice(0, 60)) {
        const li = document.createElement('li');
        const strikes = entry.wouldHide ? '' : ` — failure ${entry.previousFails + 1} of 3`;
        li.textContent = `${entry.name} — ${why(entry.reason)}${strikes}`;
        list.appendChild(li);
      }
      if (entries.length > 60) {
        const more = document.createElement('p');
        more.className = 'sweep-note';
        more.textContent = `…and ${entries.length - 60} more.`;
        sweepLists.append(h, p, list, more);
        return;
      }
      sweepLists.append(h, p, list);
    };

    if (result.hiding.length) {
      section(
        'Would be hidden',
        result.hiding,
        'Each of these has failed three times in a row and has genuinely gone. They can all be put back afterwards.',
      );
    }

    if (result.failingList.length) {
      section(
        'Not answering, not yet hidden',
        result.failingList,
        'One failure is usually a bad moment rather than a dead channel, so nothing is hidden until it has failed three times in a row. Check again later and these will have earned their place.',
      );
    }

    if (result.uncertainList.length) {
      section(
        'Could not be judged',
        result.uncertainList,
        'These timed out, were refused, or could not be reached. They are left exactly as they were — a block or a bad network looks the same from here, and neither is a dead channel.',
      );
    }

    if (!result.hiding.length && !result.failingList.length && !result.uncertainList.length) {
      const note = document.createElement('p');
      note.className = 'sweep-note';
      note.textContent = 'Everything answered. Nothing to hide.';
      sweepLists.appendChild(note);
    }

    // The button is always there once there is a result, because recording the
    // failures is how a strike is banked. Offering it only when something is at
    // three strikes would mean a strike is banked only on the run that hides --
    // so the first check would save the first failure, and a second and third
    // could never exist.
    sweepApply.hidden = false;
    // The submit handler disables this to stop a double click. Nothing was ever
    // re-enabling it, so after the first save the button stayed dead for the rest
    // of the session and no further check could ever be applied.
    sweepApply.disabled = false;
    sweepApply.textContent = result.wouldHide
      ? `Hide ${result.wouldHide} channel${result.wouldHide === 1 ? '' : 's'}`
      : 'Save results';
    sweepStart.textContent = 'Check again';
  }

  els.sweepOpen.addEventListener('click', () => {
    sweepResult.hidden = true;
    sweepProgress.hidden = true;
    sweepApply.hidden = true;
    sweepApply.disabled = false;
    sweepStart.textContent = 'Check';
    sweepToken = null;
    sweepDialog.showModal();
  });

  wireChoices();

  api.onSweepProgress(({ done, total, name }) => {
    if (done <= 0) return;
    sweepProgress.hidden = false;
    sweepProgress.textContent = `Checking ${done} of ${total} — ${name}`;
  });

  sweepStart.addEventListener('click', async () => {
    sweepStart.disabled = true;
    sweepApply.hidden = true;
    sweepResult.hidden = true;
    sweepProgress.hidden = false;
    sweepProgress.textContent = 'Starting…';

    const result = await api.startSweep({
      which: chosen('sweep-which', 'which'),
      deep: chosen('sweep-depth', 'depth') === 'deep',
    });
    sweepStart.disabled = false;

    if (!result.ok) {
      sweepProgress.textContent = result.error || 'The check could not finish.';
      return;
    }
    sweepProgress.hidden = true;
    showOutcome(result);
  });

  sweepCancel.addEventListener('click', async () => {
    // Cancelling must make a run in flight unappliable, not just close the box.
    if (sweepToken !== null) await api.cancelSweep();
    sweepDialog.close();
  });

  sweepDialog.addEventListener('close', async () => {
    if (sweepToken !== null) await api.cancelSweep();
    sweepToken = null;
  });

  sweepDialog.addEventListener('submit', async (event) => {
    event.preventDefault();
    sweepApply.disabled = true;
    const result = await api.applySweep(sweepToken);
    if (!result.ok) {
      sweepApply.disabled = false;
      toast(result.error || 'Could not apply that check');
      return;
    }
    sweepToken = null;
    sweepDialog.close();
    await loadData();
    // A check that hid nothing is still worth saying something about: the
    // failures are banked, and saying "0 hidden" would read as nothing happening.
    toast(result.hidden
      ? `Hidden ${result.hidden} channel${result.hidden === 1 ? '' : 's'}`
      : 'Saved. Nothing was hidden yet.');
  });

  /* ------------------------------ wiring ----------------------------- */

  const handlers = { play, edit: openEditor };

  return {
    show: () => {
      root.hidden = false;
      if (!data) loadData();
      else paint();
    },
    hide: () => {
      root.hidden = true;
    },
    loadData,
  };
}

  window.mountTv = mountTv;
})();