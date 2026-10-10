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
  currentSite: () => ipcRenderer.invoke('site:current'),

  braveAvailable: () => ipcRenderer.invoke('brave:available'),
  openInBrave: (url) => ipcRenderer.invoke('brave:open', { url }),
  chromeVisible: (visible) => ipcRenderer.invoke('chrome:visible', visible),
  chromeHover: (hovering) => ipcRenderer.invoke('chrome:hover', hovering),
  onChromeVisible: (fn) => {
    ipcRenderer.on('chrome:visible', (_e, visible) => fn(visible));
  },
  // Present only when the app is started with TVL_DEBUG_INPUT=1.
  debugMouseMove: (x, y) => ipcRenderer.invoke('debug:mouse-move', { x, y }),
  debugChromeState: () => ipcRenderer.invoke('debug:chrome-state'),
  debugProbePointer: (x, y) => ipcRenderer.invoke('debug:probe-pointer', { x, y }),

  // The site surface covers the launcher, so the main process reports when a
  // site is open or closed and the toolbar swaps accordingly.
  onSiteOpened: (fn) => {
    ipcRenderer.on('site:opened', (_e, payload) => fn(payload));
  },
  onSiteClosed: (fn) => {
    ipcRenderer.on('site:closed', () => fn());
  },
});