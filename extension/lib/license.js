/**
 * Offline Cryptographic License Verification for Ephesoft Copilot.
 *
 * Uses the browser's native Web Crypto API (100% offline, zero dependencies)
 * to verify asymmetric ECDSA signatures.
 */

// Embedded public key (SPKI DER, base64). Must match keys/public.pem from the generator.
const PUBLIC_KEY_B64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAENjggM1sgS+0M9BwDfKPYfNfAzBBP0iHWDhQPXYLxH9m2uLJmjYN4F28chmIaqFFc+o+cp6XoeIJLmdcmYF1W1Q==';

// Internal developer bypass — not a single character; share only with trusted testers.
const DEV_BYPASS_KEY = 'EPHESOFT-DEV-BYPASS-7K9M2P';

function base64ToArrayBuffer(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

async function importPublicKey() {
    const derBuffer = base64ToArrayBuffer(PUBLIC_KEY_B64);
    return crypto.subtle.importKey(
        'spki',
        derBuffer,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
    );
}

/** Local calendar date as YYYY-MM-DD (avoids UTC off-by-one on expiry day). */
function localDateString(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Verify the cryptographic signature of a license key offline.
 * @param {string} licenseKeyB64 - Base64 license string or internal dev bypass key.
 * @returns {Promise<object>} Validated license payload.
 */
export async function verifyLicenseOffline(licenseKeyB64) {
    if (!licenseKeyB64) {
        throw new Error('No license key provided.');
    }

    const trimmed = licenseKeyB64.trim();

    if (trimmed === DEV_BYPASS_KEY) {
        return {
            client: 'Developer Bypass',
            expires: '2099-12-31',
            kid: 'dev',
        };
    }

    let licenseObj;
    try {
        licenseObj = JSON.parse(atob(trimmed));
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

    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.expires)) {
        throw new Error('License expiration date is invalid.');
    }

    try {
        const publicKey = await importPublicKey();
        const dataBytes = new TextEncoder().encode(JSON.stringify(payload));
        const sigBuffer = base64ToArrayBuffer(signature);

        const isValid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: { name: 'SHA-256' } },
            publicKey,
            sigBuffer,
            dataBytes
        );

        if (!isValid) {
            throw new Error('Cryptographic signature verification failed.');
        }
    } catch (e) {
        if (e.message.includes('signature')) throw e;
        throw new Error(`License signature is invalid: ${e.message}`);
    }

    const today = localDateString();
    if (today > payload.expires) {
        throw new Error(`License expired on ${payload.expires}. Please contact the developer for a renewal.`);
    }

    return payload;
}
