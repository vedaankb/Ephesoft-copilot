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
        let proto = null;
        if (el instanceof HTMLInputElement) proto = HTMLInputElement.prototype;
        else if (el instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
        else if (el instanceof HTMLSelectElement) proto = HTMLSelectElement.prototype;

        if (proto) {
            const desc = Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(el, value);
            else el.value = value;
        } else {
            el.value = value;
        }
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

    function findElementRecursive(root, selector) {
        let el = null;
        try { el = root.querySelector(selector); } catch (e) { /* ignore */ }
        if (el) return el;

        const iframes = Array.from(root.querySelectorAll('iframe'));
        for (const iframe of iframes) {
            try {
                if (iframe.contentDocument) {
                    el = findElementRecursive(iframe.contentDocument, selector);
                    if (el) return el;
                }
            } catch (e) { /* cross-origin */ }
        }
        return null;
    }

    function query(selector) {
        if (!selector) throw new Error('No selector provided');

        // BASELINE (original behavior): a plain top-document lookup. This always runs
        // first and is the source of truth for "invalid selector" errors.
        let el = null;
        let cssError = null;
        try { el = document.querySelector(selector); }
        catch (e) { cssError = e.message; }
        if (el) return el;

        // ENHANCEMENT 1 (additive): search same-origin iframes. Fully guarded so any
        // failure here can never break the baseline path above.
        try {
            const inFrame = findElementRecursive(document, selector);
            if (inFrame) return inFrame;
        } catch (e) { /* enhancement failed - ignore, fall through */ }

        // ENHANCEMENT 2 (additive): fuzzy recovery by label/attribute hint. Guarded.
        try {
            const recovered = recoverElementRecursive(document, selector);
            if (recovered) return recovered;
        } catch (e) { /* enhancement failed - ignore, fall through */ }

        // Build a helpful error; the hint is best-effort and must not throw.
        let hint = '';
        try { hint = nearbyHintRecursive(document, selector); } catch (e) { hint = ''; }
        if (cssError) {
            throw new Error(`Invalid selector '${selector}': ${cssError}. ${hint}`);
        }
        throw new Error(`Element not found: ${selector}. ${hint}`);
    }

    // Pull a human-readable hint token out of a selector so we can fuzzy-match it
    // against placeholders / aria-labels / names / ids / visible text.
    function selectorHint(selector) {
        const attr = selector.match(/\[[^\]]*?["']([^"']+)["']\]/); // [name="foo"] -> foo
        if (attr && attr[1]) return attr[1].toLowerCase();
        const idc = selector.match(/[#.]([A-Za-z0-9_-]{2,})/); // #foo / .foo -> foo
        if (idc && idc[1]) return idc[1].toLowerCase();
        const bare = selector.replace(/[^A-Za-z0-9 _-]/g, ' ').trim();
        return bare.toLowerCase();
    }

    // Best-effort element recovery when a CSS selector no longer resolves.
    function recoverElementRecursive(root, selector) {
        const hint = selectorHint(selector);
        if (!hint || hint.length < 2) return null;
        const attrSel = [
            `[placeholder*="${hint}" i]`,
            `[aria-label*="${hint}" i]`,
            `[name*="${hint}" i]`,
            `[id*="${hint}" i]`,
            `[title*="${hint}" i]`,
        ].join(',');
        
        // 1. Try attribute matching on the current root
        let el = null;
        try { el = root.querySelector(attrSel); } catch (e) { /* ignore */ }
        if (el) return el;

        // 2. Try label matching on the current root
        try {
            const labels = Array.from(root.querySelectorAll('label'));
            for (const lab of labels) {
                if ((lab.innerText || '').toLowerCase().includes(hint)) {
                    if (lab.htmlFor) {
                        const bound = root.getElementById(lab.htmlFor);
                        if (bound) return bound;
                    }
                    const inner = lab.querySelector('input, textarea, select, [contenteditable="true"]');
                    if (inner) return inner;
                }
            }
        } catch (e) { /* ignore */ }

        // 3. Recurse into same-origin iframes
        const iframes = Array.from(root.querySelectorAll('iframe'));
        for (const iframe of iframes) {
            try {
                if (iframe.contentDocument) {
                    el = recoverElementRecursive(iframe.contentDocument, selector);
                    if (el) return el;
                }
            } catch (e) { /* cross-origin */ }
        }
        return null;
    }

    // Produce a short list of visible candidate fields to help the model retry.
    function nearbyHintRecursive(root, selector) {
        try {
            const hint = selectorHint(selector);
            const allFields = [];
            
            function collectFields(node) {
                try {
                    const fields = Array.from(node.querySelectorAll('input, textarea, select'))
                        .filter(f => f.offsetParent !== null)
                        .map(f => {
                            const id = f.id ? `#${f.id}` : '';
                            const nm = f.name ? `[name="${f.name}"]` : '';
                            const ph = f.placeholder ? ` ph="${f.placeholder}"` : '';
                            return (id || nm || f.tagName.toLowerCase()) + ph;
                        });
                    allFields.push(...fields);
                } catch (e) { /* ignore */ }

                const iframes = Array.from(node.querySelectorAll('iframe'));
                for (const iframe of iframes) {
                    try {
                        if (iframe.contentDocument) {
                            collectFields(iframe.contentDocument);
                        }
                    } catch (e) { /* cross-origin */ }
                }
            }

            collectFields(root);
            const sliced = allFields.slice(0, 8);
            if (!sliced.length) return 'No visible input fields detected - the target may be in an inaccessible iframe or not yet loaded.';
            return `Nearby fields you can target instead: ${sliced.join(', ')}.`;
        } catch (e) {
            return '';
        }
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

    // Resolve the element that actually carries the click behaviour. Models often
    // target a <span>/<div> holding the visible text (e.g. a batch number) when the
    // real handler lives on an enclosing <a>, <button>, row, or [onclick] element.
    function resolveClickTarget(el) {
        const actionable = el.closest && el.closest(
            'a[href], button, [role="button"], [role="link"], input[type="button"], '
            + 'input[type="submit"], [onclick], td[onclick], tr[onclick], li[onclick]'
        );
        if (actionable && !bannedReason(actionable)) return actionable;
        return el;
    }

    function dispatchRealClick(target) {
        target.scrollIntoView && target.scrollIntoView({ block: 'center', inline: 'center' });
        const opts = { bubbles: true, cancelable: true, view: window };
        try { target.focus && target.focus({ preventScroll: true }); } catch (e) { /* noop */ }
        try { target.dispatchEvent(new PointerEvent('pointerover', opts)); } catch (e) { /* older */ }
        target.dispatchEvent(new MouseEvent('mouseover', opts));
        try { target.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) { /* older */ }
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        try { target.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) { /* older */ }
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
        // Native activation (fires onclick handlers/anchors the same way a real click does).
        try { if (typeof target.click === 'function') target.click(); } catch (e) { /* noop */ }
    }

    function domClick(selector) {
        const el = query(selector);
        const target = resolveClickTarget(el);
        const banned = bannedReason(target) || bannedReason(el);
        if (banned) {
            throw new Error(`SAFETY: refusing to click '${selector}' - matches banned action "${banned}". The human performs that action.`);
        }

        dispatchRealClick(target);

        // Only force navigation for real URL anchors. Skip in-page (#) and
        // javascript: links - those rely on the JS click we already dispatched,
        // and forcing location would break SPA routers / reload the page.
        const anchor = target.closest && target.closest('a[href]');
        if (anchor && !bannedReason(anchor)) {
            const hrefAttr = (anchor.getAttribute('href') || '').trim();
            if (anchor.href && !/^(#|javascript:)/i.test(hrefAttr)) {
                window.location.href = anchor.href;
            }
        }

        const clickedTag = target.tagName ? target.tagName.toLowerCase() : 'node';
        return { clicked: selector, actionedTag: clickedTag };
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
            const val = values[i];
            if (el instanceof HTMLSelectElement) {
                // Use the same smart option matching as domSelect
                const want = String(val).toLowerCase().trim();
                let matched = null;
                for (const opt of el.options) {
                    const ov = (opt.value || '').toLowerCase().trim();
                    const ot = (opt.text || '').toLowerCase().trim();
                    if (ov === want || ot === want || ot.includes(want) || ov.includes(want)) {
                        matched = opt.value;
                        break;
                    }
                }
                if (matched !== null) {
                    setNativeValue(el, matched);
                } else {
                    setNativeValue(el, val);
                }
            } else if ('value' in el) {
                setNativeValue(el, val);
            } else {
                el.textContent = val;
            }
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

    // Send as much of the DOM as we reasonably can - gemini-2.5-pro has a huge
    // context window, so the limiting factor is signal, not size. We strip only
    // truly useless nodes (scripts/styles/svg/comments/data-URIs) and recursively
    // inline same-origin iframe contents so the model has complete page visibility.
    const HTML_MAX = 500000;

    // Compress + cap a cloned root element into the string we send to the model.
    function serializeClone(clone, cap) {
        clone.querySelectorAll('script, style, noscript, svg, link, meta, head').forEach(n => n.remove());
        let html = clone.outerHTML || '';
        html = html.replace(/<!--[\s\S]*?-->/g, '');            // drop HTML comments
        html = html.replace(/(src|href)="data:[^"]*"/gi, '$1="data:..."'); // shrink inline data URIs
        html = html.replace(/\s+/g, ' ').trim();
        return html.slice(0, cap);
    }

    // BASELINE (original behavior): top-document only. Never throws for iframe reasons.
    function cleanHtmlBasic(cap) {
        const clone = document.documentElement.cloneNode(true);
        return serializeClone(clone, cap);
    }

    // ENHANCEMENT (additive): also inline same-origin iframe contents. If ANYTHING
    // in here fails, cleanHtml() falls back to cleanHtmlBasic so observation never breaks.
    function cleanHtmlWithFrames(cap) {
        const realIframes = Array.from(document.querySelectorAll('iframe'));
        if (!realIframes.length) return cleanHtmlBasic(cap); // nothing extra to do

        realIframes.forEach((iframe, idx) => {
            try { iframe.setAttribute('data-copilot-iframe-idx', idx); } catch (e) { /* ignore */ }
        });
        const clone = document.documentElement.cloneNode(true);
        // Always untag the live DOM immediately, even if later steps throw.
        realIframes.forEach(iframe => {
            try { iframe.removeAttribute('data-copilot-iframe-idx'); } catch (e) { /* ignore */ }
        });

        clone.querySelectorAll('script, style, noscript, svg, link, meta, head').forEach(n => n.remove());

        clone.querySelectorAll('iframe').forEach(clonedIframe => {
            const idxAttr = clonedIframe.getAttribute('data-copilot-iframe-idx');
            if (idxAttr === null) return;
            const realIframe = realIframes[parseInt(idxAttr, 10)];
            try {
                if (realIframe && realIframe.contentDocument) {
                    const iframeClone = realIframe.contentDocument.documentElement.cloneNode(true);
                    iframeClone.querySelectorAll('script, style, noscript, svg, link, meta, head').forEach(n => n.remove());
                    const container = document.createElement('div');
                    container.setAttribute('data-iframe-id', realIframe.id || '');
                    container.setAttribute('data-iframe-name', realIframe.name || '');
                    container.setAttribute('data-iframe-src', realIframe.src || '');
                    container.innerHTML = iframeClone.innerHTML;
                    clonedIframe.replaceWith(container);
                }
            } catch (e) { /* cross-origin - leave the <iframe> tag as-is */ }
        });

        let html = clone.outerHTML || '';
        html = html.replace(/<!--[\s\S]*?-->/g, '');
        html = html.replace(/(src|href)="data:[^"]*"/gi, '$1="data:..."');
        html = html.replace(/\s+/g, ' ').trim();
        return html.slice(0, cap);
    }

    function cleanHtml(maxLen) {
        const cap = maxLen || HTML_MAX;
        try {
            return cleanHtmlWithFrames(cap);
        } catch (e) {
            // Enhancement failed for any reason - guarantee the original behavior.
            try { return cleanHtmlBasic(cap); }
            catch (e2) { return ''; }
        }
    }

    function visibleText(maxLen) {
        const cap = maxLen || 40000;
        // BASELINE (original behavior): top-document innerText.
        const baseText = (document.body && document.body.innerText) || '';
        // ENHANCEMENT (additive): append same-origin iframe text. Guarded so a failure
        // just returns the baseline instead of breaking observation.
        let fullText = baseText;
        try {
            function getFrameText(doc) {
                let t = '';
                const iframes = Array.from(doc.querySelectorAll('iframe'));
                for (const iframe of iframes) {
                    try {
                        if (iframe.contentDocument) {
                            const body = iframe.contentDocument.body;
                            if (body && body.innerText) t += '\n\n' + body.innerText;
                            t += getFrameText(iframe.contentDocument);
                        }
                    } catch (e) { /* cross-origin */ }
                }
                return t;
            }
            fullText = baseText + getFrameText(document);
        } catch (e) {
            fullText = baseText;
        }
        return fullText.replace(/\n{3,}/g, '\n\n').slice(0, cap);
    }

    function observe() {
        const doc = document.documentElement;
        const maxY = Math.max(0, (doc.scrollHeight || 0) - (window.innerHeight || 0));
        const y = window.scrollY || 0;
        return {
            url: location.href,
            title: document.title,
            html: cleanHtml(HTML_MAX),
            text: visibleText(40000),
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
