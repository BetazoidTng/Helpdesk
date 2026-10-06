// Electron main process. Owns the one window the customer sees, hands
// out screen-capture sources to the renderer (desktopCapturer is
// main-process-only), and is the only place input-injection (nut.js, via
// inputInjector.js) ever runs -- the renderer, which is also rendering
// whatever the support agent sends it, never gets direct access to
// either.
const { app, BrowserWindow, ipcMain, desktopCapturer, screen } = require('electron');
const path = require('path');

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 480,
        height: 560,
        resizable: true,
        title: 'Helpdesk Remote Assist Agent',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            // Needed so getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', ... } } })
            // is allowed to actually capture the screen -- see renderer/renderer.js.
            webSecurity: true,
        },
    });
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    // A closed window always ends whatever session was running -- there
    // is no "minimize to tray and keep controlling in the background"
    // mode, by design: the window (and its visible "session active, end
    // it here" banner) IS the consent and revocation mechanism.
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// The renderer asks for this instead of using navigator.mediaDevices
// .getDisplayMedia() because Electron's screen-share picker UI is a
// separate, heavier flow meant for letting the user choose a window to
// share in a video call; for a support-session screen share we want the
// *whole* primary screen every time -- same as real remote-assist
// tools -- with no "which window?" prompt on the customer's side.
ipcMain.handle('get-screen-sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    const primary = screen.getPrimaryDisplay();
    return {
        sourceId: sources[0] ? sources[0].id : null,
        width: primary.size.width,
        height: primary.size.height,
        scaleFactor: primary.scaleFactor,
    };
});

ipcMain.on('control-event', (event, payload) => {
    // Deferred require -- inputInjector pulls in nut.js's native
    // bindings, which only need to load at all once a session is
    // actually controlling this computer.
    require('./inputInjector').handle(payload);
});
