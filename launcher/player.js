'use strict';

/**
 * Player window: plays a channel, and lets you change your mind.
 *
 * Autoplay is muted because a browser will not start sound without a gesture,
 * and a launcher has no gesture to give. Any input unmutes, so the video starts
 * immediately and the sound follows when the viewer is actually there.
 *
 * The chrome (back, the list toggle, the channel list) hides when the remote is
 * idle and returns on any input. It sits over the picture, so leaving it up for
 * a whole film would spoil the thing it is meant to help with.
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
const channelsInner = document.getElementById('channels-inner');
const toggle = document.getElementById('toggle');
const back = document.getElementById('back');

/** How long the chrome waits before getting out of the way. */
const IDLE_MS = 4000;

let hls = null;
/** Guards against a slow load reporting a problem for a channel that is fine. */
let loadToken = 0;
let idleTimer = null;
let currentUrl = null;
let list = [];

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

/** Fatal errors are worth reporting; recoverable ones are not worth a banner. */
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
        // Broadcast CDNs are not fastidious about referrers, and a stream that
        // 403s on a referrer check is not worth the risk of sending one.
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

/* ---------------- the channel list ---------------- */

function markCurrent() {
  for (const node of channelsInner.querySelectorAll('.ch')) {
    const on = node.dataset.url === currentUrl;
    node.classList.toggle('is-current', on);
    if (on) {
      // Keep the playing channel in view when switching from the list.
      const box = node.offsetTop - channelsInner.clientHeight / 2;
      channelsInner.scrollTop = Math.max(0, box);
    }
  }
}

function setListOpen(open) {
  channels.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  toggle.title = open ? 'Hide channels' : 'Show channels';
  toggle.setAttribute('aria-label', toggle.title);
  if (open) markCurrent();
}

function buildList(grouped) {
  list = grouped || [];
  channelsInner.replaceChildren();

  for (const { genre, channels: entries } of list) {
    const heading = document.createElement('p');
    heading.className = 'ch-group';
    heading.textContent = `${genre} · ${entries.length}`;
    channelsInner.appendChild(heading);

    for (const channel of entries) {
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
      channelsInner.appendChild(item);
    }
  }
  markCurrent();
}

/* ---------------- chrome behaviour ---------------- */

function wake() {
  chrome.classList.remove('is-idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    chrome.classList.add('is-idle');
  }, IDLE_MS);
}

toggle.addEventListener('click', () => {
  setListOpen(channels.hidden);
  wake();
});

back.addEventListener('click', () => window.player.closeSelf());

// The pointer over the video itself also brings the chrome back, so a viewer
// waving the mouse does not have to find the buttons first.
video.addEventListener('mousemove', wake);

function unmute() {
  if (!video.muted) return;
  video.muted = false;
  video.play().catch(() => {});
  wake();
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // Chrome first, then out. Closing straight from fullscreen skips a step
    // people expect from every other player.
    event.preventDefault();
    if (!chrome.classList.contains('is-idle')) {
      chrome.classList.add('is-idle');
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

/** Move through the list with the arrow keys, the way a remote does. */
function step(direction) {
  setListOpen(true);
  const items = [...channelsInner.querySelectorAll('.ch')];
  if (!items.length) return;
  const at = items.findIndex((n) => n.classList.contains('is-current'));
  const next = items[Math.min(items.length - 1, Math.max(0, at + direction))] || items[0];
  if (next !== items[at]) {
    window.player.switchChannel(next.dataset.url);
  }
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest' });
}

video.addEventListener('click', unmute);

window.player.onLoad(load);
window.player.onChannels((grouped) => buildList(grouped));
window.player.report({ ready: true });
wake();