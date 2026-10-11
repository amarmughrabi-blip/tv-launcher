'use strict';

/**
 * Player window: plays one channel at a time.
 *
 * Autoplay is muted because a browser will not start sound without a gesture,
 * and a launcher has no gesture to give. The first remote key or click unmutes,
 * so the video starts immediately and the sound follows when the viewer is
 * actually there -- which is the behaviour a TV wants anyway.
 */

const video = document.getElementById('video');
const problem = document.getElementById('problem');
const problemTitle = document.getElementById('problem-title');
const problemDetail = document.getElementById('problem-detail');
const now = document.getElementById('now');
const nowName = document.getElementById('now-name');
const nowRes = document.getElementById('now-res');

let hls = null;
/** Guards against a slow load reporting a problem for a channel that is fine. */
let loadToken = 0;

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

  const { url, name, res } = payload || {};
  if (!url) {
    showProblem('Nothing to play', '');
    return;
  }

  nowName.textContent = name || '';
  nowRes.textContent = res || '';
  now.hidden = false;

  // Let the banner live a moment and then get out of the way.
  clearTimeout(window.__nowTimer);
  window.__nowTimer = setTimeout(() => {
    now.hidden = true;
  }, 2600);

  if (window.Hls && window.Hls.isSupported()) {
    hls = new window.Hls({
      enableWorker: true,
      lowLatencyMode: true,
      // Broadcast CDNs are not fastidious about referrers, and a stream that
      // 403s on a referrer check is not worth the risk of sending one.
      xhrSetup: (xhr) => {
        xhr.withCredentials = false;
      },
    });

    hls.on(window.Hls.Events.ERROR, (_event, data) => {
      if (token !== loadToken) return; // a newer channel has taken over
      if (!data || !data.fatal) return;
      if (!FATAL.has(data.details)) return;
      showProblem('This channel is not playing', data.details);
    });

    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Not reached on this runtime, but harmless and free to keep.
    video.src = url;
  } else {
    showProblem('This channel cannot be played here', 'no HLS support in this build');
  }
}

video.addEventListener('playing', () => clearProblem());

video.addEventListener('error', () => {
  const code = video.error && video.error.code;
  if (code === 4 || code === 3) showProblem('This channel is not playing', 'the stream was refused');
});

function unmute() {
  if (!video.muted) return false;
  video.muted = false;
  video.play().catch(() => {});
  return true;
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // Fullscreen first: from a fullscreen window Escape should step back to the
    // windowed player, and a second press should leave. Closing straight away
    // would skip a step the viewer expects.
    if (document.fullscreenElement) {
      event.preventDefault();
      document.exitFullscreen();
      return;
    }
    event.preventDefault();
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
  }
  // Any of these counts as the viewer arriving, so sound can come on.
  if (['Enter', ' ', 'ArrowUp', 'ArrowDown'].includes(event.key)) unmute();
});

video.addEventListener('click', unmute);

window.player.onLoad(load);
window.player.report({ ready: true });