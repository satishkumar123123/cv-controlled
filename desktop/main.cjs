const { app, BrowserWindow, protocol, net, dialog, session } = require('electron');
const { join, extname } = require('node:path');
const { pathToFileURL } = require('node:url');
const { APP_URL, isAppUrl, assetPath, isCameraRequest } = require('./policy.cjs');

// A stable secure origin preserves localStorage across launches; no local server
// or Node bridge is exposed to the renderer. All model assets ship in dist/pose.
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: {
  standard: true, secure: true, supportFetchAPI: true, corsEnabled: true
} }]);
let mainWindow;
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
  '.wasm': 'application/wasm', '.json': 'application/json' };

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120, height: 900, minWidth: 720, minHeight: 600,
    title: 'CV-Controlled Endless Runner', backgroundColor: '#0f172a',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault(); });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(APP_URL);
}

app.whenReady().then(async () => {
  const root = join(app.getAppPath(), 'dist');
  protocol.handle('app', async (request) => {
    const file = assetPath(request.url, root);
    if (!file || !['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(file).toString());
      const headers = new Headers(response.headers);
      headers.set('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
      headers.set('X-Content-Type-Options', 'nosniff');
      // Legacy Emscripten uses JS code generation; allow eval only with local
      // script sources. Node integration remains off and remote loads are blocked.
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'");
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers });
    } catch { return new Response('Asset unavailable. Rebuild the application.', { status: 404 }); }
  });
  const ownWindow = (contents) => Boolean(mainWindow && contents === mainWindow.webContents);
  session.defaultSession.setPermissionCheckHandler((contents, permission, origin, details) =>
    ownWindow(contents) && isAppUrl(origin) && permission === 'media' && details.mediaType === 'video');
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!ownWindow(contents) || !isCameraRequest(details.requestingUrl, permission, details.mediaTypes)) return callback(false);
    dialog.showMessageBox(mainWindow, {
      type: 'question', title: 'Camera permission', message: 'Allow the webcam for pose control?',
      detail: 'Frames are processed locally. Stop camera releases the stream.',
      buttons: ['Allow camera', 'Deny'], defaultId: 1, cancelId: 1
    }).then(({ response }) => callback(response === 0 && ownWindow(contents)), () => callback(false));
  });
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => {
  dialog.showErrorBox('Runner startup failed', `${error.message}\nRun npm ci and npm run desktop again.`);
  app.quit();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
