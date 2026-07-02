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

function base64ToUint8Array(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function base64ToArrayBuffer(b64) {
    return base64ToUint8Array(b64).buffer;
}

/**
 * Normalize an ECDSA signature to the raw r||s (IEEE-P1363) form that Web Crypto
 * requires. Node's crypto.sign() emits DER/ASN.1 by default (a SEQUENCE of two
 * INTEGERs), which crypto.subtle.verify rejects. If the signature is already the
 * raw 64-byte form we return it unchanged.
 * @param {Uint8Array} sig
 * @returns {Uint8Array} 64-byte r||s signature for P-256
 */
function toRawEcdsaSignature(sig) {
    // Already raw r||s for P-256 (32 + 32). Nothing to do.
    if (sig.length === 64) return sig;

    // DER: 0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>
    if (sig[0] !== 0x30) {
        // Unknown encoding - hand it back and let verify fail loudly.
        return sig;
    }

    let offset = 2;
    if (sig[1] & 0x80) {
        // Long-form length (rare for P-256, but handle it).
        offset = 2 + (sig[1] & 0x7f);
    }

    if (sig[offset] !== 0x02) throw new Error('Malformed signature (expected INTEGER r).');
    const rLen = sig[offset + 1];
    let r = sig.slice(offset + 2, offset + 2 + rLen);
    offset = offset + 2 + rLen;

    if (sig[offset] !== 0x02) throw new Error('Malformed signature (expected INTEGER s).');
    const sLen = sig[offset + 1];
    let s = sig.slice(offset + 2, offset + 2 + sLen);

    // Strip DER's leading sign-byte zeros, then left-pad each to 32 bytes.
    const pad32 = (buf) => {
        let b = buf;
        while (b.length > 32 && b[0] === 0x00) b = b.slice(1);
        if (b.length < 32) {
            const out = new Uint8Array(32);
            out.set(b, 32 - b.length);
            return out;
        }
        return b;
    };

    const rP = pad32(r);
    const sP = pad32(s);
    const raw = new Uint8Array(64);
    raw.set(rP, 0);
    raw.set(sP, 32);
    return raw;
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
        // Deterministic serialization: ensure key order is identical to what the generator signed,
        // completely eliminating cross-platform property-ordering discrepancies.
        const verifiedString = JSON.stringify({
            ...(payload.v !== undefined ? { v: payload.v } : {}),
            client: payload.client,
            expires: payload.expires
        });
        const dataBytes = new TextEncoder().encode(verifiedString);
        // Convert Node's DER signature to the raw r||s form Web Crypto requires.
        const sigRaw = toRawEcdsaSignature(base64ToUint8Array(signature));

        const isValid = await crypto.subtle.verify(
            { name: 'ECDSA', hash: { name: 'SHA-256' } },
            publicKey,
            sigRaw,
            dataBytes
        );

        if (!isValid) {
            console.warn('[copilot][license] signature check returned false.',
                'verifiedString=', verifiedString,
                'sigLen=', sigRaw.length);
            throw new Error('Cryptographic signature verification failed.');
        }
    } catch (e) {
        if (e.message.includes('signature')) throw e;
        console.warn('[copilot][license] verify threw:', e && e.message);
        throw new Error(`License signature is invalid: ${e.message}`);
    }

    const today = localDateString();
    if (today > payload.expires) {
        throw new Error(`License expired on ${payload.expires}. Please contact the developer for a renewal.`);
    }

    return payload;
}
