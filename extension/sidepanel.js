/* Ephesoft Copilot - side panel UI controller. */

import { verifyLicenseOffline } from './lib/license.js';

const els = {
    fillDetails: document.getElementById('fillDetailsBtn'),
    fillLineItems: document.getElementById('fillLineItemsBtn'),
    next: document.getElementById('nextBtn'),
    stop: document.getElementById('stopBtn'),
    runDot: document.getElementById('runDot'),
    feed: document.getElementById('feed'),
    clearFeed: document.getElementById('clearFeed'),
    resultCard: document.getElementById('resultCard'),
    resultBadge: document.getElementById('resultBadge'),
    resultTitle: document.getElementById('resultTitle'),
    resultDetail: document.getElementById('resultDetail'),
    resetSession: document.getElementById('resetSession'),
    licenseKey: document.getElementById('licenseKey'),
    toggleLicense: document.getElementById('toggleLicense'),
    licenseStatus: document.getElementById('licenseStatus'),
    apiKey: document.getElementById('apiKey'),
    toggleKey: document.getElementById('toggleKey'),
    model: document.getElementById('model'),
    saveSettings: document.getElementById('saveSettings'),
    testKey: document.getElementById('testKey'),
    saveMsg: document.getElementById('saveMsg'),
    settings: document.getElementById('settings'),
};

// ---------- connect to the service worker ----------
let port = chrome.runtime.connect({ name: 'copilot' });
wirePort();

function wirePort() {
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(() => {
        // Worker was suspended; reconnect lazily on next interaction.
        port = null;
    });
}

function ensurePort() {
    if (!port) {
        port = chrome.runtime.connect({ name: 'copilot' });
        wirePort();
    }
    return port;
}

function send(msg) {
    try { ensurePort().postMessage(msg); }
    catch (e) {
        port = chrome.runtime.connect({ name: 'copilot' });
        wirePort();
        port.postMessage(msg);
    }
}

// ---------- message handling ----------

function onMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
        case 'state':
            setRunning(msg.running);
            break;
        case 'run_started':
            clearResult();
            addFeed(`Run started: ${String(msg.mode || '').toUpperCase()}`, 'info');
            break;
        case 'status':
            addFeed(msg.message, msg.level || 'info');
            break;
        case 'step':
            // step actions are also surfaced via status lines; keep feed concise
            break;
        case 'key_result':
            els.saveMsg.style.color = msg.ok ? '' : 'var(--red)';
            els.saveMsg.textContent = msg.ok ? 'Key OK' : (msg.error || 'Key failed');
            break;
        case 'page_gate_blocked':
            addPageGateFeed(msg);
            break;
        case 'done':
            showResult(msg);
            break;
        case 'reset_done':
            addFeed(msg.message || 'Session reset. Ready for a fresh run.', 'success');
            break;
    }
}

function setRunning(running) {
    els.runDot.className = 'run-dot ' + (running ? 'running' : 'idle');
    els.runDot.title = running ? 'running' : 'idle';
    els.fillDetails.disabled = running;
    els.fillLineItems.disabled = running;
    els.next.disabled = running;
    els.stop.disabled = !running;
}

function addFeed(message, level = 'info') {
    const li = document.createElement('li');
    li.className = level;
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.innerHTML = `<span class="ts">${ts}</span>`;
    li.appendChild(document.createTextNode(message));
    els.feed.appendChild(li);
    els.feed.parentElement.scrollTop = els.feed.parentElement.scrollHeight;
    // cap feed length
    while (els.feed.children.length > 200) els.feed.removeChild(els.feed.firstChild);
    return li;
}

function addPageGateFeed(msg) {
    const li = addFeed(msg.message || 'Wrong page for this action. No Gemini calls were made.', 'warn');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link feed-override';
    btn.textContent = 'Run anyway';
    btn.title = 'Override page check and start Gemini for this run';
    btn.addEventListener('click', () => {
        btn.disabled = true;
        btn.textContent = 'Starting...';
        start(msg.mode, { overridePageGate: true });
    });
    li.appendChild(document.createTextNode(' '));
    li.appendChild(btn);
}

function clearResult() {
    els.resultCard.classList.add('hidden');
    els.resultDetail.innerHTML = '';
}

function chips(label, items, cls) {
    if (!items || !items.length) return '';
    const inner = items.map(i => `<span class="chip ${cls}">${escapeHtml(String(i))}</span>`).join('');
    return `<div><strong>${label}:</strong> ${inner}</div>`;
}

function showResult(msg) {
    const outcome = msg.outcome || 'error';
    els.resultCard.classList.remove('hidden');
    els.resultBadge.className = 'badge ' + outcome;
    els.resultBadge.textContent = outcome;

    let title = '';
    let detail = '';
    if (outcome === 'complete') {
        title = msg.doc_type ? `Filled as ${msg.doc_type}` : 'Filled';
        detail += msg.message ? `<div>${escapeHtml(msg.message)}</div>` : '';
        detail += chips('Red fields', msg.red_fields, 'red');
        detail += chips('Flags', msg.flags, 'flag');
        if (!msg.red_fields?.length) detail += '<div>No remaining red fields. Review and Validate.</div>';
    } else if (outcome === 'incomplete') {
        title = msg.reason || 'Incomplete';
        detail += msg.message ? `<div>${escapeHtml(msg.message)}</div>` : '';
        detail += chips('Flags', msg.flags, 'flag');
    } else if (outcome === 'stopped') {
        title = 'Stopped';
        detail = '<div>Run stopped before completion.</div>';
    } else if (outcome === 'page_blocked') {
        title = 'Wrong page';
        detail = `<div>${escapeHtml(msg.message || 'Open the correct Ephesoft page, or use Run anyway in Activity.')}</div>`;
        detail += `<div class="page-gate-actions"><button type="button" class="btn btn-small btn-ghost" id="pageGateOverrideBtn">Run anyway</button></div>`;
    } else {
        title = 'Error';
        detail = `<div>${escapeHtml(msg.message || 'Something went wrong.')}</div>`;
    }
    els.resultTitle.textContent = title;
    els.resultDetail.innerHTML = detail;

    if (outcome === 'page_blocked') {
        const btn = document.getElementById('pageGateOverrideBtn');
        if (btn) {
            btn.addEventListener('click', () => start(msg.mode, { overridePageGate: true }));
        }
    }

    addFeed(`${outcome.toUpperCase()}: ${title}`, outcome === 'complete' ? 'success' : outcome === 'error' ? 'error' : 'warn');
}

function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- buttons ----------

els.fillDetails.addEventListener('click', () => start('fill_details'));
els.fillLineItems.addEventListener('click', () => start('fill_line_items'));
els.next.addEventListener('click', () => start('next'));
els.stop.addEventListener('click', () => send({ type: 'stop' }));
els.clearFeed.addEventListener('click', () => { els.feed.innerHTML = ''; });
els.resetSession.addEventListener('click', () => resetSession());

async function resetSession() {
    // Clear the UI so stale results don't linger.
    clearResult();
    els.feed.innerHTML = '';
    addFeed('Resetting session (clearing cached screenshots + reconnecting to the current tab)...', 'warn');

    // Reconnect the port fresh in case the worker was suspended and state is stale.
    try { if (port) port.disconnect(); } catch (e) { /* noop */ }
    port = null;
    ensurePort();

    // Find the tab the user is actually looking at right now so the worker re-targets it.
    let tabId;
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tabs[0]?.id;
    } catch (e) { /* worker will fall back */ }

    send({ type: 'reset_session', tabId });
    // Refresh settings/license status display.
    loadSettings();
}

async function start(mode, opts = {}) {
    // 1. Verify License offline
    const { licenseKey } = await chrome.storage.local.get(['licenseKey']);
    if (!licenseKey) {
        els.settings.open = true;
        addFeed('Enter a valid License Key in Settings to run the Copilot.', 'error');
        return;
    }

    let license;
    try {
        license = await verifyLicenseOffline(licenseKey);
    } catch (e) {
        els.settings.open = true;
        addFeed(`License check failed: ${e.message}`, 'error');
        return;
    }

    // 2. Verify API Key
    let managed = {};
    try {
        if (chrome.storage.managed) {
            managed = await chrome.storage.managed.get(['geminiApiKey']);
        }
    } catch (e) {}
    const local = await chrome.storage.local.get(['geminiApiKey']);
    const apiKey = managed.geminiApiKey || local.geminiApiKey;

    if (!apiKey) {
        els.settings.open = true;
        addFeed('Set your Gemini API key in Settings first.', 'warn');
        return;
    }
    clearResult();
    if (opts.overridePageGate) {
        addFeed('Page check override enabled for this run — Gemini will run even if the page looks wrong.', 'warn');
    }
    let tabId;
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tabs[0]?.id;
    } catch (e) { /* fallback handled in service worker */ }
    send({
        type: 'start',
        mode,
        tabId,
        overridePageGate: !!opts.overridePageGate,
    });
}

// ---------- settings ----------

els.toggleLicense.addEventListener('click', () => {
    const showing = els.licenseKey.type === 'text';
    els.licenseKey.type = showing ? 'password' : 'text';
    els.toggleLicense.textContent = showing ? 'show' : 'hide';
});

els.toggleKey.addEventListener('click', () => {
    const showing = els.apiKey.type === 'text';
    els.apiKey.type = showing ? 'password' : 'text';
    els.toggleKey.textContent = showing ? 'show' : 'hide';
});

els.saveSettings.addEventListener('click', async () => {
    const lKey = els.licenseKey.value.trim();
    let statusClass = 'invalid';
    let statusText = 'Invalid License';

    if (lKey) {
        try {
            const license = await verifyLicenseOffline(lKey);
            statusClass = 'valid';
            statusText = `Valid: ${license.client} (Expires ${license.expires})`;
        } catch (e) {
            statusText = e.message;
        }
    } else {
        statusText = 'No license loaded';
        statusClass = '';
    }

    els.licenseStatus.className = 'license-status ' + statusClass;
    els.licenseStatus.textContent = statusText;

    await chrome.storage.local.set({
        licenseKey: lKey,
        geminiApiKey: els.apiKey.value.trim(),
        geminiModel: els.model.value,
    });
    els.saveMsg.style.color = '';
    els.saveMsg.textContent = 'Saved';
    setTimeout(() => { els.saveMsg.textContent = ''; }, 1800);
});

els.testKey.addEventListener('click', async () => {
    await chrome.storage.local.set({
        licenseKey: els.licenseKey.value.trim(),
        geminiApiKey: els.apiKey.value.trim(),
        geminiModel: els.model.value,
    });
    els.saveMsg.style.color = '';
    els.saveMsg.textContent = 'Testing...';
    send({ type: 'test_key' });
});

async function loadSettings() {
    let managed = {};
    try {
        if (chrome.storage.managed) {
            managed = await chrome.storage.managed.get(['geminiApiKey', 'geminiModel']);
        }
    } catch (e) {
        console.warn('[copilot] managed storage not available:', e);
    }

    const local = await chrome.storage.local.get(['licenseKey', 'geminiApiKey', 'geminiModel']);
    
    const lKey = local.licenseKey || '';
    const apiKey = managed.geminiApiKey || local.geminiApiKey || '';
    const model = managed.geminiModel || local.geminiModel || 'gemini-3.5-flash';

    els.licenseKey.value = lKey;
    els.apiKey.value = apiKey;
    els.model.value = model;

    // Validate license on load
    let statusClass = 'invalid';
    let statusText = 'Invalid License';
    if (lKey) {
        try {
            const license = await verifyLicenseOffline(lKey);
            statusClass = 'valid';
            statusText = `Valid: ${license.client} (Expires ${license.expires})`;
        } catch (e) {
            statusText = e.message;
        }
    } else {
        statusText = 'No license loaded';
        statusClass = '';
    }
    els.licenseStatus.className = 'license-status ' + statusClass;
    els.licenseStatus.textContent = statusText;

    if (managed.geminiApiKey || managed.geminiModel) {
        // Settings are managed by IT policy
        els.apiKey.disabled = true;
        els.model.disabled = true;
        els.saveSettings.disabled = true;
        els.testKey.disabled = true;
        els.saveMsg.style.color = 'var(--muted)';
        els.saveMsg.textContent = 'Managed by IT policy';
    } else {
        if (!lKey || !apiKey) els.settings.open = true;
    }
}

loadSettings();
send({ type: 'get_state' });

// ---------- floating background animations (dogs, cats, syringes) ----------

function initFloatingBackground() {
    const container = document.getElementById('bgAnimation');
    if (!container) return;

    const emojis = ['🐶', '🐱', '💉', '🐕', '🐈', '💉', '🐩', '🐈‍⬛'];
    const maxItems = 12; // keep it subtle and performant

    for (let i = 0; i < maxItems; i++) {
        createFloatingItem(container, emojis, true);
    }
}

function createFloatingItem(container, emojis, initial = false) {
    const item = document.createElement('div');
    item.className = 'floating-item';
    item.textContent = emojis[Math.floor(Math.random() * emojis.length)];

    // Randomize starting properties
    const size = Math.floor(Math.random() * 16) + 16; // 16px to 32px
    const left = Math.random() * 100; // 0% to 100%
    const duration = Math.floor(Math.random() * 12) + 18; // 18s to 30s
    const delay = initial ? Math.random() * -duration : Math.random() * 4; // negative delay so they start mid-flight
    const sway = Math.floor(Math.random() * 60) - 30; // -30px to 30px
    const rot = Math.floor(Math.random() * 360) + 180; // 180deg to 540deg
    const maxOpacity = (Math.random() * 0.12) + 0.05; // 5% to 17% opacity for a very subtle look

    item.style.setProperty('--size', `${size}px`);
    item.style.left = `${left}%`;
    item.style.setProperty('--duration', `${duration}s`);
    item.style.setProperty('--delay', `${delay}s`);
    item.style.setProperty('--sway', `${sway}px`);
    item.style.setProperty('--rot', `${rot}deg`);
    item.style.setProperty('--max-opacity', maxOpacity);

    container.appendChild(item);

    // Randomize position/sway on each loop iteration to keep it organic
    item.addEventListener('animationiteration', () => {
        item.style.left = `${Math.random() * 100}%`;
        const nextSway = Math.floor(Math.random() * 60) - 30;
        const nextRot = Math.floor(Math.random() * 360) + 180;
        item.style.setProperty('--sway', `${nextSway}px`);
        item.style.setProperty('--rot', `${nextRot}deg`);
    });
}

initFloatingBackground();

