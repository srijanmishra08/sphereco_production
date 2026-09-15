'use strict';

/* Lambda entry point behind an API Gateway HTTP API (payload format 2.0). */

const { handle } = require('./router');
const { parseBody } = require('./lib/http');

let ports = null;

function getPorts() {
    if (!ports) ports = require('./ports/aws').create();   /* lazily, for cold-start cost */
    return ports;
}

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*')
    .split(',').map((s) => s.trim()).filter(Boolean);

exports.handler = async (event) => {
    const http = (event.requestContext && event.requestContext.http) || {};
    const headers = {};
    for (const [k, v] of Object.entries(event.headers || {})) headers[k.toLowerCase()] = v;

    const req = {
        method: http.method || 'GET',
        path: (event.rawPath || '/').replace(/\/+$/, '') || '/',
        query: event.queryStringParameters || {},
        headers,
        body: {}
    };

    try {
        if (req.method !== 'GET' && req.method !== 'OPTIONS') {
            req.body = parseBody(event.body, event.isBase64Encoded);
        }
    } catch (err) {
        return { statusCode: 400, headers: { 'content-type': 'application/json' },
                 body: JSON.stringify({ error: err.message }) };
    }

    return handle(req, getPorts(), { allowedOrigins });
};
