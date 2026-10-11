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
});