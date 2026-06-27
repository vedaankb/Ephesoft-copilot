#!/usr/bin/env node
/**
 * Package the Ephesoft Copilot Chrome extension into a distributable .zip.
 *
 * 1. Generates icons if missing
 * 2. Copies extension/ to dist/build
 * 3. Obfuscates JS (lighter settings for content_script.js)
 * 4. Zips to dist/ephesoft-copilot-extension-v<version>.zip
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const DIST_DIR = path.join(ROOT, 'dist');
const BUILD_DIR = path.join(DIST_DIR, 'build');

const OBFUSCATE_HEAVY = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.6,
    numbersToExpressions: true,
    simplify: true,
    stringArray: true,
    stringArrayThreshold: 0.7,
    splitStrings: true,
    splitStringsChunkLength: 8,
    unicodeEscapeSequence: false,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.2,
};

const OBFUSCATE_LIGHT = {
    compact: true,
    controlFlowFlattening: false,
    stringArray: true,
    stringArrayThreshold: 0.5,
    simplify: true,
    unicodeEscapeSequence: false,
};

function fail(msg) {
    console.error(`\n  ✗ ${msg}\n`);
    process.exit(1);
}

if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    fail('extension/manifest.json not found - run from the repo root.');
}

// Ensure icons exist before packaging.
const iconsDir = path.join(EXT_DIR, 'icons');
if (!fs.existsSync(path.join(iconsDir, 'icon128.png'))) {
    require('./generate_icons.js');
}

const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const version = manifest.version || '0.0.0';

const required = [
    'service_worker.js',
    'content_script.js',
    'sidepanel.html',
    'sidepanel.css',
    'sidepanel.js',
    'lib/gemini.js',
    'lib/license.js',
    'icons/icon16.png',
    'icons/icon48.png',
    'icons/icon128.png',
    'prompts/system.md',
    'prompts/sop_rules.md',
    'prompts/doc_types.md',
];
const missing = required.filter(f => !fs.existsSync(path.join(EXT_DIR, f)));
if (missing.length) fail(`Missing required extension files:\n   - ${missing.join('\n   - ')}`);

if (fs.existsSync(BUILD_DIR)) {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}
fs.mkdirSync(BUILD_DIR, { recursive: true });

function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) copyDir(srcPath, destPath);
        else fs.copyFileSync(srcPath, destPath);
    }
}

function obfuscateFile(fullPath) {
    const rel = path.relative(BUILD_DIR, fullPath);
    const isContentScript = rel === 'content_script.js';
    const opts = isContentScript ? OBFUSCATE_LIGHT : OBFUSCATE_HEAVY;
    console.log(`     Obfuscating (${isContentScript ? 'light' : 'heavy'}): ${rel}`);
    const code = fs.readFileSync(fullPath, 'utf8');
    try {
        const obfuscated = JavaScriptObfuscator.obfuscate(code, opts).getObfuscatedCode();
        fs.writeFileSync(fullPath, obfuscated, 'utf8');
    } catch (err) {
        fail(`Obfuscation failed for ${rel}: ${err.message}`);
    }
}

function obfuscateDir(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) obfuscateDir(fullPath);
        else if (entry.isFile() && entry.name.endsWith('.js')) obfuscateFile(fullPath);
    }
}

console.log('--------------------------------------------------');
console.log('          PACKAGING EPHESOFT COPILOT              ');
console.log('--------------------------------------------------');

console.log('  1. Copying extension files to temporary build directory...');
copyDir(EXT_DIR, BUILD_DIR);

console.log('  2. Obfuscating JavaScript files...');
obfuscateDir(BUILD_DIR);

console.log('  3. Compressing obfuscated files into distributable zip...');
const zipName = `ephesoft-copilot-extension-v${version}.zip`;
const zipPath = path.join(DIST_DIR, zipName);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

try {
    execFileSync('zip', ['-r', '-X', zipPath, '.', '-x', '.DS_Store', '-x', '*/.DS_Store'], {
        cwd: BUILD_DIR,
        stdio: 'ignore',
    });
} catch (e) {
    console.warn('\n  [WARNING] System zip CLI failed. Compress dist/build manually.\n');
}

console.log('  4. Cleaning up temporary build files...');
fs.rmSync(BUILD_DIR, { recursive: true, force: true });

const sizeKb = fs.existsSync(zipPath) ? Math.round(fs.statSync(zipPath).size / 1024) : 0;

console.log('--------------------------------------------------');
console.log('  ✓ SUCCESS: Extension Packaged & Obfuscated!');
console.log('--------------------------------------------------');
if (sizeKb > 0) {
    console.log(`  File:    dist/${zipName} (${sizeKb} KB)`);
} else {
    console.log('  Obfuscated files are ready in: dist/build/ (Please zip manually)');
}
console.log(`  Version: ${version}`);
console.log('--------------------------------------------------\n');
