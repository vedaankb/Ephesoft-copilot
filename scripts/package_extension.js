#!/usr/bin/env node
/**
 * Package the Ephesoft Copilot Chrome extension into a distributable .zip.
 *
 * This script:
 * 1. Copies the `extension` source folder to a temporary build directory `dist/build`.
 * 2. Obfuscates all JavaScript files inside the build directory to protect intellectual
 *    property and license checks from being tampered with.
 * 3. Packages the obfuscated build directory into a distributable .zip.
 * 4. Cleans up the temporary build directory.
 *
 * Usage:  node scripts/package_extension.js
 * Output: dist/ephesoft-copilot-extension-v<version>.zip
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const JavaScriptObfuscator = require('javascript-obfuscator');

const ROOT = path.resolve(__dirname, '..');
const EXT_DIR = path.join(ROOT, 'extension');
const DIST_DIR = path.join(ROOT, 'dist');
const BUILD_DIR = path.join(DIST_DIR, 'build');

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
    'lib/license.js',
    'prompts/system.md',
    'prompts/sop_rules.md',
    'prompts/doc_types.md',
];
const missing = required.filter(f => !fs.existsSync(path.join(EXT_DIR, f)));
if (missing.length) fail(`Missing required extension files:\n   - ${missing.join('\n   - ')}`);

// Create clean dist and build directories
if (fs.existsSync(BUILD_DIR)) {
    fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}
fs.mkdirSync(BUILD_DIR, { recursive: true });

/**
 * Recursively copy a directory.
 */
function copyDir(src, dest) {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * Recursively find and obfuscate all JS files in a directory.
 */
function obfuscateDir(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            obfuscateDir(fullPath);
        } else if (entry.isFile() && entry.name.endsWith('.js')) {
            console.log(`     Obfuscating: ${path.relative(BUILD_DIR, fullPath)}`);
            const code = fs.readFileSync(fullPath, 'utf8');
            
            try {
                const obfuscated = JavaScriptObfuscator.obfuscate(code, {
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
                }).getObfuscatedCode();

                fs.writeFileSync(fullPath, obfuscated, 'utf8');
            } catch (err) {
                fail(`Obfuscation failed for ${entry.name}: ${err.message}`);
            }
        }
    }
}

console.log('--------------------------------------------------');
console.log('          PACKAGING EPHESOFT COPILOT              ');
console.log('--------------------------------------------------');

// 1. Copy extension folder to build folder
console.log('  1. Copying extension files to temporary build directory...');
copyDir(EXT_DIR, BUILD_DIR);

// 2. Obfuscate JS files in the build folder
console.log('  2. Obfuscating JavaScript files to protect Intellectual Property...');
obfuscateDir(BUILD_DIR);

// 3. Zip the build folder
console.log('  3. Compressing obfuscated files into distributable zip...');
const zipName = `ephesoft-copilot-extension-v${version}.zip`;
const zipPath = path.join(DIST_DIR, zipName);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

try {
    // Run zip command inside BUILD_DIR so paths in the zip are root-relative
    execFileSync('zip', ['-r', '-X', zipPath, '.', '-x', '.DS_Store', '-x', '*/.DS_Store'], {
        cwd: BUILD_DIR,
        stdio: 'ignore',
    });
} catch (e) {
    // If zip CLI fails (e.g. on Windows), notify user
    console.warn(`\n  [WARNING] System 'zip' CLI failed or is not installed.`);
    console.warn('  Please compress the "dist/build" folder manually to create your zip.\n');
}

// 4. Clean up temporary build folder
console.log('  4. Cleaning up temporary build files...');
fs.rmSync(BUILD_DIR, { recursive: true, force: true });

const sizeKb = fs.existsSync(zipPath) ? Math.round(fs.statSync(zipPath).size / 1024) : 0;

console.log('--------------------------------------------------');
console.log('  ✓ SUCCESS: Extension Packaged & Obfuscated!');
console.log('--------------------------------------------------');
if (sizeKb > 0) {
    console.log(`  File:    dist/${zipName} (${sizeKb} KB)`);
} else {
    console.log(`  Obfuscated files are ready in: dist/build/ (Please zip manually)`);
}
console.log(`  Version: ${version}`);
console.log('--------------------------------------------------\n');
