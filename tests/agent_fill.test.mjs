/**
 * Agent fill + navigate simulation suite.
 * Covers Fill Details / Fill Line Items action sequencing, human Table ownership,
 * NEXT batch picking, and gather click guards — without Chrome.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    agentOpensTableTab,
    buildDetailsActions,
    buildGatherPrompt,
    buildLineItemActions,
    findDocTypeField,
    isAllowedGatherClick,
    isTableTabClick,
    pickNextBatch,
    sanitizeDetailsPlan,
    sanitizeLineItemsPlan,
    simulateFillRun,
} from '../extension/lib/fill_plan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

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
                ],
            },
            {
                field_id: 'provider_1',
                label: 'Provider',
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
                selector: '#svc',
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

describe('agent does not open Table tab', () => {
    it('agentOpensTableTab is false', () => assert.equal(agentOpensTableTab(), false));

    it('line-item action sequence never clicks table_tab', () => {
        const { plan } = sanitizeLineItemsPlan({
            clear_first: true,
            rows: [
                { values: ['Exam', '100.00'], confidence: 1 },
                { values: ['Lab', '40.00'], confidence: 1 },
            ],
        }, tableCatalog());
        const actions = buildLineItemActions(plan, tableCatalog());
        assert.ok(actions.length >= 4);
        assert.ok(!actions.some((a) => a.purpose === 'table_tab'));
        assert.ok(!actions.some((a) => a.selector === '#tableTab'));
        assert.equal(actions.filter((a) => a.purpose === 'add_row').length, 2);
        assert.equal(actions.filter((a) => a.purpose === 'fill_row').length, 2);
        assert.equal(actions.filter((a) => a.purpose === 'clear_table').length, 1);
    });

    it('details action sequence has no table controls', () => {
        const cat = detailsCatalog();
        const { plan } = sanitizeDetailsPlan({
            doc_type: 'Invoice',
            fields: [
                { field_id: 'provider_1', value: 'Acme Vet', confidence: 1 },
                { field_id: 'amount_2', value: '$1,200.00', confidence: 1 },
            ],
        }, cat);
        const actions = buildDetailsActions(plan, cat);
        assert.ok(actions.some((a) => a.purpose === 'doc_type'));
        assert.ok(!actions.some((a) => /table/i.test(a.selector || '')));
        assert.ok(!actions.some((a) => a.cmd === 'fill_row'));
    });
});

describe('simulateFillRun: Fill Details stops after headers', () => {
    it('fills fields and never touches rows', () => {
        const cat = detailsCatalog();
        const { plan } = sanitizeDetailsPlan({
            doc_type: 'Invoice',
            fields: [
                { field_id: 'provider_1', value: 'Acme', confidence: 1 },
                { field_id: 'amount_2', value: '50', confidence: 1 },
                { field_id: 'pet_name_3', value: 'Rex', confidence: 1 },
                { field_id: 'service_date_4', value: '01/02/2024', confidence: 1 },
            ],
        }, cat);
        const result = simulateFillRun('fill_details', plan, {
            catalog: cat,
            view: 'details',
            fields: {},
            rows: [{ values: ['stale'] }],
        });
        assert.equal(result.ok, true);
        assert.equal(result.fields.doc_type_0 || result.fields['#docType'] || result.fields[findDocTypeField(cat).field_id], 'Invoice');
        assert.equal(result.fields.provider_1, 'Acme');
        assert.equal(result.fields.amount_2, '50');
        assert.equal(result.fields.pet_name_3, 'Rex');
        assert.equal(result.fields.service_date_4, '2024-01-02');
        assert.deepEqual(result.rows, [{ values: ['stale'] }], 'details must not mutate line rows');
        assert.ok(!result.log.some((a) => a.purpose === 'add_row' || a.purpose === 'fill_row'));
    });
});

describe('simulateFillRun: Fill Line Items assumes Table already open', () => {
    it('clears, adds, fills without table_tab', () => {
        const cat = tableCatalog();
        const { plan } = sanitizeLineItemsPlan({
            clear_first: true,
            rows: [
                { values: ['Office visit', '125.00'], confidence: 1 },
                { values: ['Medication', '30.00'], confidence: 1 },
            ],
        }, cat);
        const result = simulateFillRun('fill_line_items', plan, {
            catalog: cat,
            view: 'table',
            fields: { amount_2: 'should_remain' },
            rows: [{ values: ['old', '1'] }],
        });
        assert.equal(result.ok, true);
        assert.equal(result.fields.amount_2, 'should_remain', 'line items must not touch header fields');
        assert.equal(result.rows.length, 2);
        assert.deepEqual(result.rows[0].values, ['Office visit', '125.00']);
        assert.deepEqual(result.rows[1].values, ['Medication', '30.00']);
        assert.ok(!result.log.some((a) => a.selector === '#tableTab'));
    });

    it('errors if add_row while not on table view', () => {
        const cat = tableCatalog();
        const { plan } = sanitizeLineItemsPlan({
            rows: [{ values: ['X', '1'], confidence: 1 }],
        }, cat);
        const result = simulateFillRun('fill_line_items', plan, {
            catalog: cat,
            view: 'details',
            rows: [],
        });
        assert.ok(result.errors.includes('add_row_without_table_view'));
    });
});

describe('gather click guards', () => {
    it('detects table tab clicks', () => {
        assert.equal(isTableTabClick({ action: 'click', selector: '#tableTab' }), true);
        assert.equal(isTableTabClick({ action: 'click', note: 'Open Table view' }), true);
        assert.equal(isTableTabClick({ action: 'click', selector: '#docNextPage', note: 'next page' }), false);
        assert.equal(isTableTabClick({ action: 'scroll', direction: 'down' }), false);
    });

    it('allows doc viewer page clicks only', () => {
        assert.equal(isAllowedGatherClick({ action: 'click', selector: '#viewerNext', note: 'document next page' }, 'fill_details'), true);
        assert.equal(isAllowedGatherClick({ action: 'click', selector: '#tableTab', note: 'Table' }, 'fill_line_items'), false);
        assert.equal(isAllowedGatherClick({ action: 'click', selector: '#addRow', note: 'Add Row' }, 'fill_line_items'), false);
        assert.equal(isAllowedGatherClick({ action: 'click', selector: '#clearTable', note: 'Clear' }, 'fill_line_items'), false);
        assert.equal(isAllowedGatherClick({ action: 'click', selector: '#random', note: 'mystery' }, 'fill_details'), false);
    });

    it('gather prompts tell human to open Table / stop after details', () => {
        const obs = { url: 'u', title: 't', text: 'x', html: 'h', scroll: { y: 0, maxY: 1, atBottom: true } };
        const details = buildGatherPrompt('fill_details', obs, []);
        const lines = buildGatherPrompt('fill_line_items', obs, []);
        assert.match(details, /Do NOT open the line-item Table/i);
        assert.match(lines, /HUMAN already opened the Table/i);
        assert.match(lines, /Do NOT click Table/i);
    });
});

describe('NEXT batch navigation picker', () => {
    const batches = [
        { id: 'B3', created: '2024-03-01', status: 'Ready', assigned_to: '' },
        { id: 'B1', created: '2024-01-01', status: 'In Progress', assigned_to: '' },
        { id: 'B2', created: '2024-02-01', status: 'Ready', assigned_to: 'alice' },
        { id: 'B0', created: '2023-12-01', status: 'Ready', assigned_to: '' },
        { id: 'B4', created: '2024-04-01', status: 'Locked', assigned_to: '' },
    ];

    it('picks oldest unassigned not-in-progress', () => {
        const pick = pickNextBatch(batches);
        assert.equal(pick.id, 'B0');
    });

    it('returns null when none eligible', () => {
        assert.equal(pickNextBatch([
            { id: 'X', status: 'In Progress', assigned_to: '' },
            { id: 'Y', status: 'Ready', assigned_to: 'bob' },
        ]), null);
    });

    it('handles empty', () => {
        assert.equal(pickNextBatch([]), null);
        assert.equal(pickNextBatch(null), null);
    });

    it('stable sort by id when dates equal', () => {
        const pick = pickNextBatch([
            { id: 'Z', created: '2024-01-01', status: 'Ready', assigned_to: '' },
            { id: 'A', created: '2024-01-01', status: 'Ready', assigned_to: '' },
        ]);
        assert.equal(pick.id, 'A');
    });
});

describe('fill action sequencing sweep', () => {
    const cat = detailsCatalog();
    for (let n = 1; n <= 12; n += 1) {
        it(`details plan with ${n} fields`, () => {
            const fields = [];
            for (let i = 0; i < n; i += 1) {
                const id = ['provider_1', 'amount_2', 'pet_name_3', 'service_date_4'][i % 4];
                fields.push({ field_id: id, value: `v${i}`, confidence: 1 });
            }
            // unique by field_id last-wins for sanitize — build unique set
            const uniq = new Map();
            for (const f of fields) uniq.set(f.field_id, f);
            const { plan } = sanitizeDetailsPlan({
                doc_type: 'Invoice',
                fields: [...uniq.values()],
            }, cat);
            const actions = buildDetailsActions(plan, cat);
            assert.ok(actions[0].purpose === 'doc_type');
            assert.ok(actions.every((a) => a.cmd === 'select' || a.cmd === 'fill_by_id'));
            const sim = simulateFillRun('fill_details', plan, { catalog: cat, view: 'details', fields: {}, rows: [] });
            assert.equal(sim.ok, true);
        });
    }

    const tcat = tableCatalog();
    for (let n = 0; n <= 15; n += 1) {
        it(`line items plan with ${n} rows`, () => {
            const rows = Array.from({ length: n }, (_, i) => ({
                values: [`item${i}`, `${(i + 1) * 10}.00`],
                confidence: 1,
            }));
            const { plan } = sanitizeLineItemsPlan({ clear_first: n > 0, rows }, tcat);
            const actions = buildLineItemActions(plan, tcat);
            if (n === 0) {
                assert.equal(actions.length, 0);
            } else {
                assert.ok(!actions.some((a) => a.purpose === 'table_tab'));
                assert.equal(actions.filter((a) => a.purpose === 'fill_row').length, n);
                const sim = simulateFillRun('fill_line_items', plan, {
                    catalog: tcat,
                    view: 'table',
                    rows: [{ values: ['old'] }],
                });
                assert.equal(sim.ok, true);
                assert.equal(sim.rows.length, n);
            }
        });
    }
});

describe('end-to-end split workflow simulation', () => {
    it('details then human opens table then line items', () => {
        const dcat = detailsCatalog();
        const tcat = tableCatalog();

        const details = sanitizeDetailsPlan({
            doc_type: 'Invoice',
            fields: [
                { field_id: 'provider_1', value: 'Happy Paws', confidence: 0.99 },
                { field_id: 'amount_2', value: '$175.00', confidence: 0.95 },
            ],
        }, dcat);
        const afterDetails = simulateFillRun('fill_details', details.plan, {
            catalog: dcat,
            view: 'details',
            fields: {},
            rows: [],
        });
        assert.equal(afterDetails.ok, true);
        assert.equal(afterDetails.fields.amount_2, '175.00');

        // Human navigates to table (not the agent).
        const page = {
            catalog: tcat,
            view: 'table',
            fields: { ...afterDetails.fields },
            rows: [],
        };

        const lines = sanitizeLineItemsPlan({
            clear_first: false,
            rows: [
                { values: ['Exam', '100.00'], confidence: 1 },
                { values: ['Vaccine', '75.00'], confidence: 1 },
            ],
        }, tcat);
        const afterLines = simulateFillRun('fill_line_items', lines.plan, page);
        assert.equal(afterLines.ok, true);
        assert.equal(afterLines.fields.provider_1, 'Happy Paws');
        assert.equal(afterLines.rows.length, 2);
    });
});

describe('repo audit: human opens Table / agent stops after fill', () => {
    const sw = fs.readFileSync(path.join(root, 'extension/service_worker.js'), 'utf8');
    const sys = fs.readFileSync(path.join(root, 'extension/prompts/system.md'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'extension/sidepanel.html'), 'utf8');

    it('SW does not auto-click Opening Table view', () => {
        assert.doesNotMatch(sw, /Opening Table view/);
    });
    it('SW uses buildLineItemActions / buildDetailsActions', () => {
        assert.match(sw, /buildLineItemActions/);
        assert.match(sw, /buildDetailsActions/);
        assert.match(sw, /isTableTabClick/);
        assert.match(sw, /isAllowedGatherClick/);
    });
    it('prompts say human opens Table and details stop', () => {
        assert.match(sys, /HUMAN has already clicked the Table/i);
        assert.match(sys, /STOPS/);
        assert.match(sys, /Do not click Table yourself/i);
    });
    it('Fill Line Items button title mentions open Table first', () => {
        assert.match(html, /Open the Table view yourself first/i);
    });
});

describe('NEXT picker fuzz', () => {
    for (let i = 0; i < 30; i += 1) {
        it(`random batch set ${i}`, () => {
            const batches = Array.from({ length: 8 }, (_, j) => ({
                id: `B${j}`,
                created: `2024-0${(j % 9) + 1}-01`,
                status: j % 3 === 0 ? 'In Progress' : 'Ready',
                assigned_to: j % 4 === 0 ? 'x' : '',
            }));
            const pick = pickNextBatch(batches);
            if (pick) {
                assert.equal(pick.assigned_to, '');
                assert.doesNotMatch(String(pick.status), /in\s*progress/i);
            }
        });
    }
});
