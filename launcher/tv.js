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
 * Kept apart from the apps grid on purpose: channels are not editable, not
 * per-profile, and not what the apps search box is for. Mixing them would make
 * one of the three lie about itself.
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
  CH: '#d52b1e', BE2: '#fdda24', CZ: '#d7141a', RO: '#002b7f', HU: '#cd2a3e',
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

function buildTile(channel, onPlay) {
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

  tile.append(face, name);
  tile.addEventListener('click', () => onPlay(channel));
  return tile;
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

function mountTv({ root, grid, genresBar, summaryEl, emptyEl, load, play }) {
  let data = null;
  let active = 'all';

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
      for (const channel of channels) row.appendChild(buildTile(channel, play));

      section.append(heading, row);
      grid.appendChild(section);
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
    paintGenres();
    paint();
  };

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
