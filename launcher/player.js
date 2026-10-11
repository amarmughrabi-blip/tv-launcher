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
const problemCounted = document.getElementById('problem-counted');
const problemRetry = document.getElementById('problem-retry');
const problemHide = document.getElementById('problem-hide');

/** How long the chrome waits before getting out of the way. */
const IDLE_MS = 4000;

let hls = null;
/** Guards against a slow load reporting a problem for a channel that is fine. */
let loadToken = 0;
let idleTimer = null;
let currentUrl = null;
let grouped = [];
let view = 'genres';
let loadCount = 0;
let lastError = null;
let fatalSeen = null;

/** Playback preferences, as last sent by main. */
let prefs = {
  muteOnOpen: true,
  maxQuality: '720',
  audioLanguage: 'en',
  subtitles: 'off',
  subtitleSize: 22,
};

/** Levels hls.js reports, kept so the cap can be re-applied when they change. */
let levels = [];

/** The pixel height of each level, used to turn the "720" setting into a level. */
function heightFor(level) {
  if (!level || !level.height) return 0;
  if (Array.isArray(level.height)) return Math.max(...level.height);
  return Number(level.height) || 0;
}

/**
 * The highest level the cap allows.
 *
 * hls.js counts levels up from the lowest, so the cap is an index rather than a
 * height. Picking the lowest index whose height is within the cap is what keeps
 * a "720p" preference from quietly selecting a 1080p rendition.
 */
function cappedIndex() {
  const cap = Number(prefs.maxQuality);
  if (!Number.isFinite(cap) || cap <= 0) return -1;
  let best = -1;
  for (let i = 0; i < levels.length; i += 1) {
    const height = heightFor(levels[i]);
    if (height && height <= cap) best = i;
  }
  return best;
}

function applyQualityCap() {
  if (!hls) return;
  const want = cappedIndex();
  // -1 is hls.js's "no cap", which is also what "auto" means here.
  hls.autoLevelCapping = want;
  if (want >= 0 && hls.currentLevel !== want) hls.currentLevel = want;
}

/**
 * Pick the audio track.
 *
 * Only when the channel offers a choice. A channel with one audio track is left
 * in whatever language it broadcasts -- forcing "English" onto a stream whose
 * only audio is Arabic would pick no track at all and play silence.
 */
function applyAudioLanguage() {
  if (!hls || !Array.isArray(hls.audioTracks) || hls.audioTracks.length < 2) return;
  const wanted = String(prefs.audioLanguage || '')
    .split(',')
    .map((code) => code.trim().toLowerCase())
    .filter(Boolean);

  for (const code of wanted) {
    const at = hls.audioTracks.findIndex(
      (track) => String(track.lang || '').toLowerCase().startsWith(code),
    );
    if (at >= 0 && at !== hls.audioTrack) {
      hls.audioTrack = at;
      return;
    }
  }
}

function applySubtitles() {
  if (!hls) return;
  const mode = prefs.subtitles;
  // 'auto' shows subtitles when the track's own language matches the player
  // language. Off switches them off whatever they are. On asks for the first
  // track, and is a no-op on a channel that carries none -- which is most of
  // them, and is why it is not the default.
  if (mode === 'off') {
    hls.subtitleDisplay = false;
    hls.subtitleTrack = -1;
    return;
  }
  hls.subtitleDisplay = true;
  if (mode === 'on' && hls.subtitleTrack === -1 && Array.isArray(hls.subtitleTracks) && hls.subtitleTracks.length) {
    hls.subtitleTrack = 0;
  }
  document.documentElement.style.setProperty('--subtitle-size', `${Number(prefs.subtitleSize) || 22}px`);
}

function applyPrefs() {
  if (!hls) return;
  applyQualityCap();
  applyAudioLanguage();
  applySubtitles();
}
let currentGenre = 'all';

let lastFailed = null;

function showProblem(title, detail) {
  problemTitle.textContent = title;
  problemDetail.textContent = detail || 'Checking…';
  problem.hidden = false;
}

/**
 * Replace the vague error with what actually went wrong, and say whether it was
 * counted. A geo-block that silently hid the channel would be the worst outcome,
 * so the viewer is told when a failure was ignored.
 */
function showDiagnosis({ reason, counted, fails, hidden, message }) {
  lastFailed = currentUrl;
  problemDetail.textContent = message || 'Something went wrong with this stream.';

  if (counted) {
    problemCounted.textContent = hidden
      ? 'It has failed enough times that it is now hidden from the grid.'
      : `Failure ${fails} of 3 before it is hidden.`;
    problemCounted.hidden = false;
  } else if (reason) {
    problemCounted.textContent = 'Not counted — this may be temporary, or blocked where you are.';
    problemCounted.hidden = false;
  } else {
    problemCounted.hidden = true;
  }

  // Only worth offering to hide something that is genuinely broken.
  problemHide.hidden = !counted;
  problem.hidden = false;
  wake();
}

problemRetry.addEventListener('click', () => {
  if (lastFailed) window.player.retry(lastFailed);
  wake();
});

problemHide.addEventListener('click', async () => {
  if (!lastFailed) return;
  const row = document.querySelector(`.ch[data-url="${cssEscape(lastFailed)}"]`);
  if (row) row.remove();
  await window.player.hideChannel(lastFailed);
  problemHide.disabled = true;
  problemCounted.hidden = false;
  problemCounted.textContent = 'Hidden. It will not be offered again.';
  wake();
});

/**
 * Clear the error panel completely.
 *
 * The verdict line has to go with it. Left in place, the next channel's panel
 * would carry the previous one's verdict until its own answer arrived -- which
 * reads as "this channel failed once" for a channel that has not failed at all.
 */
function clearProblem() {
  problem.hidden = true;
  problemCounted.hidden = true;
  problemHide.hidden = true;
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
  loadCount += 1;
  clearProblem();
  destroyHls();
  // The error panel talks about a specific channel; a switch invalidates it.
  lastFailed = null;
  if (problemHide) problemHide.disabled = false;

  const { url, source, name, res } = payload || {};
  if (!url) {
    showProblem('Nothing to play', '');
    return;
  }

  currentUrl = source || url;
  // On by default, because a browser will not start unmuted without a gesture
  // and a channel making noise the moment it is touched is nobody's idea of a
  // television. Turned off in settings, a channel still needs a first interaction.
  video.muted = true;
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

    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      levels = hls.levels || [];
      applyPrefs();
    });
    hls.on(window.Hls.Events.LEVEL_SWITCHED, (_event, data) => {
      levels = hls.levels || [];
      // The cap is re-checked rather than trusted: a channel that only reveals a
      // lower rendition after the first segment would otherwise stay on the
      // highest one it offered at startup.
      const cap = Number(prefs.maxQuality);
      if (Number.isFinite(cap) && cap > 0 && heightFor(levels[data.level]) > cap) {
        const want = cappedIndex();
        if (want >= 0 && hls.currentLevel !== want) hls.currentLevel = want;
      }
    });
    hls.on(window.Hls.Events.AUDIO_TRACKS_UPDATED, applyAudioLanguage);
    hls.on(window.Hls.Events.SUBTITLE_TRACKS_UPDATED, applySubtitles);

    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (token !== loadToken) return;
      if (!data || !data.fatal) return;
      fatalSeen = data.details || 'unknown';
      if (!FATAL.has(data.details)) return;
      // The page cannot say why -- hls.js reports one "network error" for a
      // missing host, a timeout and a geo-block alike. Main checks for itself and
      // answers, so the words on screen are worth reading.
      showProblem('This channel isn’t playing', 'Checking what happened…');
      problemCounted.hidden = true;
      problemHide.hidden = true;
      wake();
      window.player.failed(currentUrl);
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

/**
 * A channel that plays clears its run of failures, so nothing is ever hidden for
 * failures that were followed by a good one.
 */
video.addEventListener('playing', () => {
  clearProblem();
  if (currentUrl) window.player.playing(currentUrl);
});

video.addEventListener('error', () => {
  const code = video.error && video.error.code;
  if (code === 3 || code === 4) {
    showProblem('This channel isn’t playing', 'Checking what happened…');
    window.player.failed(currentUrl);
  }
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

/**
 * Playback preferences arriving from main.
 *
 * Applied to the live stream, not just the next one: a quality cap that only
 * took effect on the next channel would leave the current one playing at the old
 * setting, which is the opposite of what "apply now" means to somebody who just
 * changed it.
 */
window.player.onSettings((value) => {
  if (!value) return;
  const wasMuted = video.muted;
  prefs = { ...prefs, ...value };

  // Muting on open only governs what happens when a channel starts. Somebody
  // already unmuting a channel must not be silenced by a setting they did not
  // just touch.
  if (prefs.muteOnOpen && !video.currentTime) video.muted = true;
  else if (!prefs.muteOnOpen && wasMuted) video.muted = false;

  applyPrefs();
  wake();
});

window.player.onLoad(load);
window.player.onChannels((data) => buildList(data));

/**
 * Main's verdict on the last failure. It arrives after the page has already said
 * something is wrong, and replaces that with the reason and whether it counted.
 */
window.player.onExplained((detail) => {
  // An answer about a channel that is no longer on screen is not worth showing.
  if (detail.url !== currentUrl) return;
  showDiagnosis(detail);
  if (detail.hidden) {
    // The tile is going. Take it out of the list so it cannot be picked again
    // while this window is open.
    document.querySelector(`.ch[data-url="${cssEscape(detail.url)}"]`)?.remove();
  }
});

/** `CSS.escape` is not in every build, and a URL can hold a quote. */
function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/**
 * A small window onto the player's own state, for the checks in
 * scripts/verify-*.js. Nothing here drives behaviour; it only says what happened,
 * which is otherwise invisible because these are file-scope bindings.
 */
window.__player = {
  get currentUrl() {
    return currentUrl;
  },
  get loadCount() {
    return loadCount;
  },
  get lastError() {
    return lastError;
  },
  get listCount() {
    return grouped.length;
  },
  get fatalSeen() {
    return fatalSeen;
  },
};

window.__player.reported = false;
window.__player.bridgeError = null;
try {
  window.player.report({ ready: true });
  window.__player.reported = true;
} catch (err) {
  window.__player.bridgeError = err.message;
}
wake();