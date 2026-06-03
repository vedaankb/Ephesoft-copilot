/**
 * Electron main process
 * 
 * Responsibilities:
 * - Spawn FastAPI server as child process
 * - Create floating panel window
 * - Handle IPC between renderer and server
 * - Clean up on app close
 */

const { app, BrowserWindow } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

let mainWindow;
let serverProcess;

function getPythonBin() {
    return process.platform === 'win32'
        ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe')
        : path.join(__dirname, '..', '.venv', 'bin', 'python');
}

// Spawn FastAPI server
function startServer() {
    console.log('Starting FastAPI server...');
    
    const pythonBin = getPythonBin();
    const fs = require('fs');
    if (!fs.existsSync(pythonBin)) {
        console.error(`Python not found at ${pythonBin}`);
        console.error('Run: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt');
        return;
    }
        
    serverProcess = spawn(
        pythonBin,
        ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', '8000'],
        { cwd: path.join(__dirname, '..'), stdio: 'inherit' }
    );
    
    serverProcess.on('error', (err) => {
        console.error('Failed to start server:', err);
    });
    
    serverProcess.on('exit', (code) => {
        console.log(`Server process exited with code ${code}`);
    });
    
    console.log('FastAPI server process spawned');
}

function waitForServer(maxMs = 30000, intervalMs = 500) {
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
                console.warn('Server health check timed out — opening UI anyway (will retry WebSocket)');
                resolve(false);
                return;
            }
            setTimeout(poll, intervalMs);
        };
        
        poll();
    });
}

// Kill server process
function stopServer() {
    if (serverProcess) {
        console.log('Stopping FastAPI server...');
        serverProcess.kill();
        serverProcess = null;
    }
}

// Create main window
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 380,
        height: 600,
        alwaysOnTop: true,
        frame: true,
        resizable: true,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        }
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
