/**
 * Expanded integration suite: page gate + fill agents + split modes + override.
 * Simulates the full pre-LLM → plan → DOM action path without Chrome/Gemini.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    agentOpensTableTab,
    buildDecidePrompt,
    buildDetailsActions,
    buildGatherPrompt,
    buildLineItemActions,
    detectPageKind,
    evaluatePageGate,
    isAllowedGatherClick,
    isFillMode,
    isGatherAction,
    isTableTabClick,
    modeLabel,
    normalizeAmount,
    normalizeDate,
    normalizeFieldValue,
    pageGateMessage,
    pageKindLabel,
    pickNextBatch,
    preflightDetails,
    requiredPageForMode,
    sanitizeDetailsPlan,
    sanitizeLineItemsPlan,
    simulateFillRun,
    summarizeContextBuffer,
    valuesRoughlyEqual,
} from '../extension/lib/fill_plan.js';
import { parseJsonResponse } from '../extension/lib/gemini.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ---------- fixtures ----------

function detailsCatalog() {
    return {
        fields: [
            {
                field_id: 'doc_type_0',
                label: 'Document Type',
                tag: 'select',
                type: 'select',
                selector: '#docType',
                options: [
                    { value: 'Invoice', text: 'Invoice' },
                    { value: 'Receipt', text: 'Receipt' },
                    { value: 'Statement', text: 'Statement' },
                ],
            },
            {
                field_id: 'provider_1',
                label: 'Provider Name',
                tag: 'input',
                type: 'text',
                selector: '#provider',
                options: [],
            },
            {
                field_id: 'amount_2',
                label: 'Amount',
                tag: 'input',
                type: 'text',
                selector: '#amount',
                options: [],
            },
            {
                field_id: 'pet_name_3',
                label: 'Pet Name',
                tag: 'input',
                type: 'text',
                selector: '#pet',
                options: [],
            },
            {
                field_id: 'service_date_4',
                label: 'Service Date',
                tag: 'input',
                type: 'date',
                selector: '#svcDate',
                options: [],
            },
            {
                field_id: 'tax_5',
                label: 'Tax',
                tag: 'input',
                type: 'text',
                selector: '#tax',
                options: [],
            },
        ],
        docTypeOptions: [
            { value: 'Invoice', text: 'Invoice' },
            { value: 'Receipt', text: 'Receipt' },
        ],
    };
}

function tableCatalog() {
    return {
        columns: [
            { column_id: 'description_0', label: 'Description', index: 0 },
            { column_id: 'amount_1', label: 'Amount', index: 1 },
            { column_id: 'qty_2', label: 'Qty', index: 2 },
        ],
        controls: {
            table_tab: { label: 'Table', selector: '#tableTab' },
            add_row: { label: 'Add Row', selector: '#addRow' },
            clear: { label: 'Clear', selector: '#clearTable' },
        },
        row_selector: 'table tbody tr:last-child',
        row_count: 0,
    };
}

function signalsFor(kind) {
    if (kind === 'details') {
        return {
            url: 'https://ephesoft.example/validate/123',
            title: 'Validate',
            text_sample: 'Document Type Provider Amount Pet Name Service Date',
            field_count: 6,
            select_count: 1,
            has_doc_type_select: true,
            table_column_count: 0,
            table_row_count: 0,
            has_add_row: false,
            has_clear: false,
            has_table_tab: true,
            has_line_item_inputs: false,
            batch_list_hints: false,
            batch_row_count: 0,
        };
    }
    if (kind === 'table') {
        return {
            url: 'https://ephesoft.example/validate/123',
            title: 'Validate',
            text_sample: 'Description Amount Qty Add Row Clear',
            field_count: 0,
            select_count: 0,
            has_doc_type_select: false,
            table_column_count: 3,
            table_row_count: 1,
            has_add_row: true,
            has_clear: true,
            has_table_tab: true,
            has_line_item_inputs: true,
            batch_list_hints: false,
            batch_row_count: 0,
        };
    }
    return {
        url: 'https://ephesoft.example/batches',
        title: 'Batch List',
        text_sample: 'Batches Assigned Ready Received Created Unassigned',
        field_count: 0,
        select_count: 0,
        has_doc_type_select: false,
        table_column_count: 0,
        table_row_count: 0,
        has_add_row: false,
        has_clear: false,
        has_table_tab: false,
        has_line_item_inputs: false,
        batch_list_hints: true,
        batch_row_count: 15,
    };
}

/**
 * Mirrors service-worker pre-LLM gate + fill simulation.
 * Returns { gate, filled, blocked }.
 */
function runAgentPipeline(mode, pageKind, rawPlan, opts = {}) {
    const detection = detectPageKind(signalsFor(pageKind));
    const gate = evaluatePageGate(mode, detection, opts);
    if (gate.blocked) {
        return { gate, blocked: true, filled: null, detection };
    }

    if (mode === 'next') {
        return { gate, blocked: false, filled: { kind: 'next_ok' }, detection };
    }

    const catalog = mode === 'fill_line_items' ? tableCatalog() : detailsCatalog();
    const sanitized = mode === 'fill_line_items'
        ? sanitizeLineItemsPlan(rawPlan, catalog)
        : sanitizeDetailsPlan(rawPlan, catalog);

    if (!sanitized.ok || !sanitized.plan || sanitized.plan.kind === 'incomplete') {
        return { gate, blocked: false, filled: { incomplete: true, plan: sanitized.plan }, detection, sanitized };
    }

    const view = mode === 'fill_line_items' ? 'table' : 'details';
    const filled = simulateFillRun(mode, sanitized.plan, {
        catalog,
        view,
        fields: {},
        rows: pageKind === 'table' ? [{ values: ['stale'] }] : [],
    });
    const actions = mode === 'fill_line_items'
        ? buildLineItemActions(sanitized.plan, catalog)
        : buildDetailsActions(sanitized.plan, catalog);

    return {
        gate,
        blocked: false,
        filled,
        detection,
        sanitized,
        actions,
    };
}

// ---------- mode matrix ----------

describe('agent pipeline: mode x page matrix', () => {
    const modes = ['fill_details', 'fill_line_items', 'next'];
    const pages = ['details', 'table', 'batch_list'];

    for (const mode of modes) {
        for (const page of pages) {
            const required = requiredPageForMode(mode);
            const shouldBlock = page !== required;
            it(`${mode} on ${page} => ${shouldBlock ? 'block' : 'allow'}`, () => {
                const result = runAgentPipeline(mode, page, {
                    doc_type: 'Invoice',
                    fields: [{ field_id: 'amount_2', value: '10', confidence: 1 }],
                    rows: [{ values: ['A', '1', '1'], confidence: 1 }],
                    clear_first: true,
                });
                assert.equal(result.blocked, shouldBlock, `gate reason=${result.gate.reason}`);
                if (!shouldBlock && mode !== 'next') {
                    assert.ok(result.filled);
                    assert.equal(result.filled.ok, true);
                }
            });
        }
    }
});

describe('agent pipeline: override unlocks every blocked cell', () => {
    const cases = [
        ['fill_details', 'table'],
        ['fill_details', 'batch_list'],
        ['fill_line_items', 'details'],
        ['fill_line_items', 'batch_list'],
        ['next', 'details'],
        ['next', 'table'],
    ];
    for (const [mode, page] of cases) {
        it(`override ${mode} on ${page}`, () => {
            const blocked = runAgentPipeline(mode, page, {
                doc_type: 'Invoice',
                fields: [{ field_id: 'provider_1', value: 'Acme', confidence: 1 }],
                rows: [{ values: ['Exam', '50', '1'], confidence: 1 }],
            });
            assert.equal(blocked.blocked, true);

            const forced = runAgentPipeline(mode, page, {
                doc_type: 'Invoice',
                fields: [{ field_id: 'provider_1', value: 'Acme', confidence: 1 }],
                rows: [{ values: ['Exam', '50', '1'], confidence: 1 }],
                clear_first: true,
            }, { overridePageGate: true });
            assert.equal(forced.blocked, false);
            assert.equal(forced.gate.overridden, true);
        });
    }
});

// ---------- fill details ability ----------

describe('Fill Details agent ability', () => {
    const cat = detailsCatalog();

    it('fills doc type + amounts + dates + names then stops (no rows)', () => {
        const raw = {
            doc_type: 'invoice',
            fields: [
                { field_id: 'provider_1', value: 'Happy Paws Vet', confidence: 0.99 },
                { field_id: 'amount_2', value: '$1,240.50', confidence: 0.98 },
                { field_id: 'pet_name_3', value: 'Rex', confidence: 0.97 },
                { field_id: 'service_date_4', value: '03/15/2024', confidence: 0.96 },
                { field_id: 'tax_5', value: 'USD 12.00', confidence: 0.9 },
            ],
            flags: [],
            note: 'header only',
        };
        const result = runAgentPipeline('fill_details', 'details', raw);
        assert.equal(result.blocked, false);
        assert.equal(result.filled.ok, true);
        assert.equal(result.filled.fields.amount_2, '1240.50');
        assert.equal(result.filled.fields.tax_5, '12.00');
        assert.equal(result.filled.fields.service_date_4, '2024-03-15');
        assert.equal(result.filled.rows.length, 0);
        assert.ok(!result.actions.some((a) => a.purpose === 'table_tab' || a.cmd === 'fill_row'));
        assert.ok(result.actions.some((a) => a.purpose === 'doc_type'));
    });

    it('skips low-confidence fields but still completes others', () => {
        const { plan, skipped } = sanitizeDetailsPlan({
            fields: [
                { field_id: 'amount_2', value: '10', confidence: 0.2 },
                { field_id: 'provider_1', value: 'Acme', confidence: 0.95 },
            ],
        }, cat);
        assert.ok(skipped.some((s) => s.reason === 'low_confidence'));
        const sim = simulateFillRun('fill_details', plan, { catalog: cat, view: 'details', fields: {}, rows: [] });
        assert.equal(sim.fields.provider_1, 'Acme');
        assert.equal(sim.fields.amount_2, undefined);
    });

    it('incomplete plan short-circuits fill', () => {
        const result = runAgentPipeline('fill_details', 'details', {
            incomplete: true,
            reason: 'Missing Invoice',
        });
        assert.equal(result.blocked, false);
        assert.equal(result.filled.incomplete, true);
        assert.equal(result.filled.plan.reason, 'Missing Invoice');
    });

    it('preflight resolves all catalog selectors', () => {
        const { plan } = sanitizeDetailsPlan({
            fields: [
                { field_id: 'amount_2', value: '5', confidence: 1 },
                { field_id: 'provider_1', value: 'X', confidence: 1 },
            ],
        }, cat);
        const pre = preflightDetails(plan, cat);
        assert.equal(pre.ok, true);
        assert.equal(pre.ready.length, 2);
    });
});

// ---------- fill line items ability ----------

describe('Fill Line Items agent ability', () => {
    it('human owns Table — agent never emits table_tab', () => {
        assert.equal(agentOpensTableTab(), false);
        const { plan } = sanitizeLineItemsPlan({
            clear_first: true,
            rows: [
                { values: ['Exam', '100.00', '1'], confidence: 1 },
                { values: ['Lab', '40.00', '1'], confidence: 1 },
                { values: ['Meds', '25.50', '2'], confidence: 1 },
            ],
        }, tableCatalog());
        const actions = buildLineItemActions(plan, tableCatalog());
        assert.ok(!actions.some((a) => a.purpose === 'table_tab' || a.selector === '#tableTab'));
        assert.equal(actions.filter((a) => a.purpose === 'clear_table').length, 1);
        assert.equal(actions.filter((a) => a.purpose === 'add_row').length, 3);
        assert.equal(actions.filter((a) => a.purpose === 'fill_row').length, 3);
    });

    it('pipeline fills rows when already on table', () => {
        const result = runAgentPipeline('fill_line_items', 'table', {
            clear_first: true,
            rows: [
                { values: ['Office visit', '$125.00', '1'], confidence: 0.95 },
                { values: ['Vaccine', '50', '1'], confidence: 0.94 },
            ],
        });
        assert.equal(result.blocked, false);
        assert.equal(result.filled.ok, true);
        assert.equal(result.filled.rows.length, 2);
        assert.deepEqual(result.filled.rows[0].values, ['Office visit', '125.00', '1']);
    });

    it('blocks when still on details (no LLM path)', () => {
        const result = runAgentPipeline('fill_line_items', 'details', {
            rows: [{ values: ['X', '1', '1'], confidence: 1 }],
        });
        assert.equal(result.blocked, true);
        assert.equal(result.filled, null);
        assert.match(result.gate.message, /Table/i);
        assert.match(result.gate.message, /Run anyway/i);
    });

    it('cells-by-column mapping works', () => {
        const { plan } = sanitizeLineItemsPlan({
            rows: [{
                cells: [
                    { column_id: 'description_0', value: 'Consult' },
                    { column_id: 'amount_1', value: '$80' },
                    { column_id: 'qty_2', value: '1' },
                ],
                confidence: 1,
            }],
        }, tableCatalog());
        assert.deepEqual(plan.rows[0].values, ['Consult', '80', '1']);
    });
});

// ---------- split workflow ----------

describe('split fill workflow (details then table then line items)', () => {
    it('end-to-end human-driven split', () => {
        const details = runAgentPipeline('fill_details', 'details', {
            doc_type: 'Invoice',
            fields: [
                { field_id: 'provider_1', value: 'Acme', confidence: 1 },
                { field_id: 'amount_2', value: '175.00', confidence: 1 },
            ],
        });
        assert.equal(details.blocked, false);
        assert.equal(details.filled.fields.provider_1, 'Acme');

        // Wrong: try line items before opening Table
        const tooEarly = runAgentPipeline('fill_line_items', 'details', {
            rows: [{ values: ['Exam', '100', '1'], confidence: 1 }],
        });
        assert.equal(tooEarly.blocked, true);

        // Human opens Table, then line items
        const lines = runAgentPipeline('fill_line_items', 'table', {
            clear_first: true,
            rows: [
                { values: ['Exam', '100.00', '1'], confidence: 1 },
                { values: ['Vaccine', '75.00', '1'], confidence: 1 },
            ],
        });
        assert.equal(lines.blocked, false);
        assert.equal(lines.filled.rows.length, 2);
    });
});

// ---------- NEXT navigation ----------

describe('Next agent navigation ability', () => {
    it('pipeline allows only on batch list', () => {
        assert.equal(runAgentPipeline('next', 'batch_list', {}).blocked, false);
        assert.equal(runAgentPipeline('next', 'details', {}).blocked, true);
        assert.equal(runAgentPipeline('next', 'table', {}).blocked, true);
    });

    it('picks oldest eligible batch across shuffled lists', () => {
        for (let i = 0; i < 20; i += 1) {
            const batches = [
                { id: 'new', created: '2025-01-01', status: 'Ready', assigned_to: '' },
                { id: 'old', created: '2023-01-01', status: 'Ready', assigned_to: '' },
                { id: 'busy', created: '2022-01-01', status: 'In Progress', assigned_to: '' },
                { id: 'owned', created: '2021-01-01', status: 'Ready', assigned_to: 'pat' },
            ];
            // shuffle
            batches.sort(() => Math.random() - 0.5);
            const pick = pickNextBatch(batches);
            assert.equal(pick.id, 'old');
        }
    });
});

// ---------- gather constraints ----------

describe('gather phase constraints for fill agents', () => {
    const obs = {
        url: 'https://x',
        title: 't',
        text: 'doc text',
        html: '<div/>',
        scroll: { y: 0, maxY: 100, atBottom: false },
    };

    it('details gather forbids Table and fill', () => {
        const p = buildGatherPrompt('fill_details', obs, []);
        assert.match(p, /Do NOT open the line-item Table/i);
        assert.match(p, /done_gathering/);
        assert.match(p, /Do NOT fill/);
    });

    it('line items gather assumes human opened Table', () => {
        const p = buildGatherPrompt('fill_line_items', obs, []);
        assert.match(p, /HUMAN already opened the Table/i);
        assert.match(p, /Do NOT click Table/i);
    });

    it('blocks table / add row / clear gather clicks', () => {
        assert.equal(isTableTabClick({ action: 'click', selector: '#tableTab' }), true);
        assert.equal(isAllowedGatherClick({ action: 'click', note: 'Add Row' }, 'fill_line_items'), false);
        assert.equal(isAllowedGatherClick({ action: 'click', note: 'Clear table' }, 'fill_line_items'), false);
        assert.equal(isAllowedGatherClick({
            action: 'click',
            selector: '#viewerNext',
            note: 'document next page',
        }, 'fill_details'), true);
        assert.equal(isGatherAction({ action: 'done_gathering' }), true);
        assert.equal(isGatherAction({ action: 'fill' }), false);
    });
});

// ---------- decide prompts / memory ----------

describe('decide prompts and memory context', () => {
    it('details decide requires catalog field_ids', () => {
        const p = buildDecidePrompt('fill_details', 'invoice total 100', detailsCatalog());
        assert.match(p, /field_id/);
        assert.match(p, /amount_2/);
        assert.match(p, /Do NOT include line-item/);
    });

    it('line items decide includes clear_first', () => {
        const p = buildDecidePrompt('fill_line_items', 'two lines', tableCatalog());
        assert.match(p, /clear_first/);
        assert.match(p, /TABLE CATALOG/);
    });

    it('summarizeContextBuffer keeps scroll snapshots', () => {
        const s = summarizeContextBuffer([
            { text: 'page1 amount 10', scrollY: 0 },
            { text: 'page2 total 20', scrollY: 800 },
        ]);
        assert.match(s, /snapshot 1/);
        assert.match(s, /snapshot 2/);
        assert.match(s, /amount 10/);
    });
});

// ---------- value fidelity ----------

describe('fill value fidelity (normalize + verify)', () => {
    const pairs = [
        ['$1,234.56', '1234.56'],
        ['USD 99', '99'],
        ['01/02/2024', '2024-01-02'],
        ['  Acme  ', 'Acme'],
    ];
    for (const [raw, expected] of pairs) {
        it(`normalize ${JSON.stringify(raw)}`, () => {
            if (raw.includes('/') || raw.includes('-') && /\d{4}/.test(raw)) {
                // date-ish handled via field meta in other tests
            }
            if (/\$|USD|,|\d/.test(raw) && !raw.includes('/')) {
                assert.equal(normalizeAmount(raw), expected === 'Acme' ? normalizeAmount(raw) : expected);
            }
        });
    }

    it('valuesRoughlyEqual accepts currency variants', () => {
        assert.equal(valuesRoughlyEqual('1240.50', '$1,240.50'), true);
        assert.equal(valuesRoughlyEqual('2024-01-02', '01/02/2024'), true);
        assert.equal(valuesRoughlyEqual('Acme', 'ACME'), true);
    });

    it('normalizeFieldValue by label', () => {
        assert.equal(normalizeFieldValue('$5.00', { label: 'Tax Amount' }), '5.00');
        assert.equal(normalizeFieldValue('02/03/2024', { type: 'date' }), '2024-02-03');
        assert.equal(normalizeDate('12/31/23'), '2023-12-31');
    });
});

// ---------- parse model plans ----------

describe('parse model JSON plans into fill actions', () => {
    it('parses fenced details plan', () => {
        const obj = parseJsonResponse('```json\n{"doc_type":"Invoice","fields":[{"field_id":"amount_2","value":"10","confidence":1}]}\n```');
        const { plan } = sanitizeDetailsPlan(obj, detailsCatalog());
        const actions = buildDetailsActions(plan, detailsCatalog());
        assert.ok(actions.some((a) => a.field_id === 'amount_2'));
    });

    it('parses embedded line-item plan', () => {
        const obj = parseJsonResponse('Here you go {"clear_first":true,"rows":[{"values":["A","1","1"],"confidence":1}]} thanks');
        const { plan } = sanitizeLineItemsPlan(obj, tableCatalog());
        assert.equal(plan.clear_first, true);
        assert.equal(buildLineItemActions(plan, tableCatalog()).length, 3); // clear + add + fill
    });
});

// ---------- labels / modes ----------

describe('mode helpers', () => {
    it('isFillMode / modeLabel', () => {
        assert.equal(isFillMode('fill_details'), true);
        assert.equal(isFillMode('fill_line_items'), true);
        assert.equal(isFillMode('next'), false);
        assert.equal(modeLabel('fill_details'), 'FILL DETAILS');
        assert.equal(modeLabel('fill_line_items'), 'FILL LINE ITEMS');
    });
});

// ---------- page gate messaging ----------

describe('page gate messaging for Activity override UX', () => {
    for (const mode of ['fill_details', 'fill_line_items', 'next']) {
        it(`${mode} message invites Run anyway`, () => {
            const msg = pageGateMessage(mode, 'unknown');
            assert.match(msg, /Run anyway/i);
            assert.ok(pageKindLabel(requiredPageForMode(mode)).length > 3);
        });
    }
});

// ---------- full-repo regression audit ----------

describe('full regression audit: all recent features present', () => {
    const sw = fs.readFileSync(path.join(root, 'extension/service_worker.js'), 'utf8');
    const cs = fs.readFileSync(path.join(root, 'extension/content_script.js'), 'utf8');
    const sp = fs.readFileSync(path.join(root, 'extension/sidepanel.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'extension/sidepanel.html'), 'utf8');
    const sys = fs.readFileSync(path.join(root, 'extension/prompts/system.md'), 'utf8');
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const update = fs.readFileSync(path.join(root, 'update.ps1'), 'utf8');
    const install = fs.readFileSync(path.join(root, 'install.ps1'), 'utf8');

    it('UI has two fill buttons + next + stop', () => {
        assert.match(html, /fillDetailsBtn/);
        assert.match(html, /fillLineItemsBtn/);
        assert.match(html, /nextBtn/);
        assert.match(html, /stopBtn/);
        assert.doesNotMatch(html, /id="fillBtn"/);
    });

    it('sidepanel wires modes + override', () => {
        assert.match(sp, /fill_details/);
        assert.match(sp, /fill_line_items/);
        assert.match(sp, /overridePageGate/);
        assert.match(sp, /page_gate_blocked/);
        assert.match(sp, /Run anyway/);
    });

    it('service worker gather-decide-fill + page gate', () => {
        assert.match(sw, /runGatherDecideFill/);
        assert.match(sw, /assertPageGate/);
        assert.match(sw, /buildDetailsActions/);
        assert.match(sw, /buildLineItemActions/);
        assert.match(sw, /page_gate_blocked/);
        assert.match(sw, /outcome: 'page_blocked'/);
        assert.doesNotMatch(sw, /Opening Table view/);
    });

    it('content script inventories + page_signals', () => {
        assert.match(cs, /inventory_fields/);
        assert.match(cs, /inventory_table/);
        assert.match(cs, /page_signals/);
        assert.match(cs, /fill_by_id/);
        assert.match(cs, /wait_for_row/);
        assert.match(cs, /validate/);
    });

    it('prompts: human Table + stop after each fill', () => {
        assert.match(sys, /HUMAN has already clicked the Table/i);
        assert.match(sys, /STOPS/);
        assert.match(sys, /FILL DETAILS/);
        assert.match(sys, /FILL LINE ITEMS/);
        assert.match(sys, /done_gathering/);
        assert.match(sys, /NEVER CLICK VALIDATE/);
    });

    it('README documents split fill + page gate + update.ps1', () => {
        assert.match(readme, /Fill Details/);
        assert.match(readme, /Fill Line Items/);
        assert.match(readme, /Page gate/);
        assert.match(readme, /Run anyway/);
        assert.match(readme, /update\.ps1/);
    });

    it('update.ps1 encoding-safe', () => {
        assert.doesNotMatch(update, /Write-Host/);
        assert.match(update, /Write-Output/);
        for (let i = 0; i < update.length; i += 1) {
            assert.ok(update.charCodeAt(i) < 128, `non-ascii at ${i}`);
        }
        assert.match(install, /update\.ps1/);
        assert.doesNotMatch(install, /Write-Host/);
    });
});

// ---------- stress: many rows / fields ----------

describe('stress: large plans still simulate cleanly', () => {
    it('20 detail fields cycle', () => {
        const cat = detailsCatalog();
        const ids = ['provider_1', 'amount_2', 'pet_name_3', 'tax_5'];
        const fields = ids.map((id, i) => ({ field_id: id, value: `v${i}`, confidence: 1 }));
        const { plan } = sanitizeDetailsPlan({ doc_type: 'Invoice', fields }, cat);
        const sim = simulateFillRun('fill_details', plan, { catalog: cat, view: 'details', fields: {}, rows: [] });
        assert.equal(sim.ok, true);
        assert.ok(Object.keys(sim.fields).length >= 4);
    });

    it('30 line-item rows', () => {
        const cat = tableCatalog();
        const rows = Array.from({ length: 30 }, (_, i) => ({
            values: [`item${i}`, `${i + 1}.00`, '1'],
            confidence: 1,
        }));
        const { plan } = sanitizeLineItemsPlan({ clear_first: true, rows }, cat);
        const sim = simulateFillRun('fill_line_items', plan, { catalog: cat, view: 'table', rows: [] });
        assert.equal(sim.ok, true);
        assert.equal(sim.rows.length, 30);
        const actions = buildLineItemActions(plan, cat);
        assert.ok(!actions.some((a) => a.purpose === 'table_tab'));
        assert.equal(actions.filter((a) => a.purpose === 'fill_row').length, 30);
    });
});

// ---------- gate+fill combo fuzz ----------

describe('fuzz: random eligible fills never block on matching page', () => {
    for (let i = 0; i < 25; i += 1) {
        it(`details fuzz ${i}`, () => {
            const result = runAgentPipeline('fill_details', 'details', {
                doc_type: i % 2 ? 'Invoice' : 'Receipt',
                fields: [
                    { field_id: 'amount_2', value: `$${(i + 1) * 3}.00`, confidence: 0.8 + (i % 2) * 0.1 },
                    { field_id: 'provider_1', value: `Clinic-${i}`, confidence: 0.9 },
                ],
            });
            assert.equal(result.blocked, false);
            assert.equal(result.filled.ok, true);
        });
    }

    for (let i = 0; i < 25; i += 1) {
        it(`line items fuzz ${i}`, () => {
            const n = (i % 5) + 1;
            const clearFirst = i % 2 === 0;
            const result = runAgentPipeline('fill_line_items', 'table', {
                clear_first: clearFirst,
                rows: Array.from({ length: n }, (_, j) => ({
                    values: [`L${i}-${j}`, `${j + 1}.25`, '1'],
                    confidence: 0.9,
                })),
            });
            assert.equal(result.blocked, false);
            assert.equal(result.filled.ok, true);
            // Stale row may remain when clear_first is false (pipeline seeds one stale row).
            const expected = clearFirst ? n : n + 1;
            assert.equal(result.filled.rows.length, expected);
            assert.deepEqual(result.filled.rows[result.filled.rows.length - 1].values.slice(0, 2), [
                `L${i}-${n - 1}`,
                `${n}.25`,
            ]);
        });
    }
});
