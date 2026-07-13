/**
 * Massive unit suite for fill_plan helpers + installer/prompt/manifest audits.
 * Run: node --test tests/*.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    ALLOWED_INCOMPLETE,
    CONFIDENCE_THRESHOLD,
    MAX_GATHER_STEPS,
    MAX_RECOVERY_CALLS,
    buildDecidePrompt,
    buildGatherPrompt,
    isFillMode,
    isGatherAction,
    matchSelectOption,
    modeLabel,
    normalizeAmount,
    normalizeDate,
    normalizeFieldValue,
    preflightDetails,
    resolveCatalogColumn,
    resolveCatalogField,
    sanitizeDetailsPlan,
    sanitizeLineItemsPlan,
    slugify,
    summarizeContextBuffer,
    valuesRoughlyEqual,
} from '../extension/lib/fill_plan.js';
import { parseJsonResponse } from '../extension/lib/gemini.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function sampleCatalog() {
    return {
        fields: [
            {
                field_id: 'amount_0',
                label: 'Amount',
                tag: 'input',
                type: 'text',
                selector: '#amount',
                options: [],
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
                field_id: 'doc_type_2',
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
                field_id: 'service_date_3',
                label: 'Service Date',
                tag: 'input',
                type: 'date',
                selector: '#svcDate',
                options: [],
            },
        ],
        docTypeOptions: [
            { value: 'Invoice', text: 'Invoice' },
            { value: 'Receipt', text: 'Receipt' },
        ],
    };
}

function sampleTableCatalog() {
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

// ---------- normalizeAmount ----------

describe('normalizeAmount', () => {
    const cases = [
        ['$1,240.50', '1240.50'],
        ['£99.00', '99.00'],
        ['€1.5', '1.5'],
        ['1,000', '1000'],
        ['  $ 12.3 ', '12.3'],
        ['', ''],
        [null, ''],
        [undefined, ''],
        ['abc', 'abc'],
        ['-$40.00', '-40.00'],
        ['USD 12', '12'],
        ['12.00 USD', '12.00'],
        ['0', '0'],
        ['0.0', '0.0'],
        ['1,234,567.89', '1234567.89'],
    ];
    for (const [input, expected] of cases) {
        it(`normalizeAmount(${JSON.stringify(input)}) => ${JSON.stringify(expected)}`, () => {
            assert.equal(normalizeAmount(input), expected);
        });
    }
});

// ---------- normalizeDate ----------

describe('normalizeDate', () => {
    const cases = [
        ['2024-01-15', '2024-01-15'],
        ['01/15/2024', '2024-01-15'],
        ['1/5/24', '2024-01-05'],
        ['12-31-2023', '2023-12-31'],
        ['03.04.2022', '2022-03-04'],
        ['', ''],
        [null, ''],
        ['not-a-date', 'not-a-date'],
    ];
    for (const [input, expected] of cases) {
        it(`normalizeDate(${JSON.stringify(input)}) => ${JSON.stringify(expected)}`, () => {
            assert.equal(normalizeDate(input), expected);
        });
    }
});

// ---------- normalizeFieldValue ----------

describe('normalizeFieldValue', () => {
    it('strips currency for amount labels', () => {
        assert.equal(normalizeFieldValue('$1,200.00', { label: 'Invoice Amount' }), '1200.00');
    });
    it('normalizes dates for date type', () => {
        assert.equal(normalizeFieldValue('01/02/2024', { type: 'date' }), '2024-01-02');
    });
    it('trims plain text', () => {
        assert.equal(normalizeFieldValue('  Acme Vet  ', { label: 'Provider' }), 'Acme Vet');
    });
    it('handles tax label as amount', () => {
        assert.equal(normalizeFieldValue('$5.00', { label: 'Sales Tax' }), '5.00');
    });
    it('handles total label as amount', () => {
        assert.equal(normalizeFieldValue('1,000', { name: 'net_total' }), '1000');
    });
});

// ---------- matchSelectOption ----------

describe('matchSelectOption', () => {
    const opts = [
        { value: 'Invoice', text: 'Invoice' },
        { value: 'Receipt', text: 'Receipt' },
        { value: 'Credit Memo', text: 'Credit Memo' },
    ];
    it('exact value', () => assert.equal(matchSelectOption('Invoice', opts), 'Invoice'));
    it('case insensitive', () => assert.equal(matchSelectOption('invoice', opts), 'Invoice'));
    it('partial text', () => assert.equal(matchSelectOption('credit', opts), 'Credit Memo'));
    it('no match', () => assert.equal(matchSelectOption('Nope', opts), null));
    it('empty options', () => assert.equal(matchSelectOption('Invoice', []), null));
    it('null want', () => assert.equal(matchSelectOption(null, opts), null));
});

// ---------- catalog resolve ----------

describe('resolveCatalogField', () => {
    const cat = sampleCatalog();
    it('by field_id', () => assert.equal(resolveCatalogField('amount_0', cat).selector, '#amount'));
    it('by exact label', () => assert.equal(resolveCatalogField('Provider Name', cat).field_id, 'provider_1'));
    it('by includes', () => assert.equal(resolveCatalogField('Provider', cat).field_id, 'provider_1'));
    it('miss', () => assert.equal(resolveCatalogField('zzz', cat), null));
    it('empty', () => assert.equal(resolveCatalogField('', cat), null));
});

describe('resolveCatalogColumn', () => {
    const cat = sampleTableCatalog();
    it('by id', () => assert.equal(resolveCatalogColumn('amount_1', cat).label, 'Amount'));
    it('by label', () => assert.equal(resolveCatalogColumn('Description', cat).column_id, 'description_0'));
    it('miss', () => assert.equal(resolveCatalogColumn('nope', cat), null));
});

// ---------- sanitizeDetailsPlan ----------

describe('sanitizeDetailsPlan', () => {
    const cat = sampleCatalog();

    it('maps known fields and normalizes amounts', () => {
        const { ok, plan, skipped } = sanitizeDetailsPlan({
            doc_type: 'invoice',
            fields: [
                { field_id: 'amount_0', value: '$1,240.50', confidence: 0.9 },
                { field_id: 'provider_1', value: 'Acme', confidence: 0.95 },
            ],
        }, cat);
        assert.equal(ok, true);
        assert.equal(plan.kind, 'fill_details');
        assert.equal(plan.doc_type, 'Invoice');
        assert.equal(plan.fields.length, 2);
        assert.equal(plan.fields[0].value, '1240.50');
        assert.equal(skipped.length, 0);
    });

    it('skips low confidence', () => {
        const { plan, skipped } = sanitizeDetailsPlan({
            fields: [{ field_id: 'amount_0', value: '10', confidence: 0.1 }],
        }, cat);
        assert.equal(plan.fields.length, 0);
        assert.equal(skipped[0].reason, 'low_confidence');
    });

    it('skips unknown field_id when catalog present', () => {
        const { skipped, errors } = sanitizeDetailsPlan({
            fields: [{ field_id: 'ghost_9', value: 'x', confidence: 1 }],
        }, cat);
        assert.ok(skipped.some((s) => s.reason === 'unknown_field'));
        assert.ok(errors.length);
    });

    it('handles incomplete', () => {
        const { plan } = sanitizeDetailsPlan({
            incomplete: true,
            reason: 'Missing Invoice',
        }, cat);
        assert.equal(plan.kind, 'incomplete');
        assert.equal(plan.reason, 'Missing Invoice');
    });

    it('defaults invalid incomplete reason', () => {
        const { plan } = sanitizeDetailsPlan({
            action: 'incomplete',
            reason: 'Something Weird',
        }, cat);
        assert.equal(plan.reason, 'Missing Information');
    });

    it('rejects non-object', () => {
        const { ok } = sanitizeDetailsPlan(null, cat);
        assert.equal(ok, false);
    });

    it('matches select options for doc-type field values', () => {
        const { plan } = sanitizeDetailsPlan({
            fields: [{ field_id: 'doc_type_2', value: 'receipt', confidence: 1 }],
        }, cat);
        assert.equal(plan.fields[0].value, 'Receipt');
    });

    it('skips empty values', () => {
        const { skipped } = sanitizeDetailsPlan({
            fields: [{ field_id: 'amount_0', value: '  ', confidence: 1 }],
        }, cat);
        assert.equal(skipped[0].reason, 'empty_value');
    });

    it('normalizes service date field', () => {
        const { plan } = sanitizeDetailsPlan({
            fields: [{ field_id: 'service_date_3', value: '02/03/2024', confidence: 1 }],
        }, cat);
        assert.equal(plan.fields[0].value, '2024-02-03');
    });
});

// ---------- sanitizeLineItemsPlan ----------

describe('sanitizeLineItemsPlan', () => {
    const cat = sampleTableCatalog();

    it('accepts positional values', () => {
        const { plan } = sanitizeLineItemsPlan({
            clear_first: true,
            rows: [{ values: ['Exam', '$125.00', '1'], confidence: 0.9 }],
        }, cat);
        assert.equal(plan.kind, 'fill_line_items');
        assert.equal(plan.clear_first, true);
        assert.equal(plan.rows[0].values[1], '125.00');
    });

    it('accepts cells by column_id', () => {
        const { plan } = sanitizeLineItemsPlan({
            rows: [{
                cells: [
                    { column_id: 'description_0', value: 'Lab' },
                    { column_id: 'amount_1', value: '40' },
                    { column_id: 'qty_2', value: '2' },
                ],
                confidence: 1,
            }],
        }, cat);
        assert.deepEqual(plan.rows[0].values, ['Lab', '40', '2']);
    });

    it('skips low confidence rows', () => {
        const { skipped, plan } = sanitizeLineItemsPlan({
            rows: [{ values: ['x', '1'], confidence: 0.2 }],
        }, cat);
        assert.equal(plan.rows.length, 0);
        assert.equal(skipped[0].reason, 'low_confidence');
    });

    it('skips empty rows', () => {
        const { skipped } = sanitizeLineItemsPlan({
            rows: [{ values: ['', '', ''], confidence: 1 }],
        }, cat);
        assert.equal(skipped[0].reason, 'empty_row');
    });

    it('incomplete path', () => {
        const { plan } = sanitizeLineItemsPlan({
            incomplete: true,
            reason: 'Illegible Documents',
        }, cat);
        assert.equal(plan.kind, 'incomplete');
    });
});

// ---------- preflight / equality / gather helpers ----------

describe('preflightDetails', () => {
    const cat = sampleCatalog();
    it('marks ready fields', () => {
        const plan = {
            kind: 'fill_details',
            fields: [{ field_id: 'amount_0', value: '10' }],
        };
        const pre = preflightDetails(plan, cat);
        assert.equal(pre.ok, true);
        assert.equal(pre.ready[0].selector, '#amount');
    });
    it('invalid plan', () => {
        assert.equal(preflightDetails({ kind: 'x' }, cat).ok, false);
    });
});

describe('valuesRoughlyEqual', () => {
    const pairs = [
        ['1240.50', '$1,240.50', true],
        ['Acme', 'acme', true],
        ['2024-01-02', '01/02/2024', true],
        ['foo', 'bar', false],
        ['', '', true],
    ];
    for (const [a, b, exp] of pairs) {
        it(`${a} vs ${b}`, () => assert.equal(valuesRoughlyEqual(a, b), exp));
    }
});

describe('isGatherAction / isFillMode / modeLabel', () => {
    it('gather actions', () => {
        assert.equal(isGatherAction({ action: 'scroll' }), true);
        assert.equal(isGatherAction({ action: 'done_gathering' }), true);
        assert.equal(isGatherAction({ action: 'fill' }), false);
        assert.equal(isGatherAction(null), false);
    });
    it('fill modes', () => {
        assert.equal(isFillMode('fill_details'), true);
        assert.equal(isFillMode('fill_line_items'), true);
        assert.equal(isFillMode('fill'), true);
        assert.equal(isFillMode('next'), false);
    });
    it('labels', () => {
        assert.equal(modeLabel('fill_details'), 'FILL DETAILS');
        assert.equal(modeLabel('fill_line_items'), 'FILL LINE ITEMS');
        assert.equal(modeLabel('next'), 'NEXT');
    });
});

describe('prompt builders', () => {
    it('gather prompt forbids fill', () => {
        const p = buildGatherPrompt('fill_details', {
            url: 'https://x',
            title: 't',
            text: 'hello',
            html: '<div/>',
            scroll: { y: 0, maxY: 10, atBottom: false },
        }, []);
        assert.match(p, /GATHER/);
        assert.match(p, /Do NOT fill/);
        assert.match(p, /done_gathering/);
    });
    it('decide prompt includes catalog', () => {
        const p = buildDecidePrompt('fill_details', 'ctx', sampleCatalog());
        assert.match(p, /FIELD CATALOG/);
        assert.match(p, /amount_0/);
        assert.match(p, /field_id/);
    });
    it('line items decide prompt', () => {
        const p = buildDecidePrompt('fill_line_items', 'ctx', sampleTableCatalog());
        assert.match(p, /TABLE CATALOG/);
        assert.match(p, /clear_first/);
    });
    it('summarize context', () => {
        const s = summarizeContextBuffer([{ text: 'abc', scrollY: 10 }]);
        assert.match(s, /snapshot 1/);
        assert.match(s, /abc/);
        assert.equal(summarizeContextBuffer([]), '(no gathered context)');
    });
});

describe('constants', () => {
    it('thresholds sane', () => {
        assert.ok(CONFIDENCE_THRESHOLD > 0 && CONFIDENCE_THRESHOLD < 1);
        assert.ok(MAX_GATHER_STEPS >= 3);
        assert.ok(MAX_RECOVERY_CALLS >= 1);
        assert.deepEqual(ALLOWED_INCOMPLETE, [
            'Missing Invoice',
            'Missing Information',
            'Illegible Documents',
        ]);
    });
    it('slugify', () => {
        assert.equal(slugify('Provider Name!'), 'provider_name');
        assert.ok(slugify('').length > 0);
    });
});

// ---------- parseJsonResponse ----------

describe('parseJsonResponse', () => {
    it('plain json', () => assert.deepEqual(parseJsonResponse('{"ok":true}'), { ok: true }));
    it('fenced', () => assert.deepEqual(parseJsonResponse('```json\n{"a":1}\n```'), { a: 1 }));
    it('embedded', () => assert.deepEqual(parseJsonResponse('Here: {"x":2} done'), { x: 2 }));
    it('throws on garbage', () => assert.throws(() => parseJsonResponse('nope')));
});

// ---------- Property-style sweeps ----------

describe('amount normalize sweep', () => {
    for (let i = 0; i < 50; i += 1) {
        const dollars = (i * 17) % 10000;
        const cents = String(i % 100).padStart(2, '0');
        const pretty = `$${dollars.toLocaleString('en-US')}.${cents}`;
        const expected = `${dollars}.${cents}`;
        it(`sweep ${pretty}`, () => {
            assert.equal(normalizeAmount(pretty), expected);
        });
    }
});

describe('confidence gate sweep', () => {
    const cat = sampleCatalog();
    for (let c = 0; c <= 10; c += 1) {
        const conf = c / 10;
        it(`confidence ${conf}`, () => {
            const { plan, skipped } = sanitizeDetailsPlan({
                fields: [{ field_id: 'amount_0', value: '9', confidence: conf }],
            }, cat);
            if (conf < CONFIDENCE_THRESHOLD) {
                assert.equal(plan.fields.length, 0);
                assert.ok(skipped.length);
            } else {
                assert.equal(plan.fields.length, 1);
            }
        });
    }
});

describe('line item row count sweep', () => {
    const cat = sampleTableCatalog();
    for (let n = 0; n <= 25; n += 1) {
        it(`${n} rows`, () => {
            const rows = Array.from({ length: n }, (_, i) => ({
                values: [`item${i}`, `${i}.00`, '1'],
                confidence: 1,
            }));
            const { plan } = sanitizeLineItemsPlan({ rows }, cat);
            assert.equal(plan.rows.length, n);
        });
    }
});

// ---------- Repo audit ----------

describe('repo audit: UI split fill', () => {
    const html = fs.readFileSync(path.join(root, 'extension/sidepanel.html'), 'utf8');
    const js = fs.readFileSync(path.join(root, 'extension/sidepanel.js'), 'utf8');
    const sw = fs.readFileSync(path.join(root, 'extension/service_worker.js'), 'utf8');
    const cs = fs.readFileSync(path.join(root, 'extension/content_script.js'), 'utf8');
    const sys = fs.readFileSync(path.join(root, 'extension/prompts/system.md'), 'utf8');

    it('has Fill Details and Fill Line Items buttons', () => {
        assert.match(html, /fillDetailsBtn/);
        assert.match(html, /fillLineItemsBtn/);
        assert.doesNotMatch(html, /id="fillBtn"/);
    });
    it('wires fill_details and fill_line_items modes', () => {
        assert.match(js, /fill_details/);
        assert.match(js, /fill_line_items/);
    });
    it('service worker has gather-decide-fill', () => {
        assert.match(sw, /runGatherDecideFill/);
        assert.match(sw, /executeDetailsFromMemory/);
        assert.match(sw, /executeLineItemsFromMemory/);
        assert.match(sw, /fill_plan\.js/);
    });
    it('content script inventories fields/table', () => {
        assert.match(cs, /inventory_fields/);
        assert.match(cs, /inventory_table/);
        assert.match(cs, /fill_by_id/);
        assert.match(cs, /read_field/);
        assert.match(cs, /wait_for_row/);
    });
    it('prompts document gather/decide', () => {
        assert.match(sys, /FILL DETAILS/);
        assert.match(sys, /FILL LINE ITEMS/);
        assert.match(sys, /done_gathering/);
        assert.match(sys, /field_id/);
    });
    it('safety bans still present', () => {
        assert.match(cs, /validate/);
        assert.match(sys, /NEVER CLICK VALIDATE/);
    });
});

describe('repo audit: update.ps1', () => {
    const updatePath = path.join(root, 'update.ps1');
    const installPath = path.join(root, 'install.ps1');
    it('update.ps1 exists', () => assert.ok(fs.existsSync(updatePath)));
    it('update preserves profile and versioned app folder', () => {
        const t = fs.readFileSync(updatePath, 'utf8');
        assert.match(t, /EphesoftCopilot/);
        assert.match(t, /app-/);
        assert.match(t, /profile/);
        assert.match(t, /VERSION\.json/);
        assert.match(t, /main\.zip/);
        assert.match(t, /Updating Chrome shortcut/);
    });
    it('install.ps1 ships update.ps1', () => {
        const t = fs.readFileSync(installPath, 'utf8');
        assert.match(t, /update\.ps1/);
    });
});

describe('repo audit: manifest / package versions', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    it('manifest version present', () => assert.ok(manifest.version));
    it('package has test script', () => assert.ok(pkg.scripts && pkg.scripts.test));
    it('side panel path set', () => assert.equal(manifest.side_panel.default_path, 'sidepanel.html'));
    it('service worker module', () => assert.equal(manifest.background.type, 'module'));
});

describe('repo audit: fill_plan module exports used by SW', () => {
    const sw = fs.readFileSync(path.join(root, 'extension/service_worker.js'), 'utf8');
    for (const name of [
        'MAX_GATHER_STEPS',
        'MAX_RECOVERY_CALLS',
        'buildDecidePrompt',
        'buildGatherPrompt',
        'modeLabel',
        'preflightDetails',
        'sanitizeDetailsPlan',
        'sanitizeLineItemsPlan',
        'summarizeContextBuffer',
        'valuesRoughlyEqual',
    ]) {
        it(`SW references ${name}`, () => assert.match(sw, new RegExp(name)));
    }
});

describe('incomplete reason allow-list fuzz', () => {
    const cat = sampleCatalog();
    const junk = ['', 'foo', 'missing invoice', 'MISSING INVOICE', 'hack', 'Validate', null];
    for (const reason of junk) {
        it(`junk reason ${JSON.stringify(reason)} maps to allow-list`, () => {
            const { plan } = sanitizeDetailsPlan({ incomplete: true, reason }, cat);
            assert.ok(ALLOWED_INCOMPLETE.includes(plan.reason));
        });
    }
    for (const reason of ALLOWED_INCOMPLETE) {
        it(`keeps valid reason ${reason}`, () => {
            const { plan } = sanitizeDetailsPlan({ incomplete: true, reason }, cat);
            assert.equal(plan.reason, reason);
        });
    }
});

describe('select option no-match skips field', () => {
    const cat = sampleCatalog();
    it('unknown option skipped', () => {
        const { plan, skipped } = sanitizeDetailsPlan({
            fields: [{ field_id: 'doc_type_2', value: 'NotARealType', confidence: 1 }],
        }, cat);
        assert.equal(plan.fields.length, 0);
        assert.ok(skipped.some((s) => s.reason === 'no_option'));
    });
});
