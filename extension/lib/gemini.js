/**
 * Minimal Gemini REST client for the extension (zero dependencies).
 *
 * Uses the public Generative Language API over plain HTTPS fetch, so there is
 * no Python, no gRPC, and no native SSL stack involved - just the browser's own
 * TLS, which corporate proxies already trust.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Build an AbortSignal that fires when either the caller's signal aborts or a
 * timeout elapses. Avoids AbortSignal.any so we stay compatible with Chrome 114.
 */
function withTimeout(external, timeoutMs) {
    const ctrl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctrl.abort(external && external.reason);
    if (external) {
        if (external.aborted) ctrl.abort(external.reason);
        else external.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    return {
        signal: ctrl.signal,
        didTimeout: () => timedOut,
        cleanup: () => {
            clearTimeout(timer);
            if (external) external.removeEventListener('abort', onAbort);
        },
    };
}

/**
 * Call generateContent with an optional inline screenshot.
 * @returns {Promise<string>} the model's text output (expected to be JSON)
 */
export async function callGemini({ apiKey, model, systemInstruction, userText, imageB64, signal, timeoutMs }) {
    if (!apiKey) throw new Error('No Gemini API key set. Open Settings in the panel and paste your key.');
    const mdl = model || 'gemini-2.5-pro';
    const url = `${API_BASE}/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const parts = [{ text: userText }];
    if (imageB64) {
        parts.push({ inline_data: { mime_type: 'image/png', data: imageB64 } });
    }

    const body = {
        contents: [{ role: 'user', parts }],
        generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
        },
    };
    if (systemInstruction) {
        body.system_instruction = { parts: [{ text: systemInstruction }] };
    }

    const timeout = withTimeout(signal, timeoutMs || DEFAULT_TIMEOUT_MS);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: timeout.signal,
        });
    } catch (e) {
        // Distinguish a timeout / user-Stop abort from a real network failure.
        if (e && e.name === 'AbortError') {
            if (timeout.didTimeout()) {
                throw new Error(`Gemini timed out after ${(timeoutMs || DEFAULT_TIMEOUT_MS) / 1000}s. Try a faster model or check connectivity.`);
            }
            const err = new Error('Gemini request aborted.');
            err.name = 'AbortError';
            throw err;
        }
        throw new Error(`Network error calling Gemini: ${e.message}. Check connectivity / proxy allowlist for generativelanguage.googleapis.com`);
    } finally {
        timeout.cleanup();
    }

    if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 400); } catch (e) { /* ignore */ }
        if (res.status === 400 && /API key not valid/i.test(detail)) {
            throw new Error('Gemini API key is not valid. Create one at https://aistudio.google.com/apikey and paste it in Settings.');
        }
        if (res.status === 403) {
            throw new Error(`Gemini access denied (403). Key may lack access to model "${mdl}". ${detail}`);
        }
        if (res.status === 404) {
            throw new Error(`Model "${mdl}" not found (404). Pick a different model in Settings. ${detail}`);
        }
        if (res.status === 429) {
            throw new Error('Gemini rate limit hit (429). Wait a moment and retry.');
        }
        throw new Error(`Gemini error ${res.status}: ${detail}`);
    }

    const data = await res.json();
    const cand = data && data.candidates && data.candidates[0];
    if (!cand) {
        const reason = data && data.promptFeedback && data.promptFeedback.blockReason;
        throw new Error(`Gemini returned no candidates${reason ? ` (blocked: ${reason})` : ''}.`);
    }
    const text = (cand.content && cand.content.parts || [])
        .map(p => p.text || '')
        .join('')
        .trim();
    if (!text) throw new Error('Gemini returned an empty response.');
    return text;
}

/** Parse a JSON object out of a model response, tolerating code fences. */
export function parseJsonResponse(text) {
    let t = (text || '').trim();
    if (t.startsWith('```')) {
        t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
    }
    try {
        return JSON.parse(t);
    } catch (e) {
        // Last resort: grab the first {...} block.
        const m = t.match(/\{[\s\S]*\}/);
        if (m) {
            try { return JSON.parse(m[0]); } catch (e2) { /* fallthrough */ }
        }
        throw new Error(`Could not parse model JSON: ${t.slice(0, 200)}`);
    }
}

/** Quick connectivity/key check using a tiny prompt. */
export async function testApiKey({ apiKey, model }) {
    const text = await callGemini({
        apiKey,
        model,
        userText: 'Reply with this exact JSON: {"ok": true}',
    });
    const obj = parseJsonResponse(text);
    return !!obj.ok;
}
