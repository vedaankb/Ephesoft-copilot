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
        ? 'LINE ITEMS only (table columns and document line charges). Do NOT fill yet.'
        : 'HEADER / DETAILS fields only (doc type, names, amounts, dates). Do NOT fill yet. Do NOT open the line-item table unless needed to see labels.';
    const hist = history.length ? history.map((h, i) => `${i + 1}. ${h}`).join('\n') : '(none)';
    return [
        `PHASE: GATHER for ${modeLabel(mode)}. ${scope}`,
        'You may ONLY: scroll, click document-viewer page controls, or click the Table tab to reveal the line-item area.',
        'When you have enough screenshots/context of the document AND the form labels, respond with {"action":"done_gathering","reason":"..."}.',
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
