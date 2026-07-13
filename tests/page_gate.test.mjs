/**
 * Page-gate: detect page kind, block wrong page before LLM, allow override.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    detectPageKind,
    evaluatePageGate,
    pageGateMessage,
    pageKindLabel,
    requiredPageForMode,
} from '../extension/lib/fill_plan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function detailsSignals(extra = {}) {
    return {
        url: 'https://ephesoft.example/validate/batch/123',
        title: 'Validate Document',
        text_sample: 'Provider Amount Service Date Document Type',
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
        ...extra,
    };
}

function tableSignals(extra = {}) {
    return {
        url: 'https://ephesoft.example/validate/batch/123',
        title: 'Validate Document',
        text_sample: 'Description Amount Add Row Clear',
        field_count: 1,
        select_count: 0,
        has_doc_type_select: false,
        table_column_count: 3,
        table_row_count: 0,
        has_add_row: true,
        has_clear: true,
        has_table_tab: true,
        has_line_item_inputs: true,
        batch_list_hints: false,
        batch_row_count: 0,
        ...extra,
    };
}

function batchListSignals(extra = {}) {
    return {
        url: 'https://ephesoft.example/batch-list',
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
        batch_row_count: 12,
        ...extra,
    };
}

describe('requiredPageForMode', () => {
    it('maps modes', () => {
        assert.equal(requiredPageForMode('next'), 'batch_list');
        assert.equal(requiredPageForMode('fill_details'), 'details');
        assert.equal(requiredPageForMode('fill'), 'details');
        assert.equal(requiredPageForMode('fill_line_items'), 'table');
    });
});

describe('detectPageKind — right pages', () => {
    it('detects details', () => {
        const d = detectPageKind(detailsSignals());
        assert.equal(d.kind, 'details');
        assert.ok(d.confidence === 'medium' || d.confidence === 'high');
    });
    it('detects table', () => {
        const d = detectPageKind(tableSignals());
        assert.equal(d.kind, 'table');
    });
    it('detects batch list', () => {
        const d = detectPageKind(batchListSignals());
        assert.equal(d.kind, 'batch_list');
    });
    it('unknown when empty', () => {
        const d = detectPageKind({});
        assert.equal(d.kind, 'unknown');
    });
});

describe('evaluatePageGate — allow on match', () => {
    for (const [mode, signals] of [
        ['fill_details', detailsSignals()],
        ['fill_line_items', tableSignals()],
        ['next', batchListSignals()],
    ]) {
        it(`allows ${mode} on matching page`, () => {
            const detection = detectPageKind(signals);
            const gate = evaluatePageGate(mode, detection);
            assert.equal(gate.allow, true);
            assert.equal(gate.blocked, false);
        });
    }
});

describe('evaluatePageGate — block confident mismatches', () => {
    it('blocks fill_details on table', () => {
        const gate = evaluatePageGate('fill_details', detectPageKind(tableSignals()));
        assert.equal(gate.blocked, true);
        assert.match(gate.message, /Fill Details/i);
    });
    it('blocks fill_details on batch list', () => {
        const gate = evaluatePageGate('fill_details', detectPageKind(batchListSignals()));
        assert.equal(gate.blocked, true);
    });
    it('blocks fill_line_items on details', () => {
        const gate = evaluatePageGate('fill_line_items', detectPageKind(detailsSignals()));
        assert.equal(gate.blocked, true);
        assert.match(gate.message, /Table/i);
    });
    it('blocks next on details', () => {
        const gate = evaluatePageGate('next', detectPageKind(detailsSignals()));
        assert.equal(gate.blocked, true);
    });
});

describe('evaluatePageGate — override bypasses block', () => {
    it('override on wrong page allows', () => {
        const gate = evaluatePageGate(
            'fill_details',
            detectPageKind(tableSignals()),
            { overridePageGate: true }
        );
        assert.equal(gate.allow, true);
        assert.equal(gate.blocked, false);
        assert.equal(gate.overridden, true);
    });
});

describe('evaluatePageGate — unknown does not block', () => {
    it('allows unknown', () => {
        const gate = evaluatePageGate('fill_details', { kind: 'unknown', confidence: 'low', scores: {} });
        assert.equal(gate.blocked, false);
        assert.equal(gate.reason, 'unknown_allow');
    });
    it('allows low confidence mismatch', () => {
        const gate = evaluatePageGate('fill_details', { kind: 'table', confidence: 'low', scores: {} });
        assert.equal(gate.blocked, false);
        assert.equal(gate.reason, 'low_confidence_allow');
    });
});

describe('pageGateMessage / labels', () => {
    it('messages mention run anyway', () => {
        assert.match(pageGateMessage('fill_line_items', 'details'), /Run anyway/i);
        assert.match(pageGateMessage('next', 'details'), /batch list/i);
    });
    it('labels', () => {
        assert.match(pageKindLabel('table'), /Table/i);
        assert.match(pageKindLabel('details'), /details/i);
    });
});

describe('repo audit: page gate wiring', () => {
    const sw = fs.readFileSync(path.join(root, 'extension/service_worker.js'), 'utf8');
    const cs = fs.readFileSync(path.join(root, 'extension/content_script.js'), 'utf8');
    const sp = fs.readFileSync(path.join(root, 'extension/sidepanel.js'), 'utf8');

    it('SW asserts page gate before LLM paths', () => {
        assert.match(sw, /assertPageGate/);
        assert.match(sw, /page_gate_blocked/);
        assert.match(sw, /overridePageGate/);
        assert.match(sw, /detectPageKind/);
        assert.match(sw, /evaluatePageGate/);
    });
    it('content script exposes page_signals', () => {
        assert.match(cs, /page_signals/);
        assert.match(cs, /function pageSignals/);
    });
    it('sidepanel has Run anyway override', () => {
        assert.match(sp, /page_gate_blocked/);
        assert.match(sp, /Run anyway/);
        assert.match(sp, /overridePageGate/);
        assert.match(sp, /page_blocked/);
    });
});

describe('detection sweep — details never blocked as table when no add_row', () => {
    for (let fields = 3; fields <= 10; fields += 1) {
        it(`field_count=${fields}`, () => {
            const d = detectPageKind(detailsSignals({ field_count: fields, has_add_row: false }));
            assert.notEqual(d.kind, 'table');
            const gate = evaluatePageGate('fill_details', d);
            assert.equal(gate.blocked, false);
        });
    }
});

describe('detection sweep — table with add_row never blocked for line items', () => {
    for (let cols = 2; cols <= 6; cols += 1) {
        it(`columns=${cols}`, () => {
            const d = detectPageKind(tableSignals({ table_column_count: cols }));
            assert.equal(d.kind, 'table');
            assert.equal(evaluatePageGate('fill_line_items', d).blocked, false);
        });
    }
});
