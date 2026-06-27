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
    'capture_scroll_bundle',
    'fill',
    'click',
    'select',
    'fill_row',
    'exists',
    'active_tab_url',
]);

// ----- WebSocket lifecycle with backoff -----

let ws = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let connected = false;
let heartbeatTimer = null;

// MV3 service workers are suspended after ~30s idle, which kills the WebSocket.
// Chrome 116+ resets the idle timer on WS traffic, so a periodic ping keeps both
// the worker and the socket alive. The chrome.alarms backstop below wakes the
// worker and reconnects if it was suspended anyway.
const HEARTBEAT_MS = 20000;
const KEEPALIVE_ALARM = 'copilot-keepalive';

function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify({ type: 'ping' })); } catch (e) { /* ignore */ }
        }
    }, HEARTBEAT_MS);
}

function stopHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

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
        startHeartbeat();
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
        stopHeartbeat();
        ws = null;
        scheduleReconnect();
    };
}

function ensureConnected() {
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        connect();
    }
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
            case 'capture_scroll_bundle':
                result = await captureScrollBundle(msg.max_frames || 4);
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
            case 'fill_row':
                result = await runInActiveTab(domFillRow, [msg.row_selector, msg.values || []]);
                break;
            case 'exists':
                result = await runInActiveTab(domExists, [msg.selector]);
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
    // In VDI/RDP sessions captureVisibleTab can fail or return blank when the
    // window isn't focused. Return "" on failure so HTML-based extraction still runs.
    try {
        const tab = await getActiveTab();
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        // strip "data:image/png;base64," prefix → raw base64
        const idx = dataUrl.indexOf('base64,');
        return idx >= 0 ? dataUrl.slice(idx + 'base64,'.length) : dataUrl;
    } catch (e) {
        console.warn('[copilot] captureVisibleTab failed (VM/focus?):', e?.message || e);
        return '';
    }
}

async function captureScrollBundle(maxFrames = 4) {
    const tab = await getActiveTab();
    const metrics = await runInActiveTab(getScrollMetrics);
    const totalHeight = Math.max(metrics.totalHeight || 0, metrics.viewportHeight || 0);
    const viewportHeight = Math.max(metrics.viewportHeight || 1, 1);
    const originalY = metrics.scrollY || 0;

    const frames = Math.max(1, Math.min(Number(maxFrames) || 4, 8));
    const steps = Math.min(frames, Math.max(1, Math.ceil(totalHeight / viewportHeight)));
    const positions = [];
    const maxY = Math.max(0, totalHeight - viewportHeight);

    if (steps === 1) {
        positions.push(originalY);
    } else {
        for (let i = 0; i < steps; i += 1) {
            const y = Math.round((i / (steps - 1)) * maxY);
            positions.push(y);
        }
    }

    const screenshots = [];
    const html_chunks = [];

    for (const y of positions) {
        await runInActiveTab(setScrollY, [y]);
        await sleep(180);

        // Screenshot is best-effort in VMs; HTML chunks are the reliable signal.
        try {
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
            const idx = dataUrl.indexOf('base64,');
            screenshots.push(idx >= 0 ? dataUrl.slice(idx + 'base64,'.length) : dataUrl);
        } catch (e) {
            console.warn('[copilot] frame capture failed (VM/focus?):', e?.message || e);
        }

        const chunk = await runInActiveTab(getVisibleHtmlChunk);
        html_chunks.push(chunk || "");
    }

    await runInActiveTab(setScrollY, [originalY]);

    return {
        screenshots,
        html_chunks,
        meta: { steps, totalHeight, viewportHeight, originalY },
    };
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

    // Type-aware formatting so date inputs / custom pickers accept the value.
    let v = value;
    const type = (el.getAttribute && (el.getAttribute('type') || '').toLowerCase()) || '';
    if (type === 'date') {
        // <input type=date> requires YYYY-MM-DD. Coerce common formats.
        v = toIsoDate(value) || value;
    }

    el.focus && el.focus();

    if ('value' in el) {
        const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) {
            desc.set.call(el, v);
        } else {
            el.value = v;
        }
    } else {
        el.textContent = v;
    }

    // Fire the full sequence so framework/date-picker validation runs.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Process' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
}

function toIsoDate(value) {
    if (!value) return null;
    const s = String(value).trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;          // already ISO
    let m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/); // MM/DD/YYYY
    if (m) {
        let [, mm, dd, yy] = m;
        if (yy.length === 2) yy = '20' + yy;
        return `${yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
    }
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return null;
}

function isBannedClickTarget(el) {
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').toLowerCase();
    const banned = ['validate', 'skip batch', 'merge documents', 'split documents'];
    return banned.some(b => label.includes(b)) ? label.trim() : null;
}

function domClick(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);
    // Defense in depth: never click anything that looks like Validate/Skip in the page.
    const banned = isBannedClickTarget(el);
    if (banned) {
        throw new Error(`Refusing to click '${banned}' — banned label`);
    }

    el.scrollIntoView && el.scrollIntoView({ block: 'center', inline: 'center' });

    // Synthetic el.click() is ignored by many framework rows/widgets. Dispatch a
    // realistic pointer + mouse sequence instead.
    const opts = { bubbles: true, cancelable: true, view: window };
    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) { /* older */ }
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) { /* older */ }
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));

    // If it is (or sits inside) a real link, follow it so navigation actually happens.
    const anchor = el.closest && el.closest('a[href]');
    if (anchor && anchor.href) {
        const bannedAnchor = isBannedClickTarget(anchor);
        if (!bannedAnchor) window.location.href = anchor.href;
    }
    return true;
}

function domExists(selector) {
    try {
        return document.querySelectorAll(selector).length;
    } catch (e) {
        return 0;
    }
}

// Fill the description/qty/unit_cost cells of a specific line-item row in one
// deterministic page operation (avoids fragile "most recently added input"
// resolution). Values map in order to the first fillable inputs in the row.
function domFillRow(rowSelector, values) {
    const row = document.querySelector(rowSelector);
    if (!row) throw new Error(`Row not found: ${rowSelector}`);
    const inputs = Array.from(row.querySelectorAll('input, textarea, select'))
        .filter(el => {
            const t = (el.getAttribute('type') || '').toLowerCase();
            if (t === 'hidden') return false;
            if (el.disabled || el.readOnly) return false;
            return true;
        });
    let filled = 0;
    for (let i = 0; i < values.length && i < inputs.length; i += 1) {
        const el = inputs[i];
        const v = values[i];
        el.focus && el.focus();
        if (el instanceof HTMLSelectElement) {
            el.value = v;
        } else if ('value' in el) {
            const proto = el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            (desc && desc.set) ? desc.set.call(el, v) : (el.value = v);
        } else {
            el.textContent = v;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
        filled += 1;
    }
    return filled;
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

function getScrollMetrics() {
    const doc = document.documentElement;
    return {
        totalHeight: Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0),
        viewportHeight: window.innerHeight || doc.clientHeight || 0,
        scrollY: window.scrollY || doc.scrollTop || 0,
    };
}

function setScrollY(y) {
    window.scrollTo({ top: Number(y) || 0, behavior: 'auto' });
    return true;
}

function getVisibleHtmlChunk() {
    const viewportTop = window.scrollY || 0;
    const viewportBottom = viewportTop + window.innerHeight;
    const nodes = Array.from(document.querySelectorAll('body *'));
    const out = [];

    for (const el of nodes) {
        if (!el || !el.getBoundingClientRect) continue;
        const rect = el.getBoundingClientRect();
        const top = rect.top + viewportTop;
        const bottom = rect.bottom + viewportTop;
        if (bottom < viewportTop || top > viewportBottom) continue;
        if (rect.width === 0 && rect.height === 0) continue;
        const html = el.outerHTML || "";
        if (html.trim()) out.push(html);
        if (out.join('\n').length > 12000) break;
    }
    return out.join('\n').slice(0, 12000);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

// ----- keepalive / lifecycle -----

// Backstop: if the worker was suspended and the socket dropped, this alarm
// wakes the worker every ~30s and reconnects. (Min alarm period is 30s.)
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) ensureConnected();
});

chrome.runtime.onStartup.addListener(() => ensureConnected());
chrome.runtime.onInstalled.addListener(() => ensureConnected());

// ----- start -----

connect();
