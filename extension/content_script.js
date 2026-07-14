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
    // Also lift decorative img/icon nodes to GWT / role=button parents.
    function resolveClickTarget(el) {
        if (!el) return el;
        if (el.tagName && /^(IMG|SVG|I|SPAN)$/i.test(el.tagName)) {
            const iconParent = el.closest && el.closest(
                'a[href], button, [role="button"], [role="link"], [onclick], '
                + '[class*="Button"], [class*="button"], td, th, li'
            );
            if (iconParent && !bannedReason(iconParent)) {
                const deeper = iconParent.closest
                    && iconParent.closest('a[href], button, [role="button"], [role="link"], [onclick]');
                if (deeper && !bannedReason(deeper)) return deeper;
                return iconParent;
            }
        }
        const actionable = el.closest && el.closest(
            'a[href], button, [role="button"], [role="link"], input[type="button"], '
            + 'input[type="submit"], [onclick], td[onclick], tr[onclick], li[onclick], '
            + '[class*="Button"], [class*="gwt-"]'
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

    // --- field / table inventory (catalog for gather→decide→fill) ---

    function slugifyLabel(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '_')
            .replace(/^_|_$/g, '')
            .slice(0, 48) || 'field';
    }

    function associatedLabel(el) {
        if (!el) return '';
        if (el.id) {
            try {
                const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
                if (lab && lab.innerText) return lab.innerText.trim();
            } catch (e) { /* ignore */ }
        }
        const wrapped = el.closest && el.closest('label');
        if (wrapped && wrapped.innerText) {
            return wrapped.innerText.replace(el.value || '', '').trim().slice(0, 120);
        }
        const prev = el.previousElementSibling;
        if (prev && /label|span|div|td|th/i.test(prev.tagName) && prev.innerText) {
            return prev.innerText.trim().slice(0, 120);
        }
        const parent = el.parentElement;
        if (parent) {
            const lab = parent.querySelector('label, .label, [class*="label"]');
            if (lab && lab.innerText) return lab.innerText.trim().slice(0, 120);
        }
        return (
            (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title')))
            || el.name
            || el.id
            || ''
        ).toString().trim().slice(0, 120);
    }

    function buildSelector(el) {
        if (!el) return null;
        if (el.id) {
            try { return `#${CSS.escape(el.id)}`; } catch (e) { return `#${el.id}`; }
        }
        if (el.name) {
            const tag = el.tagName.toLowerCase();
            return `${tag}[name="${el.name}"]`;
        }
        if (el.getAttribute && el.getAttribute('aria-label')) {
            const a = el.getAttribute('aria-label');
            return `${el.tagName.toLowerCase()}[aria-label="${a}"]`;
        }
        return null;
    }

    function isVisible(el) {
        if (!el || !el.getBoundingClientRect) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 1 && r.height < 1) return false;
        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') return false;
        return true;
    }

    function inventoryFields() {
        const nodes = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'));
        const fields = [];
        const seen = new Set();
        let idx = 0;
        const docTypeOptions = [];

        for (const el of nodes) {
            const type = ((el.getAttribute && el.getAttribute('type')) || '').toLowerCase();
            if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'checkbox' || type === 'radio' || type === 'file') {
                continue;
            }
            if (el.disabled) continue;
            const label = associatedLabel(el);
            const selector = buildSelector(el);
            if (!selector) continue;
            if (seen.has(selector)) continue;
            seen.add(selector);

            const slug = slugifyLabel(label || el.name || el.id || `f${idx}`);
            const field_id = `${slug}_${idx}`;
            idx += 1;

            const options = [];
            if (el instanceof HTMLSelectElement) {
                for (const opt of el.options) {
                    options.push({ value: opt.value, text: (opt.text || '').trim() });
                }
                const labLower = label.toLowerCase();
                if (/doc|document.?type|type/.test(labLower) || /doc.?type/i.test(el.name || '') || /doc.?type/i.test(el.id || '')) {
                    docTypeOptions.push(...options);
                }
            }

            fields.push({
                field_id,
                label,
                tag: el.tagName.toLowerCase(),
                type: type || (el instanceof HTMLSelectElement ? 'select' : (el.isContentEditable ? 'contenteditable' : 'text')),
                name: el.name || '',
                id: el.id || '',
                selector,
                options,
                currentValue: ('value' in el) ? el.value : (el.textContent || ''),
                visible: isVisible(el),
            });
        }

        // Prefer unique doc-type options if we found a dedicated select; else leave empty.
        const uniqueDoc = [];
        const seenOpt = new Set();
        for (const o of docTypeOptions) {
            const k = `${o.value}|${o.text}`;
            if (seenOpt.has(k)) continue;
            seenOpt.add(k);
            uniqueDoc.push(o);
        }

        return { fields, docTypeOptions: uniqueDoc };
    }

    function findControlByText(patterns) {
        const candidates = Array.from(document.querySelectorAll(
            'button, a, [role="button"], [role="link"], input[type="button"], '
            + 'span, div, img, td, th, li, [onclick], [class*="Button"], [class*="button"]'
        ));
        for (const pat of patterns) {
            const re = typeof pat === 'string' ? new RegExp(pat, 'i') : pat;
            for (const el of candidates) {
                if (bannedReason(el)) continue;
                const t = visibleLabel(el) || elementLabel(el);
                const aria = (el.getAttribute && (
                    el.getAttribute('aria-label')
                    || el.getAttribute('title')
                    || el.getAttribute('alt')
                    || (el.tagName === 'IMG' && (el.alt || el.title))
                )) || '';
                const blob = `${t} ${aria}`.trim();
                if (blob && re.test(blob) && isVisible(el)) {
                    const target = resolveClickTarget(el);
                    const sel = buildSelector(target)
                        || buildSelector(el)
                        || (target.id ? `#${target.id}` : null)
                        || (el.id ? `#${el.id}` : null);
                    if (sel) {
                        return {
                            label: (target.innerText || el.innerText || aria || '').trim().slice(0, 80),
                            selector: sel,
                        };
                    }
                }
            }
        }
        return null;
    }

    function findScrollContainerNear(el) {
        if (!el) return null;
        const sc = scrollableAncestor(el);
        if (sc && sc !== document.body) {
            return buildSelector(sc) || (sc.id ? `#${sc.id}` : null);
        }
        return null;
    }

    function scoreViewerCandidate(el) {
        if (!isVisible(el)) return -1;
        const r = el.getBoundingClientRect();
        const area = Math.max(0, r.width) * Math.max(0, r.height);
        const blob = `${el.id || ''} ${el.className || ''} ${el.getAttribute && el.getAttribute('title') || ''}`.toLowerCase();
        let bonus = 0;
        if (/viewer|document|image|preview|page/.test(blob)) bonus += 50000;
        // Prefer left half of viewport (typical Ephesoft layout).
        if (r.left + r.width / 2 < (window.innerWidth || 0) * 0.55) bonus += 10000;
        return area + bonus;
    }

    function findViewerRegion() {
        const candidates = Array.from(document.querySelectorAll(
            'img, canvas, iframe, [class*="viewer"], [id*="viewer"], [class*="document"], '
            + '[id*="document"], [class*="image"], [id*="image"], [class*="preview"]'
        ));
        let best = null;
        let bestScore = 0;
        for (const el of candidates) {
            const s = scoreViewerCandidate(el);
            if (s > bestScore) {
                bestScore = s;
                best = el;
            }
        }
        if (!best) return null;
        // Prefer a reasonable container, not a tiny icon.
        const region = best.closest
            && best.closest('[class*="viewer"], [id*="viewer"], [class*="document"], [id*="document"], .center, td, div')
            || best.parentElement
            || best;
        return { region, primary: best };
    }

    function extractPageLabelNear(root) {
        const searchRoots = [root, document.body].filter(Boolean);
        const re = /(?:page\s*)?(\d+)\s*(?:of|\/)\s*(\d+)/i;
        for (const rootEl of searchRoots) {
            const text = (rootEl.innerText || '').slice(0, 4000);
            const m = text.match(re);
            if (m) return `${m[1]} of ${m[2]}`;
        }
        // Also check aria / toolbar inputs.
        const toolbar = document.querySelectorAll('input, span, div, label');
        for (const el of toolbar) {
            const v = (el.value || el.innerText || el.getAttribute('aria-label') || '').trim();
            const m = v.match(re);
            if (m && isVisible(el)) return `${m[1]} of ${m[2]}`;
        }
        return '';
    }

    function inventoryViewer() {
        const found = findViewerRegion();
        const region = found && found.region;
        const primary = found && found.primary;
        const controls = {
            next_page: findControlByText([
                /next\s*(page|document|doc)?/i,
                /^›$/,
                /^»$/,
                /^>$/,
                /forward/i,
            ]),
            prev_page: findControlByText([
                /prev(ious)?\s*(page|document|doc)?/i,
                /^‹$/,
                /^«$/,
                /^<$/,
                /back/i,
            ]),
            first_page: findControlByText([/first\s*page/i, /^««$/, /^\|<$/]),
            last_page: findControlByText([/last\s*page/i, /^»»$/, /^>\|$/]),
        };
        const scroll_container = findScrollContainerNear(region || primary);
        let primary_img_src = '';
        if (primary && primary.tagName === 'IMG') primary_img_src = primary.currentSrc || primary.src || '';
        if (primary && primary.tagName === 'IFRAME') primary_img_src = primary.src || '';
        return {
            controls,
            scroll_container,
            page_label: extractPageLabelNear(region),
            region_hint: region ? `${region.tagName}.${(region.className || '').toString().slice(0, 60)}` : null,
            primary_tag: primary ? primary.tagName.toLowerCase() : null,
            primary_img_src: primary_img_src.slice(0, 500),
        };
    }

    function viewerSignals() {
        const inv = inventoryViewer();
        const found = findViewerRegion();
        const region = found && found.region;
        const primary = found && found.primary;
        let scroll_top = 0;
        if (inv.scroll_container) {
            try {
                const el = document.querySelector(inv.scroll_container);
                if (el) scroll_top = el.scrollTop || 0;
            } catch (e) { /* ignore */ }
        }
        let viewer_text_sample = '';
        if (region && region.innerText) {
            viewer_text_sample = region.innerText.replace(/\s+/g, ' ').trim().slice(0, 800);
        }
        let primary_img_src = inv.primary_img_src || '';
        if (!primary_img_src && primary && primary.tagName === 'IMG') {
            primary_img_src = (primary.currentSrc || primary.src || '').slice(0, 500);
        }
        return {
            url: location.href,
            title: document.title,
            page_label: inv.page_label || '',
            viewer_text_sample,
            primary_img_src,
            scroll_top,
        };
    }

    function parseBatchRow(tr) {
        if (!tr || !isVisible(tr)) return null;
        const cells = Array.from(tr.querySelectorAll('td, th'));
        if (cells.length < 1) return null;
        // Skip header-only rows with no data-ish cells.
        const inputs = tr.querySelectorAll('input, textarea, select').length;
        if (inputs > 2) return null; // likely a form grid, not batch list
        const texts = cells.map((c) => (c.innerText || '').trim()).filter(Boolean);
        if (!texts.length) return null;
        const rowText = texts.join(' | ').slice(0, 200);
        // Prefer an anchor / button inside the row for the click selector.
        const link = tr.querySelector('a[href], button, [role="button"], [role="link"]');
        const target = link ? resolveClickTarget(link) : resolveClickTarget(tr);
        let selector = buildSelector(target);
        if (!selector && target && target.tagName === 'A' && target.getAttribute('href')) {
            try {
                selector = `a[href="${CSS.escape(target.getAttribute('href'))}"]`;
            } catch (e) {
                selector = null;
            }
        }
        if (!selector && tr.id) {
            try { selector = `#${CSS.escape(tr.id)}`; } catch (e) { selector = `#${tr.id}`; }
        }
        if (!selector) {
            // Last resort: nth-of-type under parent table.
            const table = tr.closest('table');
            if (table) {
                const rows = Array.from(table.querySelectorAll('tr'));
                const idx = rows.indexOf(tr) + 1;
                if (idx > 0) selector = `table tr:nth-child(${idx})`;
            }
        }
        if (!selector) return null;

        const id = texts[0].slice(0, 80);
        let status = '';
        let assigned_to = '';
        let created = '';
        for (const t of texts) {
            const low = t.toLowerCase();
            if (/in\s*progress|ready|locked|new|pending|review|complete/.test(low) && low.length < 40) {
                status = status || t;
            }
            if (/^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(t) || /^\d{4}-\d{2}-\d{2}/.test(t)) {
                created = created || t;
            }
        }
        // Assignee often last non-empty cell that isn't the id/date/status.
        for (let i = texts.length - 1; i >= 1; i -= 1) {
            const t = texts[i];
            if (t === status || t === created || t === id) continue;
            if (/^\d+$/.test(t)) continue;
            if (t.length >= 2 && t.length < 60) {
                assigned_to = t;
                break;
            }
        }
        return {
            id,
            created,
            status,
            assigned_to,
            selector,
            text: rowText,
        };
    }

    function inventoryBatchList() {
        const controls = {
            next_page: findControlByText([
                /next\s*(page)?/i,
                /^next$/i,
                /^›$/,
                /^»$/,
                /pagination.*next/i,
            ]),
            prev_page: findControlByText([
                /prev(ious)?\s*(page)?/i,
                /^prev(ious)?$/i,
                /^‹$/,
                /^«$/,
            ]),
        };
        const page_label = extractPageLabelNear(document.body);

        // Prefer tables that look like batch lists: many rows, few inputs.
        const tables = Array.from(document.querySelectorAll('table'));
        let bestRows = [];
        let bestScore = -1;
        for (const table of tables) {
            const trs = Array.from(table.querySelectorAll('tr'));
            const inputs = table.querySelectorAll('input, textarea, select').length;
            if (trs.length < 2) continue;
            if (inputs > trs.length) continue; // form table
            const parsed = [];
            for (const tr of trs) {
                // skip pure header
                if (tr.querySelectorAll('th').length && !tr.querySelector('td')) continue;
                const row = parseBatchRow(tr);
                if (row) parsed.push(row);
            }
            const score = parsed.length * 10 - inputs;
            if (parsed.length >= 1 && score > bestScore) {
                bestScore = score;
                bestRows = parsed;
            }
        }

        // Fallback: role=row list items
        if (!bestRows.length) {
            const roleRows = Array.from(document.querySelectorAll('[role="row"], li'));
            for (const el of roleRows) {
                if (!isVisible(el)) continue;
                const text = (el.innerText || '').trim();
                if (text.length < 3 || text.length > 300) continue;
                if (/add\s*row|validate|document\s*type/i.test(text)) continue;
                const link = el.querySelector('a[href], button, [role="button"]') || el;
                const target = resolveClickTarget(link);
                const selector = buildSelector(target);
                if (!selector) continue;
                const id = text.split(/\n|\|/)[0].trim().slice(0, 80);
                bestRows.push({
                    id,
                    created: '',
                    status: '',
                    assigned_to: '',
                    selector,
                    text: text.slice(0, 200),
                });
                if (bestRows.length >= 40) break;
            }
        }

        return {
            controls,
            page_label,
            rows: bestRows.slice(0, 50),
        };
    }

    function batchListSignals() {
        const inv = inventoryBatchList();
        const ids = (inv.rows || []).map((r) => r.id);
        const fieldsInv = inventoryFields();
        return {
            url: location.href,
            title: document.title,
            page_label: inv.page_label || '',
            first_batch_id: ids[0] || '',
            last_batch_id: ids.length ? ids[ids.length - 1] : '',
            batch_ids_sample: ids.slice(0, 12),
            field_count: (fieldsInv.fields || []).length,
            page_kind: (() => {
                try {
                    // Lightweight local hint — full classify happens in SW.
                    if ((inv.rows || []).length >= 2) return 'batch_list';
                } catch (e) { /* ignore */ }
                return 'unknown';
            })(),
        };
    }

    function inventoryTable() {
        const controls = {
            table_tab: findControlByText([/^tables?$/i, /table/i]),
            add_row: findControlByText([/add\s*row/i, /^\+$/, /insert\s*row/i]),
            clear: findControlByText([/^clear(\s*all)?$/i, /clear\s*table/i]),
        };

        // Prefer a table that looks like a line-item grid (has inputs in rows).
        const tables = Array.from(document.querySelectorAll('table'));
        let best = null;
        let bestScore = -1;
        for (const table of tables) {
            const inputs = table.querySelectorAll('input, textarea, select');
            const rows = table.querySelectorAll('tr');
            const score = inputs.length * 10 + rows.length;
            if (score > bestScore) {
                bestScore = score;
                best = table;
            }
        }

        const columns = [];
        let rowSelector = null;
        let rowCount = 0;

        if (best) {
            const headerCells = best.querySelectorAll('thead th, thead td, tr:first-child th');
            let ci = 0;
            headerCells.forEach((th) => {
                const label = (th.innerText || '').trim();
                if (!label) return;
                columns.push({
                    column_id: `${slugifyLabel(label)}_${ci}`,
                    label,
                    index: ci,
                });
                ci += 1;
            });
            // If no headers, invent columns from first data row inputs.
            if (!columns.length) {
                const firstRow = best.querySelector('tbody tr, tr:nth-child(2), tr');
                if (firstRow) {
                    const inputs = Array.from(firstRow.querySelectorAll('input, textarea, select')).filter((el) => {
                        const t = (el.getAttribute('type') || '').toLowerCase();
                        return t !== 'hidden' && !el.disabled;
                    });
                    inputs.forEach((el, i) => {
                        const label = associatedLabel(el) || `col_${i}`;
                        columns.push({ column_id: `${slugifyLabel(label)}_${i}`, label, index: i });
                    });
                }
            }

            const dataRows = Array.from(best.querySelectorAll('tbody tr, tr')).filter((tr) => (
                tr.querySelectorAll('input, textarea, select').length > 0
            ));
            rowCount = dataRows.length;
            if (dataRows.length) {
                const last = dataRows[dataRows.length - 1];
                rowSelector = buildSelector(last)
                    || (last.id ? `#${last.id}` : 'table tbody tr:last-child');
            } else {
                rowSelector = 'table tbody tr:last-child';
            }
        }

        return { columns, controls, row_selector: rowSelector, row_count: rowCount };
    }

    function readField(fieldId, selector) {
        let el = null;
        if (selector) {
            try { el = query(selector); } catch (e) { el = null; }
        }
        if (!el && fieldId) {
            const inv = inventoryFields();
            const hit = inv.fields.find((f) => f.field_id === fieldId);
            if (hit && hit.selector) {
                try { el = query(hit.selector); } catch (e) { el = null; }
            }
        }
        if (!el) throw new Error(`Cannot read field: ${fieldId || selector}`);
        const value = ('value' in el) ? el.value : (el.textContent || '');
        return { field_id: fieldId || null, selector: selector || buildSelector(el), value };
    }

    function fillById(fieldId, value, selectorHint) {
        const inv = inventoryFields();
        const hit = inv.fields.find((f) => f.field_id === fieldId)
            || inv.fields.find((f) => f.selector === selectorHint)
            || inv.fields.find((f) => String(f.label || '').toLowerCase() === String(fieldId || '').toLowerCase());
        const selector = (hit && hit.selector) || selectorHint;
        if (!selector) throw new Error(`Unknown field_id: ${fieldId}`);
        if (hit && (hit.tag === 'select' || hit.type === 'select')) {
            return domSelect(selector, value);
        }
        return domFill(selector, value);
    }

    function waitForRow(prevCount, timeoutMs) {
        const timeout = timeoutMs || 4000;
        const started = Date.now();
        return new Promise((resolve) => {
            const tick = () => {
                const inv = inventoryTable();
                if (inv.row_count > (prevCount || 0)) {
                    resolve({ ready: true, row_count: inv.row_count, row_selector: inv.row_selector });
                    return;
                }
                if (Date.now() - started >= timeout) {
                    resolve({ ready: false, row_count: inv.row_count, row_selector: inv.row_selector });
                    return;
                }
                setTimeout(tick, 120);
            };
            tick();
        });
    }

    /** Cheap signals for page-gate classification (no LLM). */
    function pageSignals() {
        const fieldsInv = inventoryFields();
        const tableInv = inventoryTable();
        const text = ((document.body && document.body.innerText) || '').slice(0, 2500);
        const fields = fieldsInv.fields || [];
        const hasDocType = !!(fieldsInv.docTypeOptions && fieldsInv.docTypeOptions.length)
            || fields.some((f) => {
                const lab = String(f.label || '').toLowerCase();
                return f.tag === 'select' && /doc|document.?type|^type$/.test(lab);
            });
        const hasLineInputs = (tableInv.columns || []).length >= 1
            && (tableInv.row_count > 0 || !!(tableInv.controls && tableInv.controls.add_row));

        // Rough batch-list row count: tables with many rows but few inputs.
        let batchRowCount = 0;
        try {
            const tables = Array.from(document.querySelectorAll('table'));
            for (const table of tables) {
                const inputs = table.querySelectorAll('input, textarea, select').length;
                const trs = table.querySelectorAll('tr').length;
                if (trs >= 3 && inputs <= 2) batchRowCount = Math.max(batchRowCount, trs - 1);
            }
        } catch (e) { /* ignore */ }

        const blob = `${location.href} ${document.title} ${text}`.toLowerCase();
        const batchListHints = /\bbatch(es)?\b/.test(blob)
            || /\bassigned\b/.test(blob)
            || /work.?queue|inbox|batch.?list/.test(blob);

        return {
            url: location.href,
            title: document.title,
            text_sample: text,
            field_count: fields.length,
            select_count: fields.filter((f) => f.tag === 'select').length,
            has_doc_type_select: hasDocType,
            table_column_count: (tableInv.columns || []).length,
            table_row_count: tableInv.row_count || 0,
            has_add_row: !!(tableInv.controls && tableInv.controls.add_row),
            has_clear: !!(tableInv.controls && tableInv.controls.clear),
            has_table_tab: !!(tableInv.controls && tableInv.controls.table_tab),
            has_line_item_inputs: hasLineInputs,
            batch_list_hints: batchListHints,
            batch_row_count: batchRowCount,
        };
    }

    // --- message router ---

    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        if (!msg || !msg.cmd) return;
        const reply = (ok, result, error) => {
            try {
                if (ok) sendResponse({ ok: true, result });
                else sendResponse({ ok: false, error: error || 'unknown' });
            } catch (e) { /* channel closed */ }
        };
        try {
            switch (msg.cmd) {
                case 'ping': reply(true, { pong: true }); break;
                case 'observe': reply(true, observe()); break;
                case 'get_html': reply(true, { html: cleanHtml(msg.maxLen) }); break;
                case 'fill': reply(true, domFill(msg.selector, msg.value)); break;
                case 'select': reply(true, domSelect(msg.selector, msg.value)); break;
                case 'click': reply(true, domClick(msg.selector)); break;
                case 'fill_row': reply(true, domFillRow(msg.row_selector, msg.values || [])); break;
                case 'exists': reply(true, domExists(msg.selector)); break;
                case 'scroll': reply(true, domScroll(msg.selector, msg.direction)); break;
                case 'set_scroll_y': reply(true, setScrollY(msg.y)); break;
                case 'inventory_fields': reply(true, inventoryFields()); break;
                case 'inventory_table': reply(true, inventoryTable()); break;
                case 'inventory_viewer': reply(true, inventoryViewer()); break;
                case 'viewer_signals': reply(true, viewerSignals()); break;
                case 'inventory_batch_list': reply(true, inventoryBatchList()); break;
                case 'batch_list_signals': reply(true, batchListSignals()); break;
                case 'read_field': reply(true, readField(msg.field_id, msg.selector)); break;
                case 'fill_by_id': reply(true, fillById(msg.field_id, msg.value, msg.selector)); break;
                case 'page_signals': reply(true, pageSignals()); break;
                case 'wait_for_row':
                    waitForRow(msg.prev_count, msg.timeout_ms)
                        .then((result) => reply(true, result))
                        .catch((e) => reply(false, null, e && e.message ? e.message : String(e)));
                    return true;
                default: throw new Error(`Unknown cmd: ${msg.cmd}`);
            }
        } catch (e) {
            reply(false, null, e && e.message ? e.message : String(e));
        }
        return true; // keep the message channel open for async sendResponse
    });
})();
