/**
 * Ephesoft Copilot - service worker (agent orchestrator).
 *
 * Pure-extension V2: no backend, no Electron, no Playwright.
 *
 * Fill Details / Fill Line Items: gather (few scrolls + screenshots) → decide
 * (map catalog fields → values into run memory) → fill at once with verify.
 * Next: classic observe → Gemini one-action → act loop.
 */

import { callGemini, parseJsonResponse, testApiKey } from './lib/gemini.js';
import { verifyLicenseOffline } from './lib/license.js';
import {
    MAX_GATHER_STEPS,
    MAX_RECOVERY_CALLS,
    buildDecidePrompt,
    buildDetailsActions,
    buildGatherPrompt,
    buildLineItemActions,
    detectPageKind,
    evaluatePageGate,
    isAllowedGatherClick,
    isTableTabClick,
    modeLabel,
    pageKindLabel,
    sanitizeDetailsPlan,
    sanitizeLineItemsPlan,
    summarizeContextBuffer,
    valuesRoughlyEqual,
} from './lib/fill_plan.js';

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
            startRun(msg.mode || 'fill', msg.tabId, {
                overridePageGate: !!msg.overridePageGate,
            });
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
    const maxRetries = 3;
    let lastSendError = null;
    let injectError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await chrome.tabs.sendMessage(tabId, payload);
        } catch (e) {
            lastSendError = e;
            // Content script may not be present yet (fresh navigation / first load).
            // Try to (re)inject once, but don't treat an injection hiccup as fatal -
            // the script might still register on its own; keep retrying the send.
            if (attempt === 1) {
                try {
                    await injectContentScript(tabId);
                } catch (injErr) {
                    injectError = injErr;
                }
            }
            // Exponential backoff: let the page settle or the listener register.
            await sleep(attempt * 150);
        }
    }
    // Prefer the friendlier injection message (e.g. "page cannot be automated") when we have one.
    if (injectError) throw injectError;
    throw new Error(`Could not reach the page after ${maxRetries} attempts: ${lastSendError && lastSendError.message ? lastSendError.message : lastSendError}`);
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
        if (secs >= 90) suffix = ' - still working, will retry shortly if it stalls';
        else if (secs >= 45) suffix = ' - taking longer than usual (gemini-2.5-pro is thorough)';
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

async function startRun(mode, preferredTabId, opts = {}) {
    running = true;
    abortRequested = false;
    runController = new AbortController();
    post({ type: 'state', running: true });
    post({ type: 'run_started', mode });
    try {
        if (mode === 'fill_details' || mode === 'fill_line_items' || mode === 'fill') {
            // Legacy 'fill' maps to details-only (line items are a separate button).
            const fillMode = mode === 'fill' ? 'fill_details' : mode;
            await runGatherDecideFill(fillMode, preferredTabId, opts);
        } else {
            await runAgent(mode, preferredTabId, opts);
        }
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

/**
 * Cheap DOM page check before any Gemini call.
 * Returns false if the run should stop (blocked); true to continue.
 */
async function assertPageGate(mode, tabId, opts = {}) {
    const sigResp = await sendToTab(tabId, { cmd: 'page_signals' });
    if (!sigResp || !sigResp.ok) {
        // If we cannot read the page, do not invent a block — existing errors will surface.
        status('Page check skipped (could not read page signals).', 'warn');
        return true;
    }
    const detection = detectPageKind(sigResp.result || {});
    const gate = evaluatePageGate(mode, detection, opts);
    status(
        `Page check: ${pageKindLabel(detection.kind)} (${detection.confidence || 'low'})`
        + (gate.overridden ? ' - override enabled' : ''),
        gate.overridden ? 'warn' : 'info'
    );
    if (!gate.blocked) return true;

    const message = gate.message
        || `Wrong page for ${modeLabel(mode)} (detected ${detection.kind}).`;
    status(message, 'warn');
    post({
        type: 'page_gate_blocked',
        mode,
        required: gate.required,
        detected: detection.kind,
        confidence: detection.confidence,
        scores: detection.scores,
        message,
    });
    post({
        type: 'done',
        outcome: 'page_blocked',
        mode,
        required: gate.required,
        detected: detection.kind,
        message,
    });
    return false;
}

function taskHeader(mode) {
    if (mode === 'next') {
        return 'TASK MODE: NEXT. Open the oldest unassigned, not-in-progress batch from the batch list. '
            + 'Use click for batch rows and for batch-list pagination. When the batch has opened, call complete.';
    }
    if (mode === 'fill_line_items') {
        return 'TASK MODE: FILL LINE ITEMS. Human already opened Table view. Gather context, decide row values into memory, fill the table, then stop.';
    }
    return 'TASK MODE: FILL DETAILS. Gather context, decide header field values into memory, fill details only, then stop. Do not open Table or fill line items.';
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

async function runAgent(mode, preferredTabId, opts = {}) {
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

    if (!(await assertPageGate(mode, tab.id, opts))) return;

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

        // Stream the model's live reasoning to the Activity feed so the human can
        // follow what it is thinking on every step.
        if (action.reason) status(action.reason, 'think');
        if (action.note && action.note !== action.reason) status(action.note);

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

// ---------- gather → decide (memory) → fill at once ----------

async function runGatherDecideFill(mode, preferredTabId, opts = {}) {
    const { licenseKey } = await chrome.storage.local.get(['licenseKey']);
    if (!licenseKey) throw new Error('No License Key provided. Enter your license key in Settings.');
    await verifyLicenseOffline(licenseKey);

    const { geminiApiKey, geminiModel } = await getSettings();
    if (!geminiApiKey) throw new Error('No Gemini API key set. Open Settings and paste your key.');

    const systemInstruction = await loadSystemInstruction();
    const tab = await getTargetTab(preferredTabId);
    status(`Connecting to page: ${tab.title || tab.url}`);
    await ensureContentScript(tab.id);

    if (!(await assertPageGate(mode, tab.id, opts))) return;

    const signal = runController ? runController.signal : undefined;
    const memory = { mode, context: [], catalog: null, plan: null, skipped: [], errors: [] };

    // --- Phase 1: Gather ---
    status(`Gathering context for ${modeLabel(mode)}...`, 'think');
    const gatherHistory = [];
    for (let step = 1; step <= MAX_GATHER_STEPS; step += 1) {
        if (abortRequested) {
            status('Stopped by user.', 'warn');
            post({ type: 'done', outcome: 'stopped' });
            return;
        }

        const obsResp = await sendToTab(tab.id, { cmd: 'observe' });
        if (!obsResp || !obsResp.ok) throw new Error(`Could not read page: ${obsResp && obsResp.error}`);
        const o = obsResp.result;
        const shot = await captureViewport(tab.windowId);
        memory.context.push({
            text: o.text,
            html: (o.html || '').slice(0, 80000),
            scrollY: o.scroll && o.scroll.y,
            url: o.url,
        });

        const userText = buildGatherPrompt(mode, o, gatherHistory);
        const liteUserText = buildGatherPrompt(mode, { ...o, html: '(omitted)' }, gatherHistory);
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
            status('Gather response not clean JSON - retrying once...', 'warn');
            const raw2 = await think({
                apiKey: geminiApiKey,
                model: geminiModel,
                systemInstruction,
                userText: userText + '\n\nRespond with ONLY a single JSON object.',
                imageB64: shot || undefined,
                signal,
                liteUserText,
            });
            action = parseJsonResponse(raw2);
        }

        if (action.reason) status(action.reason, 'think');

        if (action.action === 'incomplete') {
            post({
                type: 'done',
                outcome: 'incomplete',
                reason: action.reason || 'Missing Information',
                flags: action.flags || [],
                message: action.note || action.reason || 'Marked incomplete during gather.',
            });
            status(`Incomplete: ${action.reason || 'Missing Information'}`, 'warn');
            return;
        }

        if (action.action === 'done_gathering' || action.done_gathering) {
            status(`Gather complete after ${step} step(s).`, 'success');
            break;
        }

        if (action.action === 'scroll') {
            const res = await executeAction(tab.id, action);
            const line = summarizeStep(action, res);
            gatherHistory.push(line);
            status(line, res && res.ok ? 'info' : 'warn');
            await sleep(500);
            continue;
        }

        if (action.action === 'click') {
            if (isTableTabClick(action) || !isAllowedGatherClick(action, mode)) {
                status('Skipping disallowed gather click (human opens Table; gather is read-only aside from doc page turns).', 'warn');
                gatherHistory.push(`blocked click ${action.selector || ''}`);
                continue;
            }
            const res = await executeAction(tab.id, action);
            const line = summarizeStep(action, res);
            gatherHistory.push(line);
            status(line, res && res.ok ? 'info' : 'warn');
            await sleep(1400);
            continue;
        }

        // Unknown gather action — treat as done_gathering to move forward.
        status(`Unrecognized gather action "${action.action}" - proceeding to decide.`, 'warn');
        break;
    }

    // --- Inventory catalog ---
    status('Inventorying form fields / table...', 'think');
    if (mode === 'fill_line_items') {
        // Human already navigated to Table view — inventory what is on screen.
        const tableInv = await sendToTab(tab.id, { cmd: 'inventory_table' });
        if (!tableInv || !tableInv.ok) throw new Error(`Could not inventory table: ${tableInv && tableInv.error}`);
        memory.catalog = tableInv.result;
        status(`Catalogued ${(memory.catalog.columns || []).length} columns, ${memory.catalog.row_count || 0} existing row(s).`, 'info');
    } else {
        const fieldsInv = await sendToTab(tab.id, { cmd: 'inventory_fields' });
        if (!fieldsInv || !fieldsInv.ok) throw new Error(`Could not inventory fields: ${fieldsInv && fieldsInv.error}`);
        memory.catalog = fieldsInv.result;
        status(`Catalogued ${(memory.catalog.fields || []).length} fields.`, 'info');
    }

    // --- Phase 2: Decide into memory ---
    status('Deciding field/row values from gathered context...', 'think');
    const contextSummary = summarizeContextBuffer(memory.context);
    const decideText = buildDecidePrompt(mode, contextSummary, memory.catalog);
    // Attach latest screenshot for decide.
    const lastShot = await captureViewport(tab.windowId);
    const decideRaw = await think({
        apiKey: geminiApiKey,
        model: geminiModel,
        systemInstruction,
        userText: decideText,
        imageB64: lastShot || undefined,
        signal,
        liteUserText: buildDecidePrompt(mode, contextSummary.slice(0, 12000), memory.catalog),
    });

    let decideObj;
    try {
        decideObj = parseJsonResponse(decideRaw);
    } catch (e) {
        const raw2 = await think({
            apiKey: geminiApiKey,
            model: geminiModel,
            systemInstruction,
            userText: decideText + '\n\nPrevious reply was not valid JSON. Respond with ONLY JSON.',
            imageB64: lastShot || undefined,
            signal,
        });
        decideObj = parseJsonResponse(raw2);
    }

    const sanitized = mode === 'fill_line_items'
        ? sanitizeLineItemsPlan(decideObj, memory.catalog)
        : sanitizeDetailsPlan(decideObj, memory.catalog);

    memory.errors = sanitized.errors || [];
    memory.skipped = sanitized.skipped || [];
    memory.plan = sanitized.plan;

    if (!sanitized.ok || !memory.plan) {
        throw new Error(`Could not build a fill plan: ${(sanitized.errors || []).join('; ') || 'invalid plan'}`);
    }

    if (memory.plan.kind === 'incomplete') {
        post({
            type: 'done',
            outcome: 'incomplete',
            reason: memory.plan.reason,
            flags: memory.plan.flags || [],
            message: memory.plan.note || memory.plan.reason,
        });
        status(`Incomplete: ${memory.plan.reason}`, 'warn');
        return;
    }

    if (memory.skipped.length) {
        status(`Skipping ${memory.skipped.length} low-confidence / unknown entries.`, 'warn');
    }
    if (mode === 'fill_details') {
        status(`Mapped ${(memory.plan.fields || []).length} detail fields into memory.`, 'success');
    } else {
        status(`Mapped ${(memory.plan.rows || []).length} line-item rows into memory.`, 'success');
    }

    // --- Phase 3: Fill at once ---
    status('Filling from memory...', 'think');
    if (mode === 'fill_line_items') {
        await executeLineItemsFromMemory(tab.id, memory, {
            apiKey: geminiApiKey,
            model: geminiModel,
            systemInstruction,
            signal,
        });
    } else {
        await executeDetailsFromMemory(tab.id, memory, {
            apiKey: geminiApiKey,
            model: geminiModel,
            systemInstruction,
            signal,
        });
    }
}

async function executeDetailsFromMemory(tabId, memory, llm) {
    const plan = memory.plan;
    const catalog = memory.catalog;
    const actions = buildDetailsActions(plan, catalog);
    if (!actions.length) {
        status('No detail fields to fill from plan.', 'warn');
    }

    let filled = 0;
    let failed = 0;
    const failures = [];
    let recoveryLeft = MAX_RECOVERY_CALLS;

    for (const action of actions) {
        if (abortRequested) {
            post({ type: 'done', outcome: 'stopped' });
            return;
        }

        let res;
        if (action.cmd === 'select') {
            status(`Setting document type: ${action.value}`, 'info');
            res = await sendToTab(tabId, { cmd: 'select', selector: action.selector, value: action.value });
        } else {
            status(`Fill ${action.field_id} = ${action.value}`, 'info');
            res = await sendToTab(tabId, {
                cmd: 'fill_by_id',
                field_id: action.field_id,
                value: action.value,
                selector: action.selector,
            });
        }

        if (!res || !res.ok) {
            if (recoveryLeft > 0 && action.cmd !== 'select') {
                recoveryLeft -= 1;
                status(`Recovery for ${action.field_id}: ${res && res.error}`, 'warn');
                const inv = await sendToTab(tabId, { cmd: 'inventory_fields' });
                if (inv && inv.ok) memory.catalog = inv.result;
                const retry = await sendToTab(tabId, {
                    cmd: 'fill_by_id',
                    field_id: action.field_id,
                    value: action.value,
                    selector: action.selector,
                });
                if (retry && retry.ok) {
                    filled += 1;
                    await sleep(300);
                    continue;
                }
            }
            failed += 1;
            failures.push(`${action.field_id || action.purpose}: ${res && res.error}`);
            continue;
        }

        if (action.cmd !== 'select') {
            const read = await sendToTab(tabId, {
                cmd: 'read_field',
                field_id: action.field_id,
                selector: action.selector,
            });
            if (read && read.ok && !valuesRoughlyEqual(action.value, read.result.value)) {
                status(`Verify mismatch on ${action.field_id} - retrying`, 'warn');
                await sendToTab(tabId, {
                    cmd: 'fill_by_id',
                    field_id: action.field_id,
                    value: action.value,
                    selector: action.selector,
                });
            }
        }
        filled += 1;
        await sleep(action.cmd === 'select' ? 400 : 250);
    }

    const summary = `Filled ${filled} detail field(s)`
        + (failed ? `, ${failed} failed` : '')
        + (memory.skipped.length ? `, ${memory.skipped.length} skipped` : '')
        + '. Stopped after Fill Details - open Table yourself for line items if needed.';

    if (failed && filled === 0) {
        throw new Error(`Fill details failed: ${failures.join('; ')}`);
    }

    post({
        type: 'done',
        outcome: 'complete',
        doc_type: plan.doc_type || null,
        red_fields: plan.red_fields || [],
        flags: plan.flags || [],
        message: summary + (failures.length ? ` Failures: ${failures.join('; ')}` : ''),
    });
    status(summary, failed ? 'warn' : 'success');
}

async function executeLineItemsFromMemory(tabId, memory, llm) {
    const plan = memory.plan;
    let catalog = memory.catalog;

    // Human already opened Table view — do not click table_tab.
    const actions = buildLineItemActions(plan, catalog);
    if (actions.some((a) => a.purpose === 'table_tab')) {
        throw new Error('Internal error: line-item plan tried to open Table tab');
    }

    let filledRows = 0;
    let failedRows = 0;
    const failures = [];

    for (const action of actions) {
        if (abortRequested) {
            post({ type: 'done', outcome: 'stopped' });
            return;
        }

        if (action.purpose === 'clear_table') {
            status('Clearing existing table rows...', 'info');
            const res = await sendToTab(tabId, { cmd: 'click', selector: action.selector });
            if (!res || !res.ok) {
                failures.push(`clear: ${res && res.error}`);
            }
            await sleep(1000);
            const refreshed = await sendToTab(tabId, { cmd: 'inventory_table' });
            if (refreshed && refreshed.ok) {
                catalog = refreshed.result;
                memory.catalog = catalog;
            }
            continue;
        }

        if (action.purpose === 'add_row') {
            let prevCount = 0;
            const before = await sendToTab(tabId, { cmd: 'inventory_table' });
            if (before && before.ok) prevCount = before.result.row_count || 0;

            status(`Line item ${(action.row_index || 0) + 1}: Add Row`, 'info');
            const clickRes = await sendToTab(tabId, { cmd: 'click', selector: action.selector });
            if (!clickRes || !clickRes.ok) {
                failedRows += 1;
                failures.push(`row ${(action.row_index || 0) + 1}: add_row failed (${clickRes && clickRes.error})`);
                continue;
            }
            await sendToTab(tabId, {
                cmd: 'wait_for_row',
                prev_count: prevCount,
                timeout_ms: 4000,
            });
            await sleep(400);
            continue;
        }

        if (action.purpose === 'fill_row') {
            const inv = await sendToTab(tabId, { cmd: 'inventory_table' });
            const rowSelector = (inv && inv.ok && inv.result.row_selector)
                || catalog.row_selector
                || action.row_selector
                || 'table tbody tr:last-child';
            status(`Line item ${(action.row_index || 0) + 1}: ${((action.values) || []).join(' | ')}`, 'info');
            const fillRes = await sendToTab(tabId, {
                cmd: 'fill_row',
                row_selector: rowSelector,
                values: action.values || [],
            });
            if (!fillRes || !fillRes.ok) {
                failedRows += 1;
                failures.push(`row ${(action.row_index || 0) + 1}: ${fillRes && fillRes.error}`);
                continue;
            }
            filledRows += 1;
            await sleep(300);
        }
    }

    const summary = `Filled ${filledRows} line-item row(s)`
        + (failedRows ? `, ${failedRows} failed` : '')
        + (memory.skipped.length ? `, ${memory.skipped.length} skipped` : '')
        + '. Stopped after Fill Line Items.';

    if (filledRows === 0 && (plan.rows || []).length > 0) {
        throw new Error(`Fill line items failed: ${failures.join('; ') || 'no rows filled'}`);
    }

    post({
        type: 'done',
        outcome: 'complete',
        flags: plan.flags || [],
        message: summary + (failures.length ? ` Failures: ${failures.join('; ')}` : ''),
    });
    status(summary, failedRows ? 'warn' : 'success');
}

