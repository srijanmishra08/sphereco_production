'use strict';

/* Thin helpers shared by every route. The Lambda speaks API Gateway HTTP API
   v2 payloads; the local dev server speaks node:http. Both are normalised into
   the same { method, path, params, query, headers, body } shape before a route
   ever sees them, so routes never learn which one they are running under. */

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code || null;
    }
}

const bad      = (m, code) => new HttpError(400, m, code);
const unauth   = (m) => new HttpError(401, m || 'Sign in to continue.');
const forbid   = (m) => new HttpError(403, m || 'You do not have access to that.');
const notFound = (m) => new HttpError(404, m || 'Not found.');
const conflict = (m) => new HttpError(409, m);

function json(status, body, extraHeaders) {
    return {
        statusCode: status,
        headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders || {}),
        body: JSON.stringify(body == null ? {} : body)
    };
}

/* CORS: the site is served from a different origin than the API, so every
   response needs these. Origins come from config, never "*", because requests
   carry an Authorization header. */
function corsHeaders(origin, allowed) {
    const ok = allowed.includes('*') || allowed.includes(origin);
    if (!ok || !origin) return {};
    return {
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'authorization,content-type',
        'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'access-control-max-age': '86400',
        'vary': 'origin'
    };
}

function parseBody(raw, isBase64) {
    if (!raw) return {};
    const text = isBase64 ? Buffer.from(raw, 'base64').toString('utf8') : raw;
    try {
        return JSON.parse(text);
    } catch (e) {
        throw bad('The request body is not valid JSON.');
    }
}

/* Route table matching, with :params. Kept deliberately small — there are a
   couple of dozen routes and no need for a router dependency. */
function match(pattern, path) {
    const p = pattern.split('/').filter(Boolean);
    const a = path.split('/').filter(Boolean);
    if (p.length !== a.length) return null;
    const params = {};
    for (let i = 0; i < p.length; i++) {
        if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(a[i]);
        else if (p[i] !== a[i]) return null;
    }
    return params;
}

function str(v, field, { max = 500, required = false } = {}) {
    const s = (v == null ? '' : String(v)).trim();
    if (required && !s) throw bad(`${field} is required.`);
    if (s.length > max) throw bad(`${field} is too long (max ${max} characters).`);
    return s;
}

function email(v, field = 'Email') {
    const s = str(v, field, { max: 254, required: true });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad(`${field} is not a valid email address.`);
    return s.toLowerCase();
}

module.exports = { HttpError, bad, unauth, forbid, notFound, conflict, json, corsHeaders, parseBody, match, str, email };
