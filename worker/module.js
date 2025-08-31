export const handlers = {};

export const CORS_ORIGIN = '*';

export const CORS_HEADERS = {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Accept,Content-Type,Authorization',
    'Access-Control-Max-Age': '3600'
};

export function optionsResponse() {
    return new Response(null, { headers: CORS_HEADERS });
}

export function registerHandler({ name, func }) {
    if (typeof name !== 'string' || !name.match(/^[a-zA-Z0-9_-]+$/)) {
        throw new Error('Handler name must be a non-empty string containing only letters, numbers, underscores, or hyphens.');
    }
    if (typeof func !== 'function') {
        throw new Error('Handler func must be a function.');
    }
    if (handlers[name]) {
        throw new Error(`Handler with name '${name}' is already registered.`);
    }
    handlers[name] = func;
}

/* Example usage:
create a handler.js file:

import { registerHandler, CORS_ORIGIN, CORS_HEADERS, optionsResponse, handlers } from "module.js";
registerHandler({ name: 'myHandler', func: async (request) => {
    return new Response(JSON.stringify({ message: 'Hello from myHandler!' }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
}});
export { CORS_ORIGIN, CORS_HEADERS, optionsResponse, handlers };

Then import that file in worker.js to register the handler:
import {CORS_HEADERS, optionsResponse, handlers} from "handlers.js";

Then you can access your handler at /myHandler
*/