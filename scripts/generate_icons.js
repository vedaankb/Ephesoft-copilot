#!/usr/bin/env node
/**
 * Write minimal PNG icons for the Chrome extension manifest.
 * Pure Node — no image dependencies. Solid dark-blue square with no alpha tricks.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'extension', 'icons');

function crc32(buf) {
    let c = ~0;
    for (let i = 0; i < buf.length; i++) {
        c ^= buf[i];
        for (let k = 0; k < 8; k++) {
            c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
        }
    }
    return ~c >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function solidPng(size, r, g, b) {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // RGB
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
        const off = 1 + x * 3;
        row[off] = r;
        row[off + 1] = g;
        row[off + 2] = b;
    }
    const raw = Buffer.alloc((1 + size * 3) * size);
    for (let y = 0; y < size; y++) {
        row.copy(raw, y * row.length);
    }

    const compressed = zlib.deflateSync(raw);
    return Buffer.concat([
        signature,
        chunk('IHDR', ihdr),
        chunk('IDAT', compressed),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// Brand color ~ #1a4fd6
const r = 26, g = 79, b = 214;
for (const size of [16, 48, 128]) {
    fs.writeFileSync(path.join(OUT, `icon${size}.png`), solidPng(size, r, g, b));
}
console.log('Icons written to extension/icons/');
