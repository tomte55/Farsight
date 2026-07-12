// packages/controller/src/preload.cjs
// CommonJS because the renderer runs with sandbox: true (R-7).
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('farsightIpc', {
  getSignalingUrl: () => ipcRenderer.invoke('get-signaling-url'),
  setSignalingUrl: (url) => ipcRenderer.invoke('set-signaling-url', url),
});
