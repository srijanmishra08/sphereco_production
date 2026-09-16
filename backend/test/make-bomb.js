'use strict';

/* Builds a decompression-bomb PDF: a small Flate stream that inflates to 600 MB.
   Generated rather than committed, because the point is the ratio, not the bytes. */

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const target = path.join(__dirname, 'fixtures', 'zip-bomb.pdf');
if (fs.existsSync(target) && process.argv[2] !== '--force') process.exit(0);

const bomb = zlib.deflateSync(Buffer.alloc(600 * 1024 * 1024, 0));
const head = '%PDF-1.4\n' +
    '1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n' +
    '2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n' +
    '3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R>>\nendobj\n' +
    `4 0 obj\n<</Length ${bomb.length}/Filter/FlateDecode>>\nstream\n`;

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, Buffer.concat([
    Buffer.from(head, 'latin1'), bomb, Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1')
]));
console.log(`zip-bomb.pdf: ${(fs.statSync(target).size / 1024).toFixed(0)} KB on disk, inflates to 600 MB`);
