/**
 * Ephesoft Copilot - service worker (agent orchestrator).
 *
 * Pure-extension V2: no backend, no Electron, no Playwright. This worker runs a
 * dynamic, step-by-step agent loop. Each step it captures a screenshot + reads
 * the page via the content script, asks Gemini for ONE next action, executes it,
 * and repeats until the model calls complete/incomplete. The training SOP and
 * doc-type rules are bundled in /prompts and injected as the system instruction
 * (RAG) on every call.
 */

import { callGemini, parseJsonResponse, testApiKey } from './lib/gemini.js';
import { verifyLicenseOffline } from './lib/license.js';

// ---------- side panel wiring ----------

chrome.runtime.onInstalled.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
// Also set immediately when the worker spins up.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// ---------- run state ----------

let running = false;
let abortRequested = false;
let activePort = null;
let runController = null; // aborts the in-flight Gemini fetch when the user hits Stop

function post(msg) {
    if (activePort) {
        try { activePort.postMessage(msg); } catch (e) { /* panel gone */ }
    }
}
function status(message, level = 'info') { post({ type: 'status', level, message }); }

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'copilot') return;
    activePort = port;
    port.postMessage({ type: 'state', running });

    port.onMessage.addListener(async (msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === 'start') {
            if (running) { status('A run is already in progress.', 'warn'); return; }
            startRun(msg.mode || 'fill', msg.tabId);
        } else if (msg.type === 'stop') {
            abortRequested = true;
            if (runController) { try { runController.abort(); } catch (e) { /* noop */ } }
            status('Stop requested - cancelling current step...', 'warn');
        } else if (msg.type === 'test_key') {
            handleTestKey();
        } else if (msg.type === 'reset_session') {
            handleResetSession(msg.tabId);
        } else if (msg.type === 'get_state') {
            port.postMessage({ type: 'state', running });
        }
    });

    port.onDisconnect.addListener(() => {
        if (activePort === port) activePort = null;
        // If the panel closes mid-run, stop cleanly (the worker may be suspended anyway).
        if (running) {
            abortRequested = true;
            if (runController) { try { runController.abort(); } catch (e) { /* noop */ } }
        }
    });
});

// Purge all cached/session state so the next run starts clean: abort any in-flight
// work, drop the cached prompts, reset run flags, and re-inject a fresh content
// script into the tab the user is currently viewing (clears stale DOM listeners and
// the __ephesoftCopilotInjected guard by reloading the script into the live page).
async function handleResetSession(preferredTabId) {
    // 1. Abort anything in flight and clear run state.
    abortRequested = true;
    if (runController) { try { runController.abort(); } catch (e) { /* noop */ } }
    running = false;
    runController = null;

    // 2. Force prompts (SOP/RAG) to reload from disk on the next run.
    _systemInstruction = null;

    // 3. Reset the UI running indicator.
    post({ type: 'state', running: false });

    // 4. Reconnect to the current tab and refresh the content script connection.
    let reconnected = false;
    try {
        const tab = await getTargetTab(preferredTabId);
        await injectContentScript(tab.id);
        reconnected = true;
        status(`Reconnected to: ${tab.title || tab.url}`, 'info');
    } catch (e) {
        status(`Reset: could not reconnect to a page (${e.message}). Open the Ephesoft tab and try again.`, 'warn');
    }

    // 5. Clear the abort flag so the next run is not immediately cancelled.
    abortRequested = false;

    post({
        type: 'reset_done',
        message: reconnected
            ? 'Session reset - cached screenshots cleared and reconnected to the current tab.'
            : 'Session reset - state cleared. Click into the Ephesoft tab, then run again.',
    });
}

async function handleTestKey() {
    try {
        const { geminiApiKey, geminiModel } = await getSettings();
        status('Testing Gemini API key...');
        const ok = await testApiKey({ apiKey: geminiApiKey, model: geminiModel });
        post({ type: 'key_result', ok });
        status(ok ? 'API key works.' : 'API key test failed.', ok ? 'success' : 'error');
    } catch (e) {
        post({ type: 'key_result', ok: false, error: e.message });
        status(`API key test failed: ${e.message}`, 'error');
    }
}

// ---------- settings ----------

async function getSettings() {
    let managed = {};
    try {
        if (chrome.storage.managed) {
            managed = await chrome.storage.managed.get(['geminiApiKey', 'geminiModel']);
        }
    } catch (e) {
        console.warn('[copilot] managed storage not available or blocked:', e);
    }
    const local = await chrome.storage.local.get(['geminiApiKey', 'geminiModel']);
    return {
        geminiApiKey: managed.geminiApiKey || local.geminiApiKey || '',
        geminiModel: managed.geminiModel || local.geminiModel || 'gemini-2.5-pro',
        isManaged: !!(managed.geminiApiKey || managed.geminiModel),
    };
}

// ---------- prompt (SOP / RAG) loading ----------

let _systemInstruction = null;
async function loadSystemInstruction() {
    if (_systemInstruction) return _systemInstruction;
    const files = ['prompts/system.md', 'prompts/sop_rules.md', 'prompts/doc_types.md'];
    const texts = [];
    for (const f of files) {
        try {
            const res = await fetch(chrome.runtime.getURL(f));
            texts.push(await res.text());
        } catch (e) {
            console.warn('[copilot] could not load', f, e);
        }
    }
    _systemInstruction = texts.join('\n\n---\n\n');
    return _systemInstruction;
}

// ---------- tab helpers ----------

function isAutomatableTab(tab) {
    if (!tab || !tab.id) return false;
    return !/^(chrome|edge|about|chrome-extension):/i.test(tab.url || '');
}

async function getTargetTab(preferredTabId) {
    if (preferredTabId) {
        try {
            const tab = await chrome.tabs.get(preferredTabId);
            if (isAutomatableTab(tab)) return tab;
        } catch (e) { /* tab closed or invalid */ }
    }

    // Side panel is focused — prefer tabs in the same window as the panel.
    const sameWindow = await chrome.tabs.query({ active: true, currentWindow: true });
    if (isAutomatableTab(sameWindow[0])) return sameWindow[0];

    const lastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (isAutomatableTab(lastFocused[0])) return lastFocused[0];

    throw new Error('No Ephesoft tab found. Click into the Ephesoft web page, then run again.');
}

function friendlyInjectError(message) {
    const m = String(message || '');
    if (/cannot be scripted|chrome:\/\/|extension gallery|showing error page|cannot access/i.test(m)) {
        return 'This page cannot be automated by extensions (a browser/PDF/error page or a restricted URL). '
            + 'Open the Ephesoft web app in a normal tab and try again.';
    }
    return `Cannot reach the page: ${m}`;
}

async function injectContentScript(tabId) {
    try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content_script.js'] });
    } catch (injErr) {
        throw new Error(friendlyInjectError(injErr && injErr.message));
    }
}

async function ensureContentScript(tabId) {
    try {
        const r = await chrome.tabs.sendMessage(tabId, { cmd: 'ping' });
        if (r && r.ok) return;
    } catch (e) { /* not injected yet */ }
    await injectContentScript(tabId);
}

async function sendToTab(tabId, payload) {
    try {
        return await chrome.tabs.sendMessage(tabId, payload);
    } catch (e) {
        // Content script may not be present (fresh navigation / first load). Inject + retry.
        await injectContentScript(tabId);
        return await chrome.tabs.sendMessage(tabId, payload);
    }
}

async function captureViewport(windowId) {
    try {
        const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
        const idx = dataUrl.indexOf('base64,');
        return idx >= 0 ? dataUrl.slice(idx + 'base64,'.length) : dataUrl;
    } catch (e) {
        // VM/focus issues - fall back to HTML-only by returning empty.
        console.warn('[copilot] captureVisibleTab failed:', e?.message || e);
        return '';
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------- Gemini call with live "thinking" feedback + timeout retry ----------

// Posts an elapsed-time heartbeat to the panel while a Gemini call is in flight,
// escalating the message so the user always knows the agent is alive (not frozen).
function startThinkingHeartbeat(hasVision) {
    const startedAt = Date.now();
    const base = hasVision ? 'Thinking (Gemini + vision)' : 'Thinking (Gemini, text-only)';
    status(`${base}...`);
    const timer = setInterval(() => {
        const secs = Math.round((Date.now() - startedAt) / 1000);
        let suffix = '';
        if (secs >= 60) suffix = ' - still working, will retry shortly if it stalls';
        else if (secs >= 30) suffix = ' - taking longer than usual';
        status(`${base}... ${secs}s${suffix}`);
    }, 10000);
    return () => clearInterval(timer);
}

// Calls Gemini with a heartbeat. On timeout, retries ONCE with a lighter payload
// (no screenshot, trimmed HTML) so a slow/complex step can still make progress.
async function think({ apiKey, model, systemInstruction, userText, imageB64, signal, liteUserText }) {
    const stop = startThinkingHeartbeat(!!imageB64);
    try {
        return await callGemini({ apiKey, model, systemInstruction, userText, imageB64, signal });
    } catch (e) {
        if (abortRequested || (e && e.name === 'AbortError')) throw e;
        const isTimeout = /timed out/i.test(e && e.message || '');
        if (!isTimeout) throw e;
        status('Step is slow - retrying once with a lighter request...', 'warn');
        // Retry: drop the image and use a trimmed prompt to reduce inference time.
        return await callGemini({
            apiKey,
            model,
            systemInstruction,
            userText: liteUserText || userText,
            imageB64: undefined,
            signal,
        });
    } finally {
        stop();
    }
}

// ---------- the agent loop ----------

async function startRun(mode, preferredTabId) {
    running = true;
    abortRequested = false;
    runController = new AbortController();
    post({ type: 'state', running: true });
    post({ type: 'run_started', mode });
    try {
        await runAgent(mode, preferredTabId);
    } catch (e) {
        // A user Stop (or panel close) aborts the in-flight fetch; treat as graceful stop.
        if (abortRequested || (e && e.name === 'AbortError')) {
            status('Stopped by user.', 'warn');
            post({ type: 'done', outcome: 'stopped' });
        } else {
            status(`Error: ${e.message}`, 'error');
            post({ type: 'done', outcome: 'error', message: e.message });
        }
    } finally {
        running = false;
        abortRequested = false;
        runController = null;
        post({ type: 'state', running: false });
    }
}

function taskHeader(mode) {
    if (mode === 'next') {
        return 'TASK MODE: NEXT. Open the oldest unassigned, not-in-progress batch from the batch list. '
            + 'Use click for batch rows and for batch-list pagination. When the batch has opened, call complete.';
    }
    return 'TASK MODE: FILL. Read the document on screen and fill all Ephesoft fields per the SOP, '
        + 'then verify and call complete. Scroll the document viewer / fields panel as needed.';
}

function buildUserText(mode, o, history) {
    const hist = history.length
        ? history.map((h, i) => `${i + 1}. ${h}`).join('\n')
        : '(none yet)';
    return [
        taskHeader(mode),
        '',
        `CURRENT URL: ${o.url}`,
        `PAGE TITLE: ${o.title}`,
        `SCROLL: y=${o.scroll.y} maxY=${o.scroll.maxY} atBottom=${o.scroll.atBottom} (pageHeight=${o.scroll.pageHeight}, viewport=${o.scroll.viewportHeight})`,
        '',
        'ACTIONS TAKEN SO FAR (with results):',
        hist,
        '',
        'VISIBLE PAGE TEXT (truncated):',
        o.text,
        '',
        'PAGE HTML (trimmed - scroll to load more if an element is missing):',
        o.html,
        '',
        'Respond with EXACTLY ONE next action as a single JSON object per the system instructions.',
    ].join('\n');
}

function summarizeStep(action, res) {
    const tgt = action.selector || (action.direction ? `(${action.direction})` : '');
    const val = action.value != null ? ` = "${action.value}"` : '';
    const outcome = res && res.ok ? 'ok' : `ERROR: ${res && res.error ? res.error : 'unknown'}`;
    return `${action.action} ${tgt}${val} -> ${outcome}`;
}

async function executeAction(tabId, action) {
    switch (action.action) {
        case 'fill':
            return sendToTab(tabId, { cmd: 'fill', selector: action.selector, value: action.value });
        case 'select':
            return sendToTab(tabId, { cmd: 'select', selector: action.selector, value: action.value });
        case 'click':
            return sendToTab(tabId, { cmd: 'click', selector: action.selector });
        case 'scroll':
            return sendToTab(tabId, { cmd: 'scroll', selector: action.selector, direction: action.direction });
        case 'fill_row':
            return sendToTab(tabId, { cmd: 'fill_row', row_selector: action.selector, values: action.values || [] });
        case 'exists':
            return sendToTab(tabId, { cmd: 'exists', selector: action.selector });
        default:
            return { ok: false, error: `Unknown action: ${action.action}` };
    }
}

async function runAgent(mode, preferredTabId) {
    // 1. Double-check license offline in service worker
    const { licenseKey } = await chrome.storage.local.get(['licenseKey']);
    if (!licenseKey) {
        throw new Error('No License Key provided. Enter your license key in Settings.');
    }
    const license = await verifyLicenseOffline(licenseKey);

    const { geminiApiKey, geminiModel } = await getSettings();
    if (!geminiApiKey) throw new Error('No Gemini API key set. Open Settings and paste your key.');

    const systemInstruction = await loadSystemInstruction();
    const tab = await getTargetTab(preferredTabId);

    status(`Connecting to page: ${tab.title || tab.url}`);
    await ensureContentScript(tab.id);

    const history = [];
    const maxSteps = mode === 'fill' ? 80 : 30;
    const recent = [];           // ring buffer of recent action keys
    let lastScrollY = null;      // to detect scrolls that no longer move the page

    for (let step = 1; step <= maxSteps; step += 1) {
        if (abortRequested) {
            status('Stopped by user.', 'warn');
            post({ type: 'done', outcome: 'stopped' });
            return;
        }

        status(`Observing page (step ${step}/${maxSteps})...`);
        const obsResp = await sendToTab(tab.id, { cmd: 'observe' });
        if (!obsResp || !obsResp.ok) throw new Error(`Could not read page: ${obsResp && obsResp.error}`);
        const o = obsResp.result;

        const shot = await captureViewport(tab.windowId);
        if (!shot && step === 1) {
            status('Screenshot unavailable (VM/RDP?) — running text-only mode.', 'warn');
        }
        const userText = buildUserText(mode, o, history);
        // Lighter prompt used for the timeout retry: drop the bulky HTML slice.
        const liteUserText = buildUserText(mode, { ...o, html: '(omitted for speed - rely on visible text and prior actions)' }, history);

        const signal = runController ? runController.signal : undefined;
        const raw = await think({
            apiKey: geminiApiKey,
            model: geminiModel,
            systemInstruction,
            userText,
            imageB64: shot || undefined,
            signal,
            liteUserText,
        });

        let action;
        try {
            action = parseJsonResponse(raw);
        } catch (e) {
            if (abortRequested) continue;
            // One corrective retry before giving up - models occasionally wrap JSON in prose.
            status('Model output was not clean JSON - retrying once...', 'warn');
            const raw2 = await think({
                apiKey: geminiApiKey,
                model: geminiModel,
                systemInstruction,
                userText: userText + '\n\nYour previous reply was not valid JSON. Respond with ONLY a single JSON object, no prose, no code fences.',
                imageB64: shot || undefined,
                signal,
                liteUserText,
            });
            try { action = parseJsonResponse(raw2); }
            catch (e2) { throw new Error(`Model returned unparseable output: ${e2.message}`); }
        }
        if (!action || typeof action !== 'object' || !action.action) {
            throw new Error('Model response had no "action" field.');
        }

        if (action.note) status(action.note);

        if (action.action === 'complete') {
            post({
                type: 'done',
                outcome: 'complete',
                doc_type: action.doc_type || null,
                red_fields: action.red_fields || [],
                flags: action.flags || [],
                message: action.note || 'Completed. Ready for human review.',
            });
            status('Complete - ready for human review.', 'success');
            return;
        }
        if (action.action === 'incomplete') {
            post({
                type: 'done',
                outcome: 'incomplete',
                reason: action.reason || 'Missing Information',
                flags: action.flags || [],
                message: action.note || action.reason || 'Marked incomplete.',
            });
            status(`Incomplete: ${action.reason || 'Missing Information'}`, 'warn');
            return;
        }

        // --- loop guards (let legit repeats like scrolling through) ---
        const key = JSON.stringify([action.action, action.selector, action.value, action.direction]);
        recent.push(key);
        if (recent.length > 8) recent.shift();
        let consecutive = 0;
        for (let i = recent.length - 1; i >= 0 && recent[i] === key; i -= 1) consecutive += 1;

        if (action.action === 'scroll') {
            // Scrolling repeatedly is normal - only stop if the page stopped moving.
            if (consecutive >= 3 && lastScrollY != null && o.scroll && o.scroll.y === lastScrollY) {
                throw new Error('Scrolling no longer moves the page (reached the end). Stopping.');
            }
        } else if (consecutive >= 3) {
            throw new Error(`Stuck repeating the same action 3x: ${summarizeStep(action, { ok: true })}`);
        }

        // Oscillation: two actions ping-ponging (A,B,A,B,A,B).
        if (recent.length >= 6) {
            const s = recent.slice(-6);
            if (s[0] !== s[1] && s[0] === s[2] && s[2] === s[4] && s[1] === s[3] && s[3] === s[5]) {
                throw new Error('Stuck oscillating between two actions. Stopping for human review.');
            }
        }
        lastScrollY = o.scroll ? o.scroll.y : lastScrollY;

        post({ type: 'step', step, action });
        const res = await executeAction(tab.id, action);
        const line = summarizeStep(action, res);
        history.push(line);
        status(line, res && res.ok ? 'info' : 'warn');

        // Let the page settle (longer after clicks that may navigate an SPA).
        await sleep(action.action === 'click' ? 1400 : 500);
    }

    throw new Error('Reached the step limit without completing. Check the page state and retry.');
}
