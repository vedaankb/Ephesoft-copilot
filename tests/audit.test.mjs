/**
 * Additional audit + content-script surface tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    normalizeAmount,
    sanitizeDetailsPlan,
    sanitizeLineItemsPlan,
    buildGatherPrompt,
    buildDecidePrompt,
} from '../extension/lib/fill_plan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

describe('content_script command surface', () => {
    const cs = fs.readFileSync(path.join(root, 'extension/content_script.js'), 'utf8');
    const required = [
        'ping',
        'observe',
        'fill',
        'select',
        'click',
        'fill_row',
        'exists',
        'scroll',
        'inventory_fields',
        'inventory_table',
        'read_field',
        'fill_by_id',
        'page_signals',
        'wait_for_row',
    ];
    for (const cmd of required) {
        it(`handles cmd ${cmd}`, () => {
            assert.match(cs, new RegExp(`case '${cmd}'`));
        });
    }
    it('still blocks validate', () => {
        assert.match(cs, /BANNED/);
        assert.match(cs, /validate/);
    });
    it('uses framework-safe setNativeValue', () => {
        assert.match(cs, /setNativeValue/);
        assert.match(cs, /fireInputEvents/);
    });
});

describe('sidepanel activity wiring', () => {
    const js = fs.readFileSync(path.join(root, 'extension/sidepanel.js'), 'utf8');
    it('disables both fill buttons while running', () => {
        assert.match(js, /fillDetails\.disabled/);
        assert.match(js, /fillLineItems\.disabled/);
    });
    it('starts modes correctly', () => {
        assert.match(js, /start\('fill_details'\)/);
        assert.match(js, /start\('fill_line_items'\)/);
        assert.match(js, /start\('next'\)/);
    });
    it('supports page gate override start', () => {
        assert.match(js, /overridePageGate:\s*true/);
        assert.match(js, /page_gate_blocked/);
        assert.match(js, /page_blocked/);
    });
});

describe('service worker page gate before LLM', () => {
    const sw = fs.readFileSync(path.join(root, 'extension/service_worker.js'), 'utf8');
    it('calls assertPageGate in fill and next paths', () => {
        const matches = sw.match(/assertPageGate\(/g) || [];
        assert.ok(matches.length >= 2, `expected >=2 assertPageGate calls, got ${matches.length}`);
    });
    it('posts page_gate_blocked without calling Gemini first conceptually', () => {
        assert.match(sw, /page_gate_blocked/);
        assert.match(sw, /page_signals/);
        // Gate helper is defined before gather/agent loops use think()
        const gateIdx = sw.indexOf('async function assertPageGate');
        const gatherIdx = sw.indexOf('async function runGatherDecideFill');
        assert.ok(gateIdx > 0 && gatherIdx > gateIdx);
    });
});

describe('update.ps1 and install encoding', () => {
    for (const file of ['update.ps1', 'install.ps1']) {
        it(`${file} has no Write-Host and is ASCII`, () => {
            const t = fs.readFileSync(path.join(root, file), 'utf8');
            assert.doesNotMatch(t, /Write-Host/);
            for (let i = 0; i < t.length; i += 1) {
                assert.ok(t.charCodeAt(i) < 128, `${file} non-ascii at ${i}`);
            }
        });
    }
});

describe('README documents new UX', () => {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    it('mentions Fill Details and Fill Line Items', () => {
        assert.match(readme, /Fill Details/);
        assert.match(readme, /Fill Line Items/);
    });
    it('documents update.ps1', () => {
        assert.match(readme, /update\.ps1/);
    });
});

describe('prompt files loadable', () => {
    for (const f of ['system.md', 'sop_rules.md', 'doc_types.md']) {
        it(`${f} non-empty`, () => {
            const t = fs.readFileSync(path.join(root, 'extension/prompts', f), 'utf8');
            assert.ok(t.trim().length > 50);
        });
    }
});

describe('decide plans reject inventing empty catalogs gracefully', () => {
    it('details without catalog still maps free selectors', () => {
        const { ok, plan } = sanitizeDetailsPlan({
            fields: [{ field_id: 'custom', value: 'x', selector: '#x', confidence: 1 }],
        }, { fields: [] });
        assert.equal(ok, true);
        // empty catalog.fields length is 0 — unknown_field path only when catalog.fields.length
        assert.equal(plan.fields.length, 1);
    });
});

describe('gather prompt mode differences', () => {
    const obs = { url: 'u', title: 't', text: 'x', html: 'h', scroll: { y: 0, maxY: 1, atBottom: true } };
    it('details scope', () => {
        assert.match(buildGatherPrompt('fill_details', obs, []), /HEADER|DETAILS/i);
    });
    it('line items scope', () => {
        assert.match(buildGatherPrompt('fill_line_items', obs, []), /LINE ITEMS/i);
    });
});

describe('amount edge fuzz', () => {
    const samples = [
        '$$$1',
        '1.',
        '.5',
        '1,2,3',
        '12,34.56',
        '  ',
        'nan',
        '1e2',
        '($12.00)',
    ];
    for (const s of samples) {
        it(`does not throw on ${JSON.stringify(s)}`, () => {
            assert.equal(typeof normalizeAmount(s), 'string');
        });
    }
});

describe('line items cells label match', () => {
    const cat = {
        columns: [
            { column_id: 'desc_0', label: 'Service', index: 0 },
            { column_id: 'amt_1', label: 'Charge', index: 1 },
        ],
    };
    it('matches by label', () => {
        const { plan } = sanitizeLineItemsPlan({
            rows: [{
                cells: [
                    { label: 'Service', value: 'Consult' },
                    { label: 'Charge', value: '$50' },
                ],
                confidence: 1,
            }],
        }, cat);
        assert.deepEqual(plan.rows[0].values, ['Consult', '50']);
    });
});

describe('update.ps1 syntax smoke', () => {
    const t = fs.readFileSync(path.join(root, 'update.ps1'), 'utf8');
    it('has error action stop', () => assert.match(t, /ErrorActionPreference/));
    it('exits when no install', () => assert.match(t, /No existing install/));
    it('copies extension into app dir', () => assert.match(t, /Copy-Item/));
    it('does not wipe profile directory contents intentionally', () => {
        assert.doesNotMatch(t, /Remove-Item.*ProfileDir/);
    });
    it('never uses Write-Host (encoding-safe Write-Output only)', () => {
        assert.doesNotMatch(t, /Write-Host/);
        assert.match(t, /Write-Output/);
    });
    it('is ASCII-only (no encoding-sensitive glyphs)', () => {
        for (let i = 0; i < t.length; i += 1) {
            assert.ok(t.charCodeAt(i) < 128, `non-ascii at ${i}: ${t.charCodeAt(i)}`);
        }
    });
    it('does not use UTF8 Set-Content', () => {
        assert.doesNotMatch(t, /Set-Content[^\n]*Encoding\s+UTF8/i);
    });
});

describe('service worker still supports next step loop', () => {
    const sw = fs.readFileSync(path.join(root, 'extension/service_worker.js'), 'utf8');
    it('keeps runAgent', () => assert.match(sw, /async function runAgent/));
    it('routes next to runAgent', () => {
        assert.match(sw, /runGatherDecideFill/);
        assert.match(sw, /runAgent\(mode/);
    });
    it('legacy fill maps to fill_details', () => {
        assert.match(sw, /mode === 'fill' \? 'fill_details'/);
    });
});

describe('buildDecidePrompt embeds JSON catalog', () => {
    const catalog = { fields: [{ field_id: 'a_0', label: 'A' }] };
    const p = buildDecidePrompt('fill_details', 'summary here', catalog);
    it('includes summary', () => assert.match(p, /summary here/));
    it('includes field id', () => assert.match(p, /a_0/));
});
