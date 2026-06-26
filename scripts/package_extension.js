#!/usr/bin/env node
/**
 * Package the Ephesoft Copilot Chrome extension into a distributable .zip.
 *
 * The zip's ROOT contains manifest.json (required by Chrome for "Load unpacked"
 * and for Chrome Web Store upload). Zero npm dependencies - shells out to the
 * system `zip` (present on macOS/Linux).
 *
 * Usage:  node scripts/package_extension.js
 * Output: dist/ephesoft-copilot-extension-v<version>.zip
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const DIST = path.join(ROOT, 'dist');

function fail(msg) {
    console.error(`\n  ✗ ${msg}\n`);
    process.exit(1);
}

if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    fail('extension/manifest.json not found - run from the repo root.');
}

const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const version = manifest.version || '0.0.0';

// Sanity-check that the referenced files exist so we never ship a broken zip.
const required = [
    'service_worker.js',
    'content_script.js',
    'sidepanel.html',
    'sidepanel.css',
    'sidepanel.js',
    'lib/gemini.js',
    'prompts/system.md',
    'prompts/sop_rules.md',
    'prompts/doc_types.md',
];
const missing = required.filter(f => !fs.existsSync(path.join(EXT_DIR, f)));
if (missing.length) fail(`Missing required extension files:\n   - ${missing.join('\n   - ')}`);

fs.mkdirSync(DIST, { recursive: true });
const zipName = `ephesoft-copilot-extension-v${version}.zip`;
const zipPath = path.join(DIST, zipName);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

try {
    // -r recurse, -X strip extra mac attrs; run inside extension/ so paths are root-relative.
    execFileSync('zip', ['-r', '-X', zipPath, '.', '-x', '.DS_Store', '-x', '*/.DS_Store'], {
        cwd: EXT_DIR,
        stdio: 'inherit',
    });
} catch (e) {
    fail(`zip failed (${e.message}). On Windows, right-click the "extension" folder > "Send to" > "Compressed (zipped) folder" instead.`);
}

const sizeKb = Math.round(fs.statSync(zipPath).size / 1024);
console.log(`\n  ✓ Built ${path.relative(ROOT, zipPath)} (${sizeKb} KB), version ${version}\n`);
console.log('  Distribute / install:');
console.log('   - Load unpacked (dev): chrome://extensions > Developer mode > Load unpacked > select the "extension" folder');
console.log('   - From zip: unzip, then Load unpacked on the unzipped folder');
console.log('   - Chrome Web Store / Admin policy: upload this zip\n');
