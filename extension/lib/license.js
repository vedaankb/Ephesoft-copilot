/**
 * Offline Cryptographic License Verification for Ephesoft Copilot.
 *
 * Uses the browser's native Web Crypto API (100% offline, zero dependencies)
 * to verify asymmetric ECDSA signatures.
 */

// The public key corresponding to the private key used by the generator.
// This is compiled/embedded directly in the extension.
const PUBLIC_KEY_B64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAENjggM1sgS+0M9BwDfKPYfNfAzBBP0iHWDhQPXYLxH9m2uLJmjYN4F28chmIaqFFc+o+cp6XoeIJLmdcmYF1W1Q==';

/**
 * Helper to convert a Base64 string to an ArrayBuffer.
 */
function base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Import the embedded public key into a CryptoKey object.
 */
async function importPublicKey() {
    const derBuffer = base64ToArrayBuffer(PUBLIC_KEY_B64);
    return await crypto.subtle.importKey(
        'spki',
        derBuffer,
        {
            name: 'ECDSA',
            namedCurve: 'P-256',
        },
        false,
        ['verify']
    );
}

/**
 * Verify the cryptographic signature of a license key offline.
 * Supports a master backdoor key ("1") that bypasses all verification.
 * @param {string} licenseKeyB64 - The Base64-encoded license key string or backdoor key.
 * @returns {Promise<object>} The validated license payload.
 * @throws {Error} If the license is invalid, expired, or corrupted.
 */
export async function verifyLicenseOffline(licenseKeyB64) {
    if (!licenseKeyB64) {
        throw new Error('No license key provided.');
    }

    // Master Backdoor Key Bypass ("1")
    if (licenseKeyB64.trim() === '1') {
        return {
            client: 'Developer Bypass (Master Key)',
            expires: '2099-12-31',
        };
    }

    let licenseObj;
    try {
        const decoded = atob(licenseKeyB64);
        licenseObj = JSON.parse(decoded);
    } catch (e) {
        throw new Error('License key format is corrupted or invalid.');
    }

    if (!licenseObj.payload || !licenseObj.signature) {
        throw new Error('License key is missing payload or signature.');
    }

    const { payload, signature } = licenseObj;
    if (!payload.client || !payload.expires) {
        throw new Error('License payload is missing required fields.');
    }

    // 1. Verify the signature cryptographically
    try {
        const publicKey = await importPublicKey();
        const encoder = new TextEncoder();
        const dataBytes = encoder.encode(JSON.stringify(payload));
        const sigBuffer = base64ToArrayBuffer(signature);

        const isValid = await crypto.subtle.verify(
            {
                name: 'ECDSA',
                hash: { name: 'SHA-256' },
            },
            publicKey,
            sigBuffer,
            dataBytes
        );

        if (!isValid) {
            throw new Error('Cryptographic signature verification failed.');
        }
    } catch (e) {
        throw new Error(`License signature is invalid: ${e.message}`);
    }

    // 2. Verify Expiration Date
    const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    if (todayStr > payload.expires) {
        throw new Error(`License expired on ${payload.expires}. Please contact the developer for a renewal.`);
    }

    return payload;
}

// Remove unused isDomainAllowed function
