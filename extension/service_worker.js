/**
 * Ephesoft Copilot — extension service worker.
 *
 * Connects to the local FastAPI backend over WebSocket and routes a CLOSED
 * set of low-level DOM commands to the active tab. Anything outside this
 * allowlist is rejected here, before it ever reaches the page. This is
 * defense-in-depth on top of the same allowlist enforced in Python.
 */

const BACKEND_WS = 'ws://127.0.0.1:8000/ws/extension';

// ----- closed allowlist (must match server/extension_channel.py) -----
const ALLOWED_CMDS = new Set([
    'get_html',
    'screenshot',
    'fill',
    'click',
    'select',
    'active_tab_url',
]);

// ----- WebSocket lifecycle with backoff -----

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let connected = false;

function setStatus(next) {
    connected = next;
    chrome.storage.local.set({ connected: next, last_change: Date.now() });
    chrome.runtime.sendMessage({ type: 'status', connected: next }).catch(() => {});
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectAttempts += 1;
    const delay = Math.min(1000 * reconnectAttempts, 5000);
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

function connect() {
    try {
        ws = new WebSocket(BACKEND_WS);
    } catch (e) {
        console.error('[copilot] WS construct failed', e);
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        console.log('[copilot] WS connected');
        reconnectAttempts = 0;
        setStatus(true);
    };

    ws.onmessage = async (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (e) {
            console.warn('[copilot] non-JSON from backend', event.data);
            return;
        }
        await handleCommand(msg);
    };

    ws.onerror = (e) => {
        console.warn('[copilot] WS error', e);
    };

    ws.onclose = () => {
        console.log('[copilot] WS closed');
        setStatus(false);
        ws = null;
        scheduleReconnect();
    };
}

function sendResponse(id, ok, payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = ok
        ? { id, ok: true, result: payload }
        : { id, ok: false, error: String(payload) };
    ws.send(JSON.stringify(msg));
}

// ----- command router (allowlist enforced) -----

async function handleCommand(msg) {
    const { id, cmd } = msg;
    if (!id || !cmd) {
        console.warn('[copilot] malformed message', msg);
        return;
    }

    if (!ALLOWED_CMDS.has(cmd)) {
        console.error('[copilot] BLOCKED disallowed cmd:', cmd);
        sendResponse(id, false, `Disallowed cmd '${cmd}' — closed allowlist`);
        return;
    }

    try {
        let result;
        switch (cmd) {
            case 'active_tab_url':
                result = (await getActiveTab()).url || '';
                break;
            case 'screenshot':
                result = await captureActiveTab();
                break;
            case 'get_html':
                result = await runInActiveTab(() => document.documentElement.outerHTML);
                break;
            case 'fill':
                result = await runInActiveTab(domFill, [msg.selector, msg.value]);
                break;
            case 'click':
                result = await runInActiveTab(domClick, [msg.selector]);
                break;
            case 'select':
                result = await runInActiveTab(domSelect, [msg.selector, msg.value]);
                break;
        }
        sendResponse(id, true, result);
    } catch (e) {
        console.error('[copilot] cmd failed', cmd, e);
        sendResponse(id, false, e?.message || String(e));
    }
}

// ----- helpers -----

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.id) throw new Error('No active tab');
    return tab;
}

async function captureActiveTab() {
    const tab = await getActiveTab();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    // strip "data:image/png;base64," prefix → raw base64
    const idx = dataUrl.indexOf('base64,');
    return idx >= 0 ? dataUrl.slice(idx + 'base64,'.length) : dataUrl;
}

async function runInActiveTab(func, args = []) {
    const tab = await getActiveTab();
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func,
        args,
    });
    return result;
}

// ----- DOM operations executed in the page (closed set) -----

function domFill(selector, value) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    if (!('value' in el) && el.contentEditable !== 'true') {
        throw new Error(`Element ${selector} is not fillable`);
    }
    if ('value' in el) {
        const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, value);
    } else {
        el.textContent = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

function domClick(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    // Defense in depth: never click anything that looks like Validate/Skip in the page.
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').toLowerCase();
    const banned = ['validate', 'skip batch', 'merge documents', 'split documents'];
    if (banned.some(b => label.includes(b))) {
        throw new Error(`Refusing to click '${label.trim()}' — banned label`);
    }
    el.click();
    return true;
}

function domSelect(selector, value) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    if (!(el instanceof HTMLSelectElement)) {
        // Fall back to setting value directly for custom selects
        if ('value' in el) {
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }
        throw new Error(`Element ${selector} is not a select`);
    }
    let matched = false;
    for (const opt of el.options) {
        if (opt.value === value || opt.text === value || opt.text.toLowerCase() === String(value).toLowerCase()) {
            el.value = opt.value;
            matched = true;
            break;
        }
    }
    if (!matched) throw new Error(`No option matches '${value}' in ${selector}`);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

// ----- popup ↔ worker messaging -----

chrome.runtime.onMessage.addListener((msg, _sender, sendReplyFn) => {
    if (msg && msg.type === 'get_status') {
        sendReplyFn({ connected });
    }
    if (msg && msg.type === 'reconnect') {
        if (ws) try { ws.close(); } catch {}
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        reconnectAttempts = 0;
        connect();
        sendReplyFn({ ok: true });
    }
    return true;
});

// ----- start -----

connect();
