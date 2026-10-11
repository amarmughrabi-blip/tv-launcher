'use strict';

/**
 * Player window: plays a channel, and lets you change your mind.
 *
 * Autoplay is muted because a browser will not start sound without a gesture,
 * and a launcher has no gesture to give. Any input unmutes, so the video starts
 * immediately and the sound follows when the viewer is actually there.
 *
 * The chrome -- back, the list toggle, and the list itself -- hides when the
 * remote is idle and returns on any input, taking the cursor with it. It sits
 * over the picture, so leaving it up for a whole film would spoil the thing it
 * is meant to help with.
 *
 * The list is two slides rather than one long scroll: genres first, then the
 * channels of the chosen genre. Scrolling 453 entries to reach the handful
 * someone wanted is the wrong shape for a TV.
 */

const video = document.getElementById('video');
const problem = document.getElementById('problem');
const problemTitle = document.getElementById('problem-title');
const problemDetail = document.getElementById('problem-detail');
const now = document.getElementById('now');
const nowName = document.getElementById('now-name');
const nowRes = document.getElementById('now-res');
const chrome = document.getElementById('chrome');
const chromeName = document.getElementById('chrome-name');
const channels = document.getElementById('channels');
const toggle = document.getElementById('toggle');
const back = document.getElementById('back');
const slideGenres = document.getElementById('slide-genres');
const slideChannels = document.getElementById('slide-channels');
const slideTitle = document.getElementById('slide-title');
const slideBack = document.getElementById('slide-back');

/** How long the chrome waits before getting out of the way. */
const IDLE_MS = 4000;

let hls = null;
/** Guards against a slow load reporting a problem for a channel that is fine. */
let loadToken = 0;
let idleTimer = null;
let currentUrl = null;
let grouped = [];
let view = 'genres';
let currentGenre = 'all';

function showProblem(title, detail) {
  problemTitle.textContent = title;
  problemDetail.textContent = detail || '';
  problem.hidden = false;
}

function clearProblem() {
  problem.hidden = true;
}

function destroyHls() {
  if (!hls) return;
  try {
    hls.destroy();
  } catch (e) {
    /* already gone */
  }
  hls = null;
}

const FATAL = new Set([
  'networkError',
  'networkManifestLoadError',
  'networkManifestLoadTimeOut',
  'manifestLoadError',
  'manifestParsingError',
  'mediaError',
]);

function load(payload) {
  const token = ++loadToken;
  clearProblem();
  destroyHls();

  const { url, source, name, res } = payload || {};
  if (!url) {
    showProblem('Nothing to play', '');
    return;
  }

  currentUrl = source || url;
  chromeName.textContent = name || '';
  nowName.textContent = name || '';
  nowRes.textContent = res || '';
  now.hidden = false;
  markCurrent();

  clearTimeout(window.__nowTimer);
  window.__nowTimer = setTimeout(() => {
    now.hidden = true;
  }, 2600);

  if (window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true,
      xhrSetup: (xhr) => {
        xhr.withCredentials = false;
      },
    });

    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (token !== loadToken) return;
      if (!data || !data.fatal) return;
      if (!FATAL.has(data.details)) return;
      showProblem('This channel is not playing', data.details);
    });

    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
  } else {
    showProblem('This channel cannot be played here', 'no HLS support in this build');
  }

  wake();
}

video.addEventListener('playing', clearProblem);
video.addEventListener('error', () => {
  const code = video.error && video.error.code;
  if (code === 3 || code === 4) showProblem('This channel is not playing', 'the stream was refused');
});

/* ---------------- slides ---------------- */

function entriesFor(genre) {
  if (genre === 'all') return grouped.flatMap((g) => g.channels);
  const found = grouped.find((g) => g.genre === genre);
  return found ? found.channels : [];
}

function channelRow(channel) {
  const item = document.createElement('button');
  item.className = 'ch';
  item.type = 'button';
  item.dataset.url = channel.url;

  const name = document.createElement('span');
  name.className = 'ch-name';
  name.textContent = channel.name;
  item.appendChild(name);

  if (channel.country) {
    const country = document.createElement('span');
    country.className = 'ch-country';
    country.textContent = channel.country;
    item.appendChild(country);
  }

  item.addEventListener('click', () => {
    window.player.switchChannel(channel.url);
    wake();
  });
  return item;
}

function genreRow(genre, label, count) {
  const item = document.createElement('button');
  item.className = 'ch ch-genre';
  item.type = 'button';
  item.dataset.genre = genre;

  const name = document.createElement('span');
  name.className = 'ch-name';
  name.textContent = label;
  item.appendChild(name);

  const n = document.createElement('span');
  n.className = 'ch-country';
  n.textContent = String(count);
  item.appendChild(n);

  item.addEventListener('click', () => {
    showChannels(genre);
    wake();
  });
  return item;
}

function buildGenres() {
  slideGenres.replaceChildren();
  const all = entriesFor('all').length;
  slideGenres.appendChild(genreRow('all', 'All channels', all));
  for (const { genre, channels: entries } of grouped) {
    slideGenres.appendChild(genreRow(genre, genre, entries.length));
  }
}

function buildChannels(genre) {
  const inner = document.getElementById('channels-inner');
  inner.replaceChildren();
  const entries = entriesFor(genre);
  for (const channel of entries) inner.appendChild(channelRow(channel));
  slideTitle.textContent = genre === 'all' ? 'All channels' : genre;
  markCurrent();
}

/**
 * Which slide is shown is carried by `hidden`, not by a transition reaching its
 * end: an unfocused window can have its animations throttled, and a half-finished
 * slide would leave both lists painted or neither.
 */
function showSlide(next) {
  view = next;
  const genresShown = view === 'genres';
  slideGenres.hidden = !genresShown;
  slideChannels.hidden = genresShown;
  slideGenres.classList.toggle('is-from-right', !genresShown);
  slideChannels.classList.toggle('is-from-right', genresShown);
}

function showChannels(genre) {
  currentGenre = genre || 'all';
  buildChannels(currentGenre);
  showSlide('channels');
  markCurrent();
}

function showGenres() {
  showSlide('genres');
}

slideBack.addEventListener('click', () => {
  showGenres();
  wake();
});

function markCurrent() {
  for (const node of document.querySelectorAll('.ch[data-url]')) {
    const on = node.dataset.url === currentUrl;
    node.classList.toggle('is-current', on);
    if (on && view === 'channels') {
      const inner = document.getElementById('channels-inner');
      inner.scrollTop = Math.max(0, node.offsetTop - inner.clientHeight / 2);
    }
  }
}

function buildList(data) {
  grouped = data || [];
  buildGenres();
  buildChannels(currentGenre);
  showSlide('genres');
}

/* ---------------- chrome behaviour ---------------- */

function setListOpen(open) {
  channels.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? 'Hide channels' : 'Show channels';
  toggle.setAttribute('aria-label', toggle.title);
  if (open) {
    showGenres();
    markCurrent();
  }
}

function wake() {
  chrome.classList.remove('is-idle');
  // The cursor comes back with the controls. Leaving it hidden over the picture
  // makes the player look switched off and hides where the pointer is.
  document.body.classList.remove('is-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    chrome.classList.add('is-idle');
    document.body.classList.add('is-idle');
  }, IDLE_MS);
}

toggle.addEventListener('click', () => {
  setListOpen(channels.hidden);
  wake();
});

back.addEventListener('click', () => window.player.closeSelf());

video.addEventListener('mousemove', wake);

function unmute() {
  if (!video.muted) return;
  video.muted = false;
  video.play().catch(() => {});
  wake();
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    // Back through the slides first, then out. Closing straight away from the
    // channels slide skips a step people expect.
    if (!chrome.classList.contains('is-idle') && view === 'channels') {
      showGenres();
      wake();
      return;
    }
    if (!chrome.classList.contains('is-idle')) {
      chrome.classList.add('is-idle');
      document.body.classList.add('is-idle');
      setListOpen(false);
      return;
    }
    window.player.closeSelf();
    return;
  }
  if (event.key === 'f' || event.key === 'F') {
    event.preventDefault();
    const on = !document.fullscreenElement;
    if (on) document.documentElement.requestFullscreen().catch(() => window.player.setFullscreen(true));
    else document.exitFullscreen();
    return;
  }
  if (event.key === 'm' || event.key === 'M') {
    video.muted = !video.muted;
    event.preventDefault();
    wake();
    return;
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    step(event.key === 'ArrowDown' ? 1 : -1);
    event.preventDefault();
    return;
  }
  if (event.key === 'Enter' || event.key === ' ') {
    unmute();
    wake();
  }
});

/** Move with the arrow keys over whatever slide is showing. */
function step(direction) {
  setListOpen(true);
  const selector = view === 'genres' ? '.ch-genre' : '.ch[data-url]';
  const items = [...document.querySelectorAll(selector)];
  if (!items.length) return;

  if (view === 'genres') {
    const at = items.findIndex((n) => n.dataset.genre === currentGenre);
    const next = items[Math.min(items.length - 1, Math.max(0, at + direction))] || items[0];
    if (direction > 0) {
      showChannels(next.dataset.genre);
      return;
    }
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest' });
    return;
  }

  const at = items.findIndex((n) => n.classList.contains('is-current'));
  const next = items[Math.min(items.length - 1, Math.max(0, at + direction))] || items[0];
  if (next !== items[at]) window.player.switchChannel(next.dataset.url);
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest' });
}

video.addEventListener('click', unmute);

window.player.onLoad(load);
window.player.onChannels((data) => buildList(data));
window.player.report({ ready: true });
wake();