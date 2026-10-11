'use strict';

/**
 * Bridge for the player window.
 *
 * The page has no Electron access beyond what is listed here: it plays a stream
 * and nothing else.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('player', {
  onLoad: (fn) => ipcRenderer.on('player:load', (_e, payload) => fn(payload)),
  /** The full list, for switching without leaving the player. */
  onChannels: (fn) => ipcRenderer.on('player:channels', (_e, grouped) => fn(grouped)),
  switchChannel: (url) => ipcRenderer.send('player:switch', { url }),
  /** Fullscreen is driven from main so the window state stays in one place. */
  setFullscreen: (on) => ipcRenderer.send('player:fullscreen', { on: Boolean(on) }),
  onFullscreenChange: (fn) => ipcRenderer.on('player:fullscreen-changed', (_e, on) => fn(on)),
  report: (payload) => ipcRenderer.send('player:report', payload),
  closeSelf: () => ipcRenderer.invoke('player:close'),

  /** Playback preferences: mute, quality cap, audio language, subtitles. */
  onSettings: (fn) => ipcRenderer.on('player:settings', (_e, value) => fn(value)),

  /**
   * Health, all of it routed through main.
   *
   * The page reports that a channel failed and waits for main to say why. hls.js
   * only ever reports "network error", which cannot tell a missing host from a
   * timeout -- and only the first means the channel is gone. Doing the check here
   * would also mean trusting the page with the verdict.
   */
  failed: (url) => ipcRenderer.send('player:failed', { url }),
  playing: (url) => ipcRenderer.send('player:playing', { url }),
  /** Why it failed, in words, plus whether that counted towards hiding it. */
  onExplained: (fn) => ipcRenderer.on('player:explained', (_e, detail) => fn(detail)),
  /** Take the channel off the grid by hand. */
  hideChannel: (url) => ipcRenderer.invoke('channel:hide', { url }),
  /** Try the same channel again. */
  retry: (url) => ipcRenderer.send('player:switch', { url }),
});