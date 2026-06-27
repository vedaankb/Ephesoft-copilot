/**
 * Electron preload script
 * 
 * Exposes safe IPC bridge to renderer via contextBridge.
 * No nodeIntegration needed in renderer.
 */

const { contextBridge } = require('electron');

// Expose WebSocket connection helper
contextBridge.exposeInMainWorld('api', {
    // Connection helpers
    getWebSocketUrl: () => {
        return 'ws://127.0.0.1:8000/ws/panel';
    },
    
    // Utility
    platform: process.platform,
});

console.log('Preload script loaded');
