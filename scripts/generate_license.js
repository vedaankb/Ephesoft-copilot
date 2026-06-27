#!/usr/bin/env node
/**
 * Local Cryptographic License Generator for Ephesoft Copilot.
 *
 * This script runs locally on the creator's machine to generate cryptographically
 * signed, offline license keys for clients. It uses Node's built-in `crypto` module.
 *
 * It generates:
 * 1. A Keypair (if not already existing) to sign license keys.
 * 2. A signed License Key (Base64 string) containing client name, allowed domain,
 *    expiration date, and a cryptographic signature.
 *
 * Usage:
 *   node scripts/generate_license.js --client "Client A" --expires "2027-12-31"
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const KEYS_DIR = path.join(ROOT, 'keys');
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'private.pem');
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'public.pem');

// Ensure keys directory exists
if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
}

/**
 * Generate an asymmetric keypair (ECDSA prime256v1) if not already present.
 */
function ensureKeypair() {
    if (fs.existsSync(PRIVATE_KEY_PATH) && fs.existsSync(PUBLIC_KEY_PATH)) {
        return {
            privateKey: fs.readFileSync(PRIVATE_KEY_PATH, 'utf8'),
            publicKey: fs.readFileSync(PUBLIC_KEY_PATH, 'utf8'),
        };
    }

    console.log('No existing keypair found. Generating new ECDSA prime256v1 keypair...');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, 'utf8');
    fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, 'utf8');
    console.log(`Keypair generated and saved to ${KEYS_DIR}/`);
    return { privateKey, publicKey };
}

/**
 * Parse command line arguments.
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const params = {
        client: '',
        expires: '',
    };

    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--client' && args[i + 1]) {
            params.client = args[i + 1];
            i++;
        } else if (args[i] === '--expires' && args[i + 1]) {
            params.expires = args[i + 1];
            i++;
        }
    }

    return params;
}

function main() {
    const { privateKey, publicKey } = ensureKeypair();
    const { client, expires } = parseArgs();

    if (!client || !expires) {
        console.log('\nUsage:');
        console.log('  node scripts/generate_license.js --client "Client Name" --expires "YYYY-MM-DD"');
        console.log('\nExample:');
        console.log('  node scripts/generate_license.js --client "Wombat BPO" --expires "2027-06-30"\n');
        process.exit(1);
    }

    // Validate expiry date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
        console.error('ERROR: Expiration date must be in YYYY-MM-DD format.');
        process.exit(1);
    }

    // Build the license metadata payload
    const payload = {
        client,
        expires,
    };

    // Serialize payload to a stable JSON string
    const serialized = JSON.stringify(payload);

    // Sign the payload using the private key
    const sign = crypto.createSign('SHA256');
    sign.update(serialized);
    const signature = sign.sign(privateKey, 'base64');

    // Combine payload and signature into the final license key object
    const licenseObj = {
        payload,
        signature,
    };

    // Encode the entire license object as a single Base64 string for easy copy-pasting
    const licenseKey = Buffer.from(JSON.stringify(licenseObj)).toString('base64');

    console.log('\n==================================================');
    console.log('          LICENSE GENERATED SUCCESSFULLY          ');
    console.log('==================================================');
    console.log(`Client:    ${client}`);
    console.log(`Expires:   ${expires}`);
    console.log('==================================================');
    console.log('\nLICENSE KEY (Copy the entire block below):\n');
    console.log(licenseKey);
    console.log('\n==================================================\n');

    // Extract the raw public key bytes in SPKI format (SubjectPublicKeyInfo)
    // for embedding into the extension's Web Crypto verification logic.
    const spkiDer = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
    const spkiB64 = spkiDer.toString('base64');
    
    console.log('DEVELOPER INFO (Embed this public key base64 in the extension):');
    console.log(spkiB64);
    console.log('\n==================================================\n');
}

main();
