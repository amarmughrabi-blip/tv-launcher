'use strict';

/**
 * Bridge for the launcher renderer.
 *
 * The renderer has no node integration, so every privileged operation is an
 * explicit channel here. The site surface is controlled from the main process;
 * the renderer only asks for it.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: (name) => ipcRenderer.invoke('profiles:create', { name }),
  // `fields` must be forwarded: the store updates the avatar from it, and
  // omitting it here meant a picked profile picture was silently discarded.
  renameProfile: (id, name, fields) => ipcRenderer.invoke('profiles:rename', { id, name, fields }),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', { id }),
  activateProfile: (id) => ipcRenderer.invoke('profiles:activate', { id }),
  setProfileAvatar: (id, avatar) => ipcRenderer.invoke('profiles:avatar', { id, avatar }),

  listSites: () => ipcRenderer.invoke('sites:list'),
  addSite: (url, label, icon) => ipcRenderer.invoke('sites:add', { url, label, icon }),
  updateSite: (url, label, icon) => ipcRenderer.invoke('sites:update', { url, label, icon }),
  removeSite: (url) => ipcRenderer.invoke('sites:remove', { url }),
  reorderSite: (url, direction) => ipcRenderer.invoke('sites:reorder', { url, direction }),

  chooseIcon: () => ipcRenderer.invoke('icon:choose'),
  storeIcon: (sourcePath) => ipcRenderer.invoke('icon:store', { sourcePath }),
  storeIconBytes: (bytes, sourcePath) =>
    ipcRenderer.invoke('icon:store-bytes', { bytes, sourcePath }),
  // A File from <input type="file"> carries no usable path under context
  // isolation; this is the supported way to turn one into a filesystem path.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  favicon: (url) => ipcRenderer.invoke('favicon:get', { url }),

  openSite: (url) => ipcRenderer.invoke('site:open', { url }),
  back: () => ipcRenderer.invoke('site:back'),
  channels: () => ipcRenderer.invoke('channels:get'),
  playChannel: (url) => ipcRenderer.invoke('channels:play', { url }),
  closePlayer: () => ipcRenderer.invoke('player:close'),
  /** Take a channel off the grid, or put it back. Neither touches the list itself. */
  hideChannel: (url) => ipcRenderer.invoke('channel:hide', { url }),
  restoreChannel: (url) => ipcRenderer.invoke('channel:restore', { url }),
  addChannel: (record) => ipcRenderer.invoke('channel:add', record),
  updateChannel: (url, changes) => ipcRenderer.invoke('channel:update', { url, changes }),
  removeChannel: (url) => ipcRenderer.invoke('channel:remove', { url }),
  /** Check a batch of channels. Nothing is written until the result is applied. */
  startSweep: (options) => ipcRenderer.invoke('sweep:start', options),
  applySweep: (token) => ipcRenderer.invoke('sweep:apply', { token }),
  cancelSweep: () => ipcRenderer.invoke('sweep:cancel'),
  onSweepProgress: (fn) => ipcRenderer.on('sweep:progress', (_e, detail) => fn(detail)),
  currentSite: () => ipcRenderer.invoke('site:current'),

  braveAvailable: () => ipcRenderer.invoke('brave:available'),
  openInBrave: (url) => ipcRenderer.invoke('brave:open', { url }),
  chromeVisible: (visible) => ipcRenderer.invoke('chrome:visible', visible),
  chromeHover: (hovering) => ipcRenderer.invoke('chrome:hover', hovering),
  debugSiteEval: (code) => ipcRenderer.invoke('debug:site-eval', { code }),
  debugExternalOpens: () => ipcRenderer.invoke('debug:external-opens'),
  debugWindows: () => ipcRenderer.invoke('debug:windows'),
  debugBlocker: () => ipcRenderer.invoke('debug:blocker'),
  debugRealClick: (x, y) => ipcRenderer.invoke('debug:real-click', { x, y }),
  debugPlayer: () => ipcRenderer.invoke('debug:player'),
  debugPlayerPixels: () => ipcRenderer.invoke('debug:player-pixels'),
  debugPlayerUI: () => ipcRenderer.invoke('debug:player-ui'),
  debugPlayerPick: (index) => ipcRenderer.invoke('debug:player-pick', { index }),
  debugPlayerToggle: () => ipcRenderer.invoke('debug:player-toggle'),
  debugLauncherVisible: () => ipcRenderer.invoke('debug:launcher-visible'),
  debugPlayerPickGenre: (genre) => ipcRenderer.invoke('debug:player-pick-genre', { genre }),
  debugPlayerInternals: () => ipcRenderer.invoke('debug:player-internals'),
  debugHealth: () => ipcRenderer.invoke('debug:health'),
  debugPopups: () => ipcRenderer.invoke('debug:popups'),
  debugCosmetics: () => ipcRenderer.invoke('debug:cosmetics'),
  // Start-up progress: the loading screen covers the window until 'ready'.
  onBootNote: (fn) => ipcRenderer.on('boot:note', (_e, note) => fn(note)),
  onAppReady: (fn) => ipcRenderer.on('app:ready', () => fn()),
  isAppReady: () => ipcRenderer.invoke('app:ready-state'),
  onChromeVisible: (fn) => {
    ipcRenderer.on('chrome:visible', (_e, visible) => fn(visible));
  },
  onChromeOffset: (fn) => {
    ipcRenderer.on('chrome:offset', (_e, offset) => fn(offset));
  },
  // Present only when the app is started with TVL_DEBUG_INPUT=1.
  //
  // These take a single vertical position. They used to take (x, y), but every
  // caller passed one argument, so `y` was always undefined and the handler
  // fell back to its default -- the checks ran against the top of the screen
  // whatever they asked for, and passed for the wrong reason.
  debugMouseMove: (y) => ipcRenderer.invoke('debug:mouse-move', { y }),
  debugChromeState: () => ipcRenderer.invoke('debug:chrome-state'),
  debugProbePointer: (y, opts = {}) => ipcRenderer.invoke('debug:probe-pointer', { y, ...opts }),

  // The site surface covers the launcher, so the main process reports when a
  // site is open or closed and the toolbar swaps accordingly.
  onSiteOpened: (fn) => {
    ipcRenderer.on('site:opened', (_e, payload) => fn(payload));
  },
  onSiteClosed: (fn) => {
    ipcRenderer.on('site:closed', () => fn());
  },
});