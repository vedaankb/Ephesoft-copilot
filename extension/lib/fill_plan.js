/**
 * Pure helpers for gather → decide → fill-at-once.
 * No Chrome APIs — unit-testable from Node.
 */

export const CONFIDENCE_THRESHOLD = 0.55;
export const MAX_GATHER_STEPS = 8;
export const MAX_RECOVERY_CALLS = 3;
export const ALLOWED_INCOMPLETE = Object.freeze([
    'Missing Invoice',
    'Missing Information',
    'Illegible Documents',
]);

/** Strip currency symbols and thousands separators for amount fields. */
export function normalizeAmount(value) {
    if (value == null) return '';
    let s = String(value).trim();
    if (!s) return '';
    s = s.replace(/[$£€¥]/g, '').replace(/,/g, '').trim();
    // Drop common currency codes sitting beside the number.
    s = s.replace(/\b(usd|eur|gbp|cad|aud)\b/gi, '').trim();
    // Keep a leading minus if present.
    const m = s.match(/-?\d+(\.\d+)?/);
    return m ? m[0] : s;
}

/** Normalize common date strings toward YYYY-MM-DD when possible. */
export function normalizeDate(value) {
    if (value == null) return '';
    const s = String(value).trim();
    if (!s) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
    if (m) {
        let [, a, b, yy] = m;
        if (yy.length === 2) yy = '20' + yy;
        const mm = a.padStart(2, '0');
        const dd = b.padStart(2, '0');
        // Prefer MM/DD when first part > 12 would be invalid as month — still emit ISO-like.
        return `${yy}-${mm}-${dd}`;
    }
    return s;
}

/**
 * Apply wire-format normalization based on field type / label hints.
 */
export function normalizeFieldValue(value, fieldMeta = {}) {
    if (value == null) return '';
    const type = String(fieldMeta.type || '').toLowerCase();
    const label = String(fieldMeta.label || fieldMeta.name || '').toLowerCase();
    if (type === 'date' || /date|dob|service.?date|invoice.?date/.test(label)) {
        return normalizeDate(value);
    }
    if (
        type === 'number'
        || /amount|total|charge|price|cost|tax|fee|paid|due|balance/.test(label)
    ) {
        return normalizeAmount(value);
    }
    return String(value).trim();
}

/** Match a select option; returns matched value or null. */
export function matchSelectOption(want, options) {
    if (!Array.isArray(options) || !options.length) return null;
    const w = String(want ?? '').toLowerCase().trim();
    if (!w) return null;
    for (const opt of options) {
        const ov = String(opt.value ?? opt).toLowerCase().trim();
        const ot = String(opt.text ?? opt.label ?? opt.value ?? opt).toLowerCase().trim();
        if (ov === w || ot === w) return opt.value != null ? opt.value : opt;
    }
    for (const opt of options) {
        const ov = String(opt.value ?? opt).toLowerCase().trim();
        const ot = String(opt.text ?? opt.label ?? opt.value ?? opt).toLowerCase().trim();
        if (ot.includes(w) || ov.includes(w) || w.includes(ot) || w.includes(ov)) {
            return opt.value != null ? opt.value : opt;
        }
    }
    return null;
}

export function isFillMode(mode) {
    return mode === 'fill_details' || mode === 'fill_line_items' || mode === 'fill';
}

export function modeLabel(mode) {
    if (mode === 'fill_details') return 'FILL DETAILS';
    if (mode === 'fill_line_items') return 'FILL LINE ITEMS';
    if (mode === 'next') return 'NEXT';
    return String(mode || 'FILL').toUpperCase();
}

/**
 * Resolve a planned field_id against a catalog. Exact id first, then label match.
 */
export function resolveCatalogField(fieldIdOrLabel, catalog) {
    if (!catalog || !Array.isArray(catalog.fields)) return null;
    const key = String(fieldIdOrLabel || '').trim();
    if (!key) return null;
    const byId = catalog.fields.find((f) => f.field_id === key);
    if (byId) return byId;
    const lower = key.toLowerCase();
    const byLabel = catalog.fields.find((f) => String(f.label || '').toLowerCase() === lower);
    if (byLabel) return byLabel;
    const byIncludes = catalog.fields.find((f) => {
        const lab = String(f.label || '').toLowerCase();
        return lab && (lab.includes(lower) || lower.includes(lab));
    });
    return byIncludes || null;
}

export function resolveCatalogColumn(columnIdOrLabel, catalog) {
    if (!catalog || !Array.isArray(catalog.columns)) return null;
    const key = String(columnIdOrLabel || '').trim();
    if (!key) return null;
    const byId = catalog.columns.find((c) => c.column_id === key);
    if (byId) return byId;
    const lower = key.toLowerCase();
    return catalog.columns.find((c) => String(c.label || '').toLowerCase() === lower)
        || catalog.columns.find((c) => {
            const lab = String(c.label || '').toLowerCase();
            return lab && (lab.includes(lower) || lower.includes(lab));
        })
        || null;
}

/**
 * Normalize / validate a details plan from the model.
 * Returns { ok, plan, errors, skipped }.
 */
export function sanitizeDetailsPlan(raw, catalog, opts = {}) {
    const threshold = opts.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
    const errors = [];
    const skipped = [];
    if (!raw || typeof raw !== 'object') {
        return { ok: false, plan: null, errors: ['Plan is not an object'], skipped };
    }
    if (raw.incomplete || raw.action === 'incomplete') {
        const reason = ALLOWED_INCOMPLETE.includes(raw.reason)
            ? raw.reason
            : (ALLOWED_INCOMPLETE.includes(raw.incomplete) ? raw.incomplete : 'Missing Information');
        return {
            ok: true,
            plan: {
                kind: 'incomplete',
                reason,
                flags: Array.isArray(raw.flags) ? raw.flags : [],
                note: raw.note || reason,
            },
            errors,
            skipped,
        };
    }

    const fieldsIn = Array.isArray(raw.fields) ? raw.fields : [];
    const fields = [];
    for (const entry of fieldsIn) {
        if (!entry || typeof entry !== 'object') continue;
        const fieldKey = entry.field_id || entry.label || entry.name;
        const conf = entry.confidence == null ? 1 : Number(entry.confidence);
        if (Number.isFinite(conf) && conf < threshold) {
            skipped.push({ field_id: fieldKey, reason: 'low_confidence', confidence: conf });
            continue;
        }
        if (entry.value == null || String(entry.value).trim() === '') {
            skipped.push({ field_id: fieldKey, reason: 'empty_value' });
            continue;
        }
        const meta = resolveCatalogField(fieldKey, catalog) || {
            field_id: fieldKey,
            label: entry.label || fieldKey,
            type: entry.type || 'text',
            selector: entry.selector || null,
        };
        if (catalog && catalog.fields && catalog.fields.length && !resolveCatalogField(fieldKey, catalog)) {
            errors.push(`Unknown field_id: ${fieldKey}`);
            skipped.push({ field_id: fieldKey, reason: 'unknown_field' });
            continue;
        }
        let value = normalizeFieldValue(entry.value, meta);
        if (meta.tag === 'select' || meta.type === 'select') {
            const matched = matchSelectOption(value, meta.options || []);
            if (matched == null && (meta.options || []).length) {
                errors.push(`No select option for ${meta.field_id}: ${value}`);
                skipped.push({ field_id: meta.field_id, reason: 'no_option' });
                continue;
            }
            if (matched != null) value = matched;
        }
        fields.push({
            field_id: meta.field_id || fieldKey,
            selector: meta.selector || entry.selector || null,
            value,
            label: meta.label || entry.label || '',
            tag: meta.tag || 'input',
        });
    }

    let docType = raw.doc_type || raw.document_type || null;
    if (docType && catalog && Array.isArray(catalog.docTypeOptions)) {
        const matched = matchSelectOption(docType, catalog.docTypeOptions);
        if (matched != null) docType = matched;
    }

    return {
        ok: true,
        plan: {
            kind: 'fill_details',
            doc_type: docType,
            fields,
            flags: Array.isArray(raw.flags) ? raw.flags : [],
            red_fields: Array.isArray(raw.red_fields) ? raw.red_fields : [],
            note: raw.note || '',
        },
        errors,
        skipped,
    };
}

/**
 * Normalize / validate a line-items plan.
 */
export function sanitizeLineItemsPlan(raw, catalog, opts = {}) {
    const threshold = opts.confidenceThreshold ?? CONFIDENCE_THRESHOLD;
    const errors = [];
    const skipped = [];
    if (!raw || typeof raw !== 'object') {
        return { ok: false, plan: null, errors: ['Plan is not an object'], skipped };
    }
    if (raw.incomplete || raw.action === 'incomplete') {
        const reason = ALLOWED_INCOMPLETE.includes(raw.reason)
            ? raw.reason
            : 'Missing Information';
        return {
            ok: true,
            plan: {
                kind: 'incomplete',
                reason,
                flags: Array.isArray(raw.flags) ? raw.flags : [],
                note: raw.note || reason,
            },
            errors,
            skipped,
        };
    }

    const rowsIn = Array.isArray(raw.rows) ? raw.rows : [];
    const columns = (catalog && catalog.columns) || [];
    const rows = [];

    for (let ri = 0; ri < rowsIn.length; ri += 1) {
        const row = rowsIn[ri];
        if (!row) continue;
        const conf = row.confidence == null ? 1 : Number(row.confidence);
        if (Number.isFinite(conf) && conf < threshold) {
            skipped.push({ row: ri, reason: 'low_confidence', confidence: conf });
            continue;
        }

        // Support either { values: [...] } positional or { cells: [{ column_id, value }] }
        let values = [];
        if (Array.isArray(row.values)) {
            values = row.values.map((v, ci) => {
                const col = columns[ci] || {};
                return normalizeFieldValue(v, col);
            });
        } else if (Array.isArray(row.cells)) {
            const ordered = columns.length
                ? columns.map((col) => {
                    const cell = row.cells.find((c) => {
                        const id = c.column_id || c.label;
                        return resolveCatalogColumn(id, { columns: [col] })
                            || String(id || '').toLowerCase() === String(col.column_id || '').toLowerCase()
                            || String(id || '').toLowerCase() === String(col.label || '').toLowerCase();
                    });
                    return cell ? normalizeFieldValue(cell.value, col) : '';
                })
                : row.cells.map((c) => normalizeFieldValue(c.value, {}));
            values = ordered;
        } else {
            skipped.push({ row: ri, reason: 'malformed_row' });
            continue;
        }

        if (!values.some((v) => String(v).trim() !== '')) {
            skipped.push({ row: ri, reason: 'empty_row' });
            continue;
        }
        rows.push({ values, confidence: conf });
    }

    return {
        ok: true,
        plan: {
            kind: 'fill_line_items',
            rows,
            clear_first: !!raw.clear_first,
            flags: Array.isArray(raw.flags) ? raw.flags : [],
            note: raw.note || '',
            table_controls: catalog && catalog.controls ? catalog.controls : null,
        },
        errors,
        skipped,
    };
}

/** Gather-phase action allowed set. */
export function isGatherAction(action) {
    if (!action || typeof action !== 'object') return false;
    const a = action.action;
    return a === 'scroll'
        || a === 'click' // doc viewer page / table tab only; execute layer still safety-guards
        || a === 'done_gathering'
        || a === 'incomplete';
}

export function valuesRoughlyEqual(expected, actual) {
    const e = String(expected ?? '').trim().toLowerCase();
    const a = String(actual ?? '').trim().toLowerCase();
    if (e === a) return true;
    // Amounts: compare numeric
    const en = normalizeAmount(e);
    const an = normalizeAmount(a);
    if (en && an && en === an) return true;
    const ed = normalizeDate(e);
    const ad = normalizeDate(a);
    if (ed && ad && ed === ad) return true;
    if (e && a && (e.includes(a) || a.includes(e))) return true;
    return false;
}

export function buildGatherPrompt(mode, observation, history) {
    const scope = mode === 'fill_line_items'
        ? 'LINE ITEMS only. The HUMAN already opened the Table view. Scroll the document and/or table if needed. Do NOT click Table tab. Do NOT fill yet.'
        : 'HEADER / DETAILS fields only (doc type, names, amounts, dates). Do NOT fill yet. Do NOT open the line-item Table view - Fill Details stops after header fields.';
    const hist = history.length ? history.map((h, i) => `${i + 1}. ${h}`).join('\n') : '(none)';
    const allowed = mode === 'fill_line_items'
        ? 'You may ONLY: scroll, or click document-viewer next/previous page. Never click Table / Add Row / Clear during gather.'
        : 'You may ONLY: scroll, or click document-viewer next/previous page. Never open Table or fill fields during gather.';
    return [
        `PHASE: GATHER for ${modeLabel(mode)}. ${scope}`,
        allowed,
        'When you have enough screenshots/context, respond with {"action":"done_gathering","reason":"..."}.',
        'If the SOP requires stopping, respond with {"action":"incomplete","reason":"<SOP reason>","note":"..."}.',
        'Do NOT fill, select, or add rows during gather.',
        '',
        `CURRENT URL: ${observation.url}`,
        `PAGE TITLE: ${observation.title}`,
        `SCROLL: y=${observation.scroll?.y} maxY=${observation.scroll?.maxY} atBottom=${observation.scroll?.atBottom}`,
        '',
        'GATHER ACTIONS SO FAR:',
        hist,
        '',
        'VISIBLE PAGE TEXT:',
        observation.text || '',
        '',
        'PAGE HTML (trimmed):',
        observation.html || '',
        '',
        'Respond with ONE JSON object: scroll | click | done_gathering | incomplete.',
    ].join('\n');
}

export function buildDecidePrompt(mode, contextSummary, catalog) {
    if (mode === 'fill_line_items') {
        return [
            'PHASE: DECIDE (FILL LINE ITEMS). Map document line items to table columns.',
            'Respond with ONE JSON object:',
            '{"rows":[{"values":["desc","amount",...],"confidence":0.0-1.0}],"clear_first":true|false,"flags":[],"note":"..."}',
            'Or {"incomplete":true,"reason":"Missing Information"|"Missing Invoice"|"Illegible Documents","note":"..."}.',
            'Use ONLY the column order from the catalog below. Prefer clear_first if stale rows exist.',
            'Omit low-confidence rows rather than guessing.',
            '',
            'TABLE CATALOG:',
            JSON.stringify(catalog, null, 2),
            '',
            'GATHERED CONTEXT SUMMARY:',
            contextSummary,
        ].join('\n');
    }
    return [
        'PHASE: DECIDE (FILL DETAILS). Map document values to catalog field_ids only.',
        'Respond with ONE JSON object:',
        '{"doc_type":"...","fields":[{"field_id":"<from catalog>","value":"...","confidence":0.0-1.0}],"flags":[],"red_fields":[],"note":"..."}',
        'Or {"incomplete":true,"reason":"Missing Information"|"Missing Invoice"|"Illegible Documents","note":"..."}.',
        'Do NOT invent CSS selectors. Use field_id values from the catalog only.',
        'Skip fields you cannot read confidently (omit or low confidence).',
        'Do NOT include line-item table cells here.',
        '',
        'FIELD CATALOG:',
        JSON.stringify(catalog, null, 2),
        '',
        'GATHERED CONTEXT SUMMARY:',
        contextSummary,
    ].join('\n');
}

export function summarizeContextBuffer(buffer) {
    if (!buffer || !buffer.length) return '(no gathered context)';
    return buffer.map((b, i) => {
        const text = (b.text || '').slice(0, 6000);
        return `--- snapshot ${i + 1} (scrollY=${b.scrollY ?? '?'}) ---\n${text}`;
    }).join('\n\n');
}

/** Preflight: ensure every planned field has a resolvable selector/field_id in catalog. */
export function preflightDetails(plan, catalog) {
    const missing = [];
    const ready = [];
    if (!plan || plan.kind !== 'fill_details') {
        return { ok: false, missing: ['invalid_plan'], ready };
    }
    for (const f of plan.fields || []) {
        const meta = resolveCatalogField(f.field_id, catalog);
        const selector = (meta && meta.selector) || f.selector;
        if (!selector && !(meta && meta.field_id)) {
            missing.push(f.field_id);
        } else {
            ready.push({ ...f, selector, field_id: (meta && meta.field_id) || f.field_id });
        }
    }
    return { ok: missing.length === 0, missing, ready };
}

export function slugify(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 48) || 'field';
}

/** Human opens Table view before Fill Line Items — agent must not click Table tab. */
export function agentOpensTableTab() {
    return false;
}

/** True if a gather/click looks like navigating to the Table tab (blocked). */
export function isTableTabClick(action) {
    if (!action || action.action !== 'click') return false;
    const sel = String(action.selector || '').toLowerCase();
    const note = String(action.note || action.reason || '').toLowerCase();
    const blob = `${sel} ${note}`;
    // Match Table tab / tableTab / #table controls, but not "tablet" etc.
    if (/\btable\s*tab\b/.test(blob)) return true;
    if (/#table\b/.test(sel) || /#tabletab\b/.test(sel) || /\[.*table.*\]/.test(sel)) return true;
    if (/\btable\b/.test(note) && /open|click|switch|view|tab/.test(note)) return true;
    if (/\btable\b/.test(sel) && !/vtable|tablet|stable/.test(sel)) return true;
    return false;
}

/** True if gather click is a safe doc-viewer page control. */
export function isAllowedGatherClick(action, mode) {
    if (!action || action.action !== 'click') return false;
    if (isTableTabClick(action)) return false;
    const blob = `${action.selector || ''} ${action.note || ''} ${action.reason || ''}`.toLowerCase();
    // Block mutate controls during gather.
    if (/add\s*row|clear|validate|submit|skip|merge|split/.test(blob)) return false;
    // Allow document viewer pagination / zoom-ish language.
    if (/page|next|prev|previous|viewer|zoom|document/.test(blob)) return true;
    // For fill modes, reject unknown clicks during gather (prefer scroll / done_gathering).
    if (mode === 'fill_details' || mode === 'fill_line_items') return false;
    return true;
}

/** Pick the catalog select used for document type. */
export function findDocTypeField(catalog) {
    const fields = (catalog && catalog.fields) || [];
    const byLabel = fields.find((f) => {
        const lab = String(f.label || '').toLowerCase();
        return f.tag === 'select' && (/doc|document.?type|^type$/.test(lab) || /doc.?type/i.test(f.name || '') || /doc.?type/i.test(f.id || ''));
    });
    if (byLabel) return byLabel;
    return fields.find((f) => f.tag === 'select' && (f.options || []).length > 2) || null;
}

/**
 * Build the deterministic DOM command sequence for Fill Details.
 * Does not include Table / line-item actions — mode stops after header fill.
 */
export function buildDetailsActions(plan, catalog) {
    const actions = [];
    if (!plan || plan.kind !== 'fill_details') return actions;
    const docField = findDocTypeField(catalog);
    if (plan.doc_type && docField && docField.selector) {
        actions.push({
            cmd: 'select',
            selector: docField.selector,
            value: plan.doc_type,
            field_id: docField.field_id,
            purpose: 'doc_type',
        });
    }
    const pre = preflightDetails(plan, catalog);
    for (const field of pre.ready.length ? pre.ready : (plan.fields || [])) {
        actions.push({
            cmd: 'fill_by_id',
            field_id: field.field_id,
            selector: field.selector,
            value: field.value,
            purpose: 'header_field',
        });
    }
    return actions;
}

/**
 * Build the deterministic DOM command sequence for Fill Line Items.
 * Assumes the human already opened Table view — never emits a table_tab click.
 */
export function buildLineItemActions(plan, catalog) {
    const actions = [];
    if (!plan || plan.kind !== 'fill_line_items') return actions;
    const controls = (catalog && catalog.controls) || {};
    if (plan.clear_first && controls.clear && controls.clear.selector) {
        actions.push({ cmd: 'click', selector: controls.clear.selector, purpose: 'clear_table' });
    }
    const addSelector = controls.add_row && controls.add_row.selector;
    const rowSelector = (catalog && catalog.row_selector) || 'table tbody tr:last-child';
    for (let i = 0; i < (plan.rows || []).length; i += 1) {
        const row = plan.rows[i];
        if (addSelector) {
            actions.push({ cmd: 'click', selector: addSelector, purpose: 'add_row', row_index: i });
        }
        actions.push({
            cmd: 'fill_row',
            row_selector: rowSelector,
            values: row.values,
            purpose: 'fill_row',
            row_index: i,
        });
    }
    return actions;
}

/**
 * Simulate executing detail/line-item actions against an in-memory fake page.
 * Used by unit tests to validate fill/navigate sequencing without Chrome.
 */
export function simulateFillRun(mode, plan, pageState) {
    const state = {
        fields: { ...(pageState.fields || {}) },
        rows: [...(pageState.rows || [])],
        view: pageState.view || (mode === 'fill_line_items' ? 'table' : 'details'),
        log: [],
        errors: [],
    };
    const catalog = pageState.catalog;
    const actions = mode === 'fill_line_items'
        ? buildLineItemActions(plan, catalog)
        : buildDetailsActions(plan, catalog);

    for (const action of actions) {
        if (action.purpose === 'table_tab' || (action.cmd === 'click' && isTableTabClick(action))) {
            state.errors.push('blocked_table_tab_click');
            continue;
        }
        if (action.cmd === 'select' || action.cmd === 'fill_by_id' || action.cmd === 'fill') {
            const key = action.field_id || action.selector;
            if (mode === 'fill_details' && state.view === 'table') {
                state.errors.push('details_fill_while_on_table');
            }
            state.fields[key] = action.value;
            state.log.push(action);
        } else if (action.cmd === 'click' && action.purpose === 'clear_table') {
            state.rows = [];
            state.log.push(action);
        } else if (action.cmd === 'click' && action.purpose === 'add_row') {
            if (state.view !== 'table') {
                state.errors.push('add_row_without_table_view');
            }
            state.rows.push({ values: [] });
            state.log.push(action);
        } else if (action.cmd === 'fill_row') {
            if (!state.rows.length) {
                state.errors.push(`fill_row_without_row:${action.row_index}`);
                continue;
            }
            state.rows[state.rows.length - 1] = { values: [...(action.values || [])] };
            state.log.push(action);
        } else {
            state.log.push(action);
        }
    }
    state.ok = state.errors.length === 0;
    return state;
}

/** NEXT-mode: pick oldest unassigned, not-in-progress batch from a list. */
export function pickNextBatch(batches) {
    if (!Array.isArray(batches) || !batches.length) return null;
    const eligible = batches.filter((b) => {
        if (!b) return false;
        const status = String(b.status || '').toLowerCase();
        const assignee = String(b.assigned_to || b.assignee || '').trim();
        if (assignee) return false;
        if (/in\s*progress|locked|working/.test(status)) return false;
        return true;
    });
    if (!eligible.length) return null;
    eligible.sort((a, b) => {
        const da = Date.parse(a.created || a.received || a.date || 0) || 0;
        const db = Date.parse(b.created || b.received || b.date || 0) || 0;
        if (da !== db) return da - db;
        return String(a.id || '').localeCompare(String(b.id || ''));
    });
    return eligible[0];
}

// ---------- page gate (no LLM) ----------

export const PAGE_KINDS = Object.freeze(['batch_list', 'details', 'table', 'unknown']);

/** Which page each mode expects. */
export function requiredPageForMode(mode) {
    if (mode === 'next') return 'batch_list';
    if (mode === 'fill_line_items') return 'table';
    if (mode === 'fill_details' || mode === 'fill') return 'details';
    return null;
}

/**
 * Classify the current Ephesoft surface from cheap DOM signals (no LLM).
 * Biased toward `unknown` when unsure so we do NOT false-block a correct page.
 */
export function detectPageKind(signals = {}) {
    const text = String(signals.text_sample || signals.text || '').toLowerCase();
    const url = String(signals.url || '').toLowerCase();
    const title = String(signals.title || '').toLowerCase();
    const fieldCount = Number(signals.field_count) || 0;
    const selectCount = Number(signals.select_count) || 0;
    const cols = Number(signals.table_column_count) || 0;
    const rows = Number(signals.table_row_count) || 0;
    const hasAdd = !!signals.has_add_row;
    const hasClear = !!signals.has_clear;
    const hasDocType = !!signals.has_doc_type_select;
    const batchHint = !!signals.batch_list_hints
        || /\bbatch(es)?\b/.test(text)
        || /\bassigned\b/.test(text)
        || /batch.?list|work.?queue|inbox/.test(url + ' ' + title);

    let table = 0;
    let details = 0;
    let batchList = 0;

    if (hasAdd) table += 4;
    if (hasClear) table += 1;
    if (cols >= 2) table += 2;
    if (cols >= 1 && rows >= 0 && hasAdd) table += 1;
    if (signals.has_line_item_inputs) table += 2;

    if (hasDocType) details += 3;
    if (fieldCount >= 3) details += 2;
    if (fieldCount >= 5) details += 1;
    if (selectCount >= 1 && fieldCount >= 2) details += 1;
    // Header form usually has more standalone fields than a bare table page.
    if (fieldCount >= 3 && !hasAdd) details += 1;

    if (batchHint && fieldCount <= 2 && !hasAdd && !hasDocType) batchList += 3;
    if (batchHint && fieldCount === 0) batchList += 2;
    if (/\b(ready|unassigned|received|created)\b/.test(text) && fieldCount <= 1 && !hasAdd) {
        batchList += 2;
    }
    if (signals.batch_row_count >= 3) batchList += 3;

    const scores = { table, details, batch_list: batchList };
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [bestKind, bestScore] = ranked[0];
    const secondScore = ranked[1][1];

    // Need a clear winner — otherwise unknown (allow run; avoid false blocks).
    if (bestScore < 3) return { kind: 'unknown', confidence: 'low', scores };
    if (bestScore - secondScore < 2 && bestScore < 5) {
        return { kind: 'unknown', confidence: 'low', scores };
    }
    return {
        kind: bestKind,
        confidence: bestScore >= 5 ? 'high' : 'medium',
        scores,
    };
}

/**
 * Decide whether to block before LLM.
 * - override → never block
 * - unknown / matching required → allow
 * - confident mismatch → block
 */
export function evaluatePageGate(mode, detection, opts = {}) {
    const required = requiredPageForMode(mode);
    const override = !!opts.overridePageGate;
    const kind = (detection && detection.kind) || 'unknown';
    const confidence = (detection && detection.confidence) || 'low';

    if (!required) {
        return { allow: true, blocked: false, required, kind, reason: 'no_requirement' };
    }
    if (override) {
        return {
            allow: true,
            blocked: false,
            required,
            kind,
            overridden: true,
            reason: 'user_override',
        };
    }
    if (kind === 'unknown') {
        return { allow: true, blocked: false, required, kind, reason: 'unknown_allow' };
    }
    if (kind === required) {
        return { allow: true, blocked: false, required, kind, reason: 'match' };
    }
    // Only hard-block when detection is at least medium confidence.
    if (confidence === 'low') {
        return { allow: true, blocked: false, required, kind, reason: 'low_confidence_allow' };
    }
    return {
        allow: false,
        blocked: true,
        required,
        kind,
        reason: 'mismatch',
        message: pageGateMessage(mode, kind),
    };
}

export function pageGateMessage(mode, detectedKind) {
    const required = requiredPageForMode(mode);
    const detected = detectedKind || 'unknown';
    if (mode === 'next') {
        return `Wrong page for Next (detected: ${detected}). Open the Ephesoft batch list first, then try again — or Run anyway if this is a false alarm.`;
    }
    if (mode === 'fill_line_items') {
        return `Wrong page for Fill Line Items (detected: ${detected}). Open the Table view yourself first, then try again — or Run anyway if this is a false alarm.`;
    }
    return `Wrong page for Fill Details (detected: ${detected}). Open a batch document on the header/details fields (not the batch list or Table view), then try again — or Run anyway if this is a false alarm.`;
}

export function pageKindLabel(kind) {
    if (kind === 'batch_list') return 'batch list';
    if (kind === 'details') return 'details / header fields';
    if (kind === 'table') return 'line-item Table view';
    return 'unknown page';
}

