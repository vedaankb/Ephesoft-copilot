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

let mainWindow;
let serverProcess;

// Spawn FastAPI server
function startServer() {
    console.log('Starting FastAPI server...');
    
    serverProcess = spawn('python', ['-m', 'uvicorn', 'server.main:app', '--host', '127.0.0.1', '--port', '8000'], {
        cwd: path.join(__dirname, '..'),
        stdio: 'inherit'
    });
    
    serverProcess.on('error', (err) => {
        console.error('Failed to start server:', err);
    });
    
    serverProcess.on('exit', (code) => {
        console.log(`Server process exited with code ${code}`);
    });
    
    console.log('FastAPI server started');
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
    
    // Load renderer
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    
    // Open DevTools in dev mode
    if (process.argv.includes('--dev')) {
        mainWindow.webContents.openDevTools();
    }
    
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    
    console.log('Main window created');
}

// App lifecycle
app.whenReady().then(() => {
    // Start server first
    startServer();
    
    // Wait 2 seconds for server to start, then create window
    setTimeout(() => {
        createWindow();
    }, 2000);
    
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
