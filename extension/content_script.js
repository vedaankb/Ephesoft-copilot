/**
 * Ephesoft Copilot - content script (DOM controller).
 *
 * Runs inside the Ephesoft page. The service worker sends it one DOM command at
 * a time; it reads or mutates the page and replies. All writes go through a
 * realistic event sequence so framework widgets react. A strict runtime guard
 * makes it physically impossible to click Validate / Skip / Merge / Split /
 * Submit, regardless of what the model asks for.
 */

(() => {
    if (window.__ephesoftCopilotInjected) return;
    window.__ephesoftCopilotInjected = true;

    // --- safety guard: never click these, no matter what ---
    // Multi-word phrases are matched as substrings anywhere in the element's
    // label (text/aria/title/id/class). Short ambiguous tokens are matched ONLY
    // as the exact visible text/value of a control, so we block the real
    // "Validate" / "Submit" / "Skip" buttons without blocking unrelated elements
    // that merely contain those letters (e.g. "Skip to content", a CSS class).
    const BANNED_PHRASES = [
        'validate',
        'skip batch',
        'skip document',
        'merge document',
        'merge documents',
        'split document',
        'split documents',
        'delete batch',
        'delete document',
        'finish batch',
        'review later',
    ];
    const BANNED_EXACT = ['validate', 'skip', 'submit', 'merge', 'split', 'delete'];

    function elementLabel(el) {
        if (!el) return '';
        const parts = [
            el.innerText,
            el.value,
            el.getAttribute && el.getAttribute('aria-label'),
            el.getAttribute && el.getAttribute('title'),
            el.getAttribute && el.getAttribute('name'),
            el.id,
            el.className && typeof el.className === 'string' ? el.className : '',
        ];
        return parts.filter(Boolean).join(' ').toLowerCase();
    }

    function visibleLabel(el) {
        return String((el && (el.innerText || el.value)) || '').trim().toLowerCase();
    }

    function bannedReason(el) {
        // Check the element and its closest actionable ancestor.
        const closest = el.closest && el.closest('button, a, [role="button"], input[type="button"], input[type="submit"]');
        const targets = [el, closest].filter(Boolean);
        for (const t of targets) {
            const label = elementLabel(t);
            for (const p of BANNED_PHRASES) {
                if (label.includes(p)) return p;
            }
            const visible = visibleLabel(t);
            if (visible && BANNED_EXACT.includes(visible)) return visible;
        }
        return null;
    }

    // --- value setting that frameworks (React/Angular/GWT) actually observe ---
    function setNativeValue(el, value) {
        const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value);
        else el.value = value;
    }

    function fireInputEvents(el) {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Process' }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process' }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('blur', { bubbles: true }));
    }

    function toIsoDate(value) {
        if (!value) return null;
        const s = String(value).trim();
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
        const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
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

    function query(selector) {
        if (!selector) throw new Error('No selector provided');
        let el;
        try { el = document.querySelector(selector); }
        catch (e) { throw new Error(`Invalid selector '${selector}': ${e.message}`); }
        if (!el) throw new Error(`Element not found: ${selector}`);
        return el;
    }

    // --- DOM operations ---

    function domFill(selector, value) {
        const el = query(selector);
        // A <select> is "fillable" only via option matching - route it correctly
        // (setting an <input> value setter on a <select> would misbehave).
        if (el instanceof HTMLSelectElement) return domSelect(selector, value);

        const editable = el.isContentEditable;
        if (!('value' in el) && !editable) {
            throw new Error(`Element ${selector} is not fillable (tag ${el.tagName.toLowerCase()})`);
        }
        let v = value == null ? '' : String(value);
        const type = (el.getAttribute && (el.getAttribute('type') || '').toLowerCase()) || '';
        if (type === 'date') v = toIsoDate(v) || v;

        el.focus && el.focus();
        if ('value' in el) setNativeValue(el, v);
        else el.textContent = v;
        fireInputEvents(el);
        return { filled: selector, value: v };
    }

    function domSelect(selector, value) {
        const el = query(selector);
        if (!(el instanceof HTMLSelectElement)) {
            if ('value' in el) {
                setNativeValue(el, value);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                return { selected: selector, value };
            }
            throw new Error(`Element ${selector} is not a select`);
        }
        const want = String(value).toLowerCase().trim();
        let matched = null;
        for (const opt of el.options) {
            const ov = (opt.value || '').toLowerCase().trim();
            const ot = (opt.text || '').toLowerCase().trim();
            if (ov === want || ot === want || ot.includes(want) || ov.includes(want)) {
                matched = opt.value;
                break;
            }
        }
        if (matched == null) {
            const available = Array.from(el.options).map(o => o.text).join(' | ');
            throw new Error(`No option matches '${value}' in ${selector}. Options: ${available}`);
        }
        el.value = matched;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { selected: selector, value: matched };
    }

    function domClick(selector) {
        const el = query(selector);
        const banned = bannedReason(el);
        if (banned) {
            throw new Error(`SAFETY: refusing to click '${selector}' - matches banned action "${banned}". The human performs that action.`);
        }
        el.scrollIntoView && el.scrollIntoView({ block: 'center', inline: 'center' });
        const opts = { bubbles: true, cancelable: true, view: window };
        try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) { /* older */ }
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) { /* older */ }
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.dispatchEvent(new MouseEvent('click', opts));

        // Only force navigation for real URL anchors. Skip in-page (#) and
        // javascript: links - those rely on the JS click we already dispatched,
        // and forcing location would break SPA routers / reload the page.
        const anchor = el.closest && el.closest('a[href]');
        if (anchor && !bannedReason(anchor)) {
            const hrefAttr = (anchor.getAttribute('href') || '').trim();
            if (anchor.href && !/^(#|javascript:)/i.test(hrefAttr)) {
                window.location.href = anchor.href;
            }
        }
        return { clicked: selector };
    }

    function domFillRow(rowSelector, values) {
        const row = query(rowSelector);
        const inputs = Array.from(row.querySelectorAll('input, textarea, select')).filter(el => {
            const t = (el.getAttribute('type') || '').toLowerCase();
            if (t === 'hidden') return false;
            if (el.disabled || el.readOnly) return false;
            return true;
        });
        let filled = 0;
        for (let i = 0; i < values.length && i < inputs.length; i += 1) {
            const el = inputs[i];
            el.focus && el.focus();
            if (el instanceof HTMLSelectElement) el.value = values[i];
            else if ('value' in el) setNativeValue(el, values[i]);
            else el.textContent = values[i];
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true }));
            filled += 1;
        }
        return { filled };
    }

    function domExists(selector) {
        try { return { count: document.querySelectorAll(selector).length }; }
        catch (e) { return { count: 0 }; }
    }

    function scrollableAncestor(el) {
        let node = el;
        while (node && node !== document.body) {
            const style = getComputedStyle(node);
            const oy = style.overflowY;
            if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight + 4) return node;
            node = node.parentElement;
        }
        return null;
    }

    function domScroll(selector, direction) {
        let target = null;
        if (selector) {
            try { target = document.querySelector(selector); } catch (e) { target = null; }
            if (target) target = scrollableAncestor(target) || target;
        }
        const dir = (direction || 'down').toLowerCase();
        if (target && target !== document.body && target.scrollHeight > target.clientHeight + 4) {
            const step = Math.round(target.clientHeight * 0.85);
            if (dir === 'down') target.scrollTop += step;
            else if (dir === 'up') target.scrollTop -= step;
            else if (dir === 'top') target.scrollTop = 0;
            else if (dir === 'bottom') target.scrollTop = target.scrollHeight;
            return { scrolled: selector || 'container', scrollTop: target.scrollTop };
        }
        // Fall back to window scroll.
        const step = Math.round(window.innerHeight * 0.85);
        if (dir === 'down') window.scrollBy(0, step);
        else if (dir === 'up') window.scrollBy(0, -step);
        else if (dir === 'top') window.scrollTo(0, 0);
        else if (dir === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight);
        return { scrolled: 'window', scrollY: window.scrollY };
    }

    function setScrollY(y) {
        window.scrollTo({ top: Number(y) || 0, behavior: 'auto' });
        return { scrollY: window.scrollY };
    }

    // --- observation: cleaned HTML + visible text + scroll state ---

    function cleanHtml(maxLen) {
        const clone = document.documentElement.cloneNode(true);
        clone.querySelectorAll('script, style, noscript, svg, link, meta, head').forEach(n => n.remove());
        let html = clone.outerHTML || '';
        html = html.replace(/\s+/g, ' ').trim();
        return html.slice(0, maxLen || 18000);
    }

    function visibleText(maxLen) {
        const t = (document.body && document.body.innerText) || '';
        return t.replace(/\n{3,}/g, '\n\n').slice(0, maxLen || 8000);
    }

    function observe() {
        const doc = document.documentElement;
        const maxY = Math.max(0, (doc.scrollHeight || 0) - (window.innerHeight || 0));
        const y = window.scrollY || 0;
        return {
            url: location.href,
            title: document.title,
            html: cleanHtml(18000),
            text: visibleText(8000),
            scroll: {
                y,
                maxY,
                atBottom: y >= maxY - 4,
                viewportHeight: window.innerHeight || 0,
                pageHeight: doc.scrollHeight || 0,
            },
        };
    }

    // --- message router ---

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || !msg.cmd) return;
        try {
            let result;
            switch (msg.cmd) {
                case 'ping': result = { pong: true }; break;
                case 'observe': result = observe(); break;
                case 'get_html': result = { html: cleanHtml(msg.maxLen) }; break;
                case 'fill': result = domFill(msg.selector, msg.value); break;
                case 'select': result = domSelect(msg.selector, msg.value); break;
                case 'click': result = domClick(msg.selector); break;
                case 'fill_row': result = domFillRow(msg.row_selector, msg.values || []); break;
                case 'exists': result = domExists(msg.selector); break;
                case 'scroll': result = domScroll(msg.selector, msg.direction); break;
                case 'set_scroll_y': result = setScrollY(msg.y); break;
                default: throw new Error(`Unknown cmd: ${msg.cmd}`);
            }
            sendResponse({ ok: true, result });
        } catch (e) {
            sendResponse({ ok: false, error: e && e.message ? e.message : String(e) });
        }
        return true; // keep the message channel open for async sendResponse
    });
})();
