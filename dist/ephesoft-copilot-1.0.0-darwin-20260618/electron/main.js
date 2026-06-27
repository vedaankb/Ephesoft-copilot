/**
 * Electron main process
 *
 * Dev: spawns Python from .venv
 * Packaged: spawns bundled ephesoft-server binary (PyInstaller) from resources
 */

const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow;
let serverProcess;

const isPackaged = app.isPackaged;

function getDevPythonBin() {
    return process.platform === 'win32'
        ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
        : path.join(__dirname, '..', '.venv', 'bin', 'python');
}

function getBundledServerBin() {
    const name = process.platform === 'win32' ? 'ephesoft-server.exe' : 'ephesoft-server';
    return path.join(process.resourcesPath, 'server', name);
}

function getBundledResourcesDir() {
    return path.join(process.resourcesPath, 'server');
}

function ensureUserData() {
    const userData = app.getPath('userData');
    const configPath = path.join(userData, 'config.json');

    if (!fs.existsSync(configPath)) {
        const example = path.join(process.resourcesPath, 'config.example.json');
        if (fs.existsSync(example)) {
            fs.copyFileSync(example, configPath);
        } else {
            fs.writeFileSync(
                configPath,
                JSON.stringify({ GEMINI_MODEL: 'gemini-3.1-pro-preview' }, null, 2)
            );
        }
    }

    fs.mkdirSync(path.join(userData, 'logs', 'actions'), { recursive: true });
    fs.mkdirSync(path.join(userData, 'logs', 'screenshots'), { recursive: true });
    return userData;
}

function maybeShowExtensionSetup() {
    if (!isPackaged) return;

    const flagPath = path.join(app.getPath('userData'), '.extension_setup_shown');
    if (fs.existsSync(flagPath)) return;

    const extPath = path.join(process.resourcesPath, 'extension');
    dialog.showMessageBox({
        type: 'info',
        title: 'Load Chrome extension (one time)',
        message: 'Ephesoft Copilot needs the browser extension loaded once in Chrome.',
        detail:
            '1. Open chrome://extensions\n' +
            '2. Enable Developer mode\n' +
            '3. Load unpacked → select this folder:\n\n' +
            extPath +
            '\n\n4. Add your Gemini API key in the panel Settings (gear icon).',
        buttons: ['Open extension folder', 'OK'],
    }).then((result) => {
        fs.writeFileSync(flagPath, new Date().toISOString());
        if (result.response === 0 && fs.existsSync(extPath)) {
            shell.openPath(extPath);
        }
    });
}

function startServer() {
    console.log('Starting FastAPI server...', { packaged: isPackaged });

    let cmd;
    let args;
    let cwd;
    let env = { ...process.env };

    if (isPackaged) {
        const userData = ensureUserData();
        cmd = getBundledServerBin();
        args = [];
        cwd = userData;
        env.EPHESOFT_COPILOT_HOME = userData;
        env.EPHESOFT_COPILOT_RESOURCES = getBundledResourcesDir();

        if (!fs.existsSync(cmd)) {
            console.error(`Bundled server not found: ${cmd}`);
            dialog.showErrorBox(
                'Server missing',
                'The backend binary was not found in the app bundle. Reinstall Ephesoft Copilot.'
            );
            return;
        }
    } else {
        cmd = getDevPythonBin();
        args = ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', '8000'];
        cwd = path.join(__dirname, '..');

        if (!fs.existsSync(cmd)) {
            console.error(`Python not found at ${cmd}`);
            console.error('Run: ./install.sh');
            return;
        }
    }

    serverProcess = spawn(cmd, args, { cwd, env, stdio: 'inherit' });

    serverProcess.on('error', (err) => {
        console.error('Failed to start server:', err);
    });

    serverProcess.on('exit', (code) => {
        console.log(`Server process exited with code ${code}`);
    });

    console.log('FastAPI server process spawned');
}

function waitForServer(maxMs = 45000, intervalMs = 500) {
    return new Promise((resolve) => {
        const start = Date.now();

        const poll = () => {
            const req = http.get('http://127.0.0.1:8000/health', (res) => {
                res.resume();
                if (res.statusCode === 200) {
                    console.log('Server health check OK');
                    resolve(true);
                    return;
                }
                retry();
            });

            req.on('error', () => retry());
            req.setTimeout(2000, () => {
                req.destroy();
                retry();
            });
        };

        const retry = () => {
            if (Date.now() - start >= maxMs) {
                console.warn('Server health check timed out — opening UI anyway');
                resolve(false);
                return;
            }
            setTimeout(poll, intervalMs);
        };

        poll();
    });
}

function stopServer() {
    if (serverProcess) {
        console.log('Stopping FastAPI server...');
        if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(serverProcess.pid), '/f', '/t']);
        } else {
            serverProcess.kill();
        }
        serverProcess = null;
    }
}

function createWindow() {
    // Some VDI/RDP compositors mishandle always-on-top (panel hidden or stuck on
    // top of remote apps). Allow disabling via env: EPHESOFT_ALWAYS_ON_TOP=0.
    const alwaysOnTop = String(process.env.EPHESOFT_ALWAYS_ON_TOP || '1') !== '0';
    mainWindow = new BrowserWindow({
        width: 380,
        height: 600,
        alwaysOnTop: alwaysOnTop,
        frame: true,
        resizable: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
        },
    });

    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    console.log('Main window created');
}

app.whenReady().then(async () => {
    startServer();
    await waitForServer();
    createWindow();
    maybeShowExtensionSetup();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    stopServer();
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    stopServer();
});

app.on('will-quit', () => {
    stopServer();
});
