'use strict';

const crypto = require('crypto');

/* Ambiguous glyphs are left out so an issued password survives being read over
   the phone or retyped from a screenshot. */
const PWD = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const USER = 'abcdefghjkmnpqrstuvwxyz23456789';

function pick(alphabet, len) {
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

/* Cognito requires upper, lower, digit and symbol; the groups keep it legible. */
const generatePassword = () => `${pick(PWD, 5)}-${pick(PWD, 5)}-${pick(PWD, 6)}`;

const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;

function generateUsername(role, name, taken) {
    let base = String(name || role).toLowerCase()
        .replace(/[^a-z0-9]+/g, '.')
        .replace(/^\.+|\.+$/g, '')
        .slice(0, 18)
        .replace(/\.+$/, '');
    if (!base) base = role;

    const prefix = role === 'partner' ? 'p' : 'i';
    let candidate = `${prefix}.${base}`;
    let guard = 0;
    while (taken.includes(candidate) && guard++ < 50) {
        candidate = `${prefix}.${base}.${pick(USER, 3)}`;
    }
    return candidate;
}

const now = () => Date.now();

/* Sortable, collision-resistant key prefix for the time-ordered partitions. */
const sortKey = (ts) => `${String(ts).padStart(15, '0')}#${crypto.randomBytes(4).toString('hex')}`;

module.exports = { generatePassword, generateUsername, id, now, sortKey, pick };
