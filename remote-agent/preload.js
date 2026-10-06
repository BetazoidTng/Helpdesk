// Runs in a privileged context before the renderer's own JS, and is the
// ONLY bridge between the renderer (index.html / renderer.js -- showing
// the connect form, consent dialog, and the remote agent's own UI) and
// Node/Electron internals. Keeping this surface tiny and specific
// (exactly two calls, nothing generic like "run this script") means the
// renderer can safely stay contextIsolation:true / nodeIntegration:false
// even though it's also rendering a live video feed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('remoteAgent', {
    getScreenSource: () => ipcRenderer.invoke('get-screen-sources'),
    sendControl: (payload) => ipcRenderer.send('control-event', payload),
});
