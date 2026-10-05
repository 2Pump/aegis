import { BRAND } from '@aegis/glyphs';

/** OpenAPI 3.1 description of /api/v1 (served at /api/v1/openapi.json). Kept next to the routes it describes. */
const range = [
  { name: 'from', in: 'query', schema: { type: 'string' }, description: 'ISO date or unix time; default depends on the endpoint' },
  { name: 'to', in: 'query', schema: { type: 'string' }, description: 'ISO date or unix time; default now. A range spans at most 90 days.' },
];
const pageP = [
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
  { name: 'cursor', in: 'query', schema: { type: 'string' }, description: 'the page.nextCursor of the previous response' },
];
const addr = { name: 'address', in: 'path', required: true, schema: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } };
const scen = [
  { name: 'dir', in: 'query', schema: { type: 'string', default: 'CRYPTO' }, description: 'a Pressure direction id (CRYPTO, ETH, BTC, USD, …)' },
  { name: 'sign', in: 'query', schema: { type: 'string', enum: ['down', 'up'], default: 'down' } },
  { name: 'pct', in: 'query', schema: { type: 'integer', minimum: 0, maximum: 50, default: 10 } },
];
const ok = (desc: string, data: unknown = { type: 'object' }, paged = false) => ({
  '200': {
    description: desc,
    headers: { 'RateLimit-Limit': { schema: { type: 'integer' } }, 'RateLimit-Remaining': { schema: { type: 'integer' } } },
    content: { 'application/json': { schema: { allOf: [{ $ref: '#/components/schemas/Envelope' }, { properties: { data, ...(paged ? { page: { $ref: '#/components/schemas/Page' } } : {}) } }] } } },
  },
  '400': { $ref: '#/components/responses/Error' },
  '404': { $ref: '#/components/responses/Error' },
  '429': { $ref: '#/components/responses/Error' },
  '503': { $ref: '#/components/responses/Error' },
});
const get = (summary: string, description: string, params: unknown[], responses: unknown, tag: string) => ({ get: { summary, description, parameters: params, responses, tags: [tag] } });

export function openapi() {
  return {
    openapi: '3.1.0',
    info: {
      title: `${BRAND.display} Public Risk API`,
      version: 'api-1.0.0',
      summary: 'Read-only risk intelligence for Tydro and Nado on Ink (chain 57073).',
      description: [
        BRAND.disclaimer,
        '',
        'Every response is an envelope: `schema`, `data`, optional `page`, and `meta` (rules / engine / data versions, source, source block and hash where known, generated time, age, freshness, completeness, approximation, coverage, privacy notes, disclaimer).',
        '',
        '**Freshness:** each source has its own STALE threshold (stated in `meta.freshnessRule`). **Coverage:** shares of each protocol’s on-chain totals that Phrourax’s known wallets add up to, from the last full sweep.',
        '',
        '**Privacy:** no endpoint lists wallets or ranks them by closeness to liquidation; no balances, health factors or liquidation prices; aggregate counts of 1–4 are returned as null.',
        '',
        '**Rate limits** (per client IP, per minute): aggregates 120, single-wallet 30, live wallet scenario 6, webhook management 20. Responses carry `RateLimit-*` headers; 429 carries `Retry-After`. Aggregates are also cached at the edge for 60 s.',
        '',
        '**Versioning:** the path carries the major version (`/api/v1`). Fields are only added within v1; removing or renaming a field means /api/v2, and v1 then keeps working for at least 90 days after a deprecation notice in `meta` and on this page.',
        '',
        '**Terms:** free, best effort, no uptime promise; not financial advice; data can be late, incomplete or wrong. Usage tiers may be introduced later.',
      ].join('\n'),
    },
    servers: [{ url: '/api/v1' }],
    tags: [{ name: 'network' }, { name: 'wallets' }, { name: 'oracles' }, { name: 'history' }, { name: 'models' }, { name: 'webhooks' }],
    paths: {
      '/status': get('Network status', 'Census block, time, sweep kind, counts, discovery progress.', [], ok('status'), 'network'),
      '/coverage': get('Coverage', 'Known wallets vs each protocol’s on-chain totals (last full sweep).', [], ok('coverage'), 'network'),
      '/stress': get('Current Ink Stress Level', 'CALM / ELEVATED / HIGH / CRITICAL with its inputs (shares).', [], ok('stress'), 'network'),
      '/stress/history': get('Ink Stress Level over time', 'Measured on full scans.', [...range, ...pageP], ok('history', { type: 'array' }, true), 'history'),
      '/pressure': get('Aggregate Pressure scenario', 'Wallet counts under a hypothetical move. Counts of 1–4 are null.', [...scen, { name: 'material', in: 'query', schema: { type: 'string', enum: ['0', '1k', '10k', '100k'], default: '1k' } }, { name: 'dim', in: 'query', schema: { type: 'string', default: '*' }, description: '*, v:tydro, v:nado, v:both or t:<TYPE>' }], ok('scenario counts'), 'models'),
      '/wallets/{address}': get('Wallet classification and risk', 'As classified by the last census run. No balances.', [addr], ok('wallet'), 'wallets'),
      '/wallets/{address}/history': get('Wallet history', 'Recorded changes of risk, type and size range.', [addr, ...range, ...pageP], ok('timeline', { type: 'array' }, true), 'wallets'),
      '/wallets/{address}/scenario': get('Wallet scenario result (live)', 'The level the wallet would reach under the move — read live, strictly rate-limited, never the liquidation price.', [addr, ...scen], ok('scenario'), 'wallets'),
      '/oracles': get('Oracle status', 'Oracle Watch: every asset, its sources and checks.', [], ok('oracle watch'), 'oracles'),
      '/oracles/events': get('Oracle events (divergence, depeg, stale, jump, resolved)', '', pageP, ok('events', { type: 'array' }, true), 'oracles'),
      '/changes': get('Protocol parameter changes', 'old → new between two blocks.', [...range, ...pageP], ok('changes', { type: 'array' }, true), 'history'),
      '/liquidations': get('Historical liquidations', 'Time-ordered, newest first. Size as a range.', [...range, ...pageP], ok('liquidations', { type: 'array' }, true), 'history'),
      '/cascades': get('Cascade events', 'cascade-1.0.0 grouping by timing.', [...range, ...pageP], ok('cascades', { type: 'array' }, true), 'history'),
      '/performance': get('Model performance', 'Warnings vs real liquidations; Pressure forecasts vs recorded prices.', [], ok('performance'), 'models'),
      '/carry': get('Carry analytics', 'Estimated, observed — analysis only.', [], ok('carry'), 'models'),
      '/verification': get('Verification status', 'Automatic checks against the official sources.', [], ok('checks', { type: 'array' }), 'network'),
      '/events': get('Ink-wide event feed', 'oracle.*, protocol.parameter_changed, stress.level_changed, cascade.detected, verification.failed — at most 30 days per request.', [...range, ...pageP, { name: 'type', in: 'query', schema: { type: 'string' } }], ok('events', { type: 'array' }, true), 'history'),
      '/webhooks': {
        post: { summary: 'Create a webhook (when enabled)', tags: ['webhooks'], description: 'Returns 503 NOT_ENABLED until webhooks are switched on. See docs/WEBHOOKS.md for signing, retries and verification.', responses: { '201': { description: 'created; the secret and management token are shown once' }, '503': { $ref: '#/components/responses/Error' } } },
      },
      '/openapi.json': get('This document', '', [], { '200': { description: 'OpenAPI 3.1' } }, 'network'),
    },
    components: {
      schemas: {
        Envelope: {
          type: 'object',
          required: ['schema', 'data', 'meta'],
          properties: { schema: { const: 'aegis-api-1' }, data: {}, meta: { $ref: '#/components/schemas/Meta' } },
        },
        Meta: {
          type: 'object',
          properties: {
            schema: { type: 'string' },
            apiVersion: { type: 'string' },
            rulesVersion: { type: 'string' },
            engineVersion: { type: 'string' },
            dataVersion: { type: ['string', 'null'] },
            source: { type: 'string' },
            sourceBlock: { type: ['integer', 'null'] },
            sourceBlockHash: { type: ['string', 'null'] },
            generatedAt: { type: ['string', 'null'] },
            servedAt: { type: 'string' },
            ageSeconds: { type: ['integer', 'null'] },
            freshness: { enum: ['FRESH', 'STALE', 'UNKNOWN'] },
            freshnessRule: { type: 'string' },
            completeness: { enum: ['COMPLETE', 'PARTIAL', 'UNAVAILABLE', 'NOT_APPLICABLE'] },
            completenessNotes: { type: 'array', items: { type: 'string' } },
            approximate: { type: 'boolean' },
            coverage: { type: ['object', 'null'] },
            privacy: { type: 'array', items: { type: 'string' } },
            disclaimer: { type: 'string' },
          },
        },
        Page: { type: 'object', properties: { total: { type: 'integer' }, limit: { type: 'integer' }, returned: { type: 'integer' }, nextCursor: { type: ['string', 'null'] } } },
        Error: {
          type: 'object',
          properties: {
            schema: { const: 'aegis-api-1' },
            error: {
              type: 'object',
              properties: {
                code: { enum: ['BAD_REQUEST', 'INVALID_ADDRESS', 'INVALID_RANGE', 'INVALID_PARAMETER', 'FIXTURE_REJECTED', 'UNAUTHORIZED', 'NOT_FOUND', 'WALLET_NOT_IN_CENSUS', 'METHOD_NOT_ALLOWED', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'UPSTREAM_UNAVAILABLE', 'NOT_ENABLED', 'NOT_RECORDED_YET'] },
                status: { type: 'integer' },
                message: { type: 'string' },
                details: { type: 'object' },
              },
            },
            disclaimer: { type: 'string' },
          },
        },
      },
      responses: { Error: { description: 'an error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
    },
  };
}
