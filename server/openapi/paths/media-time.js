/**
 * Modul: OpenAPI-Pfade Medienzeit (Bildschirmzeit-Kontingente)
 * Zweck: /api/v1/media-time in der Spec. Der Tracker (Gerate-Token) meldet,
 *        die Verwaltung (Eltern/Admin) setzt Kontingente, Ausnahmen, Ruhezeit.
 * Muster: server/openapi/paths/rewards.js (withCaseReasons + mediaTimeProperties).
 */

import { op, jsonBody, idParam, withCaseReasons } from '../helpers.js';

export function mediaTimePaths() {
  return withCaseReasons('media-time', CASE_REASONS, {
    '/api/v1/media-time/tracker/sync': {
      post: op({
        summary: 'Tracker sync: accept usage sessions (device token)',
        tag: 'MediaTime',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeTrackerSyncInput'),
        description: 'The tracker posts its replayed usage segments with the household device token (`Authorization: Bearer <media_time token>`, issued by POST /media-time/devices). The session is identified by `session_key` (idempotent: a repeat updates the row, the higher `used_minutes` wins), `minute_key` is set SERVER-side in the household time zone - the device clock never decides the day. On arrival each session is classified: an app exception match wins (exact first, then the longest prefix, then glob), a `system` segment is never charged (fail-open), and an unclassified package becomes `unknown` - it never silently eats the quota, it shows in GET /today as `unknown_min` for the parents to decide. Raw fields are never rewritten later; changing an exception recomputes the classification only. The answer carries the quota state the client may show: `ok`, `nearing` (below five minutes left), `exceeded` or `quiet` (the household quiet window) - a signal, never a lock (trustee model). `inventory_delta` updates the per-device package inventory. At most 200 sessions per call. Unknown packages are accepted (200), not refused.',
        responses: {
          200: {
            description: 'Sync accepted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeTrackerSyncResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/tracker/heartbeat': {
      post: op({
        summary: 'Tracker heartbeat: extend a running segment (device token)',
        tag: 'MediaTime',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeTrackerHeartbeatInput'),
        description: 'Idempotent over `session_key`: a known session takes the higher `used_minutes`, an unknown one is created (classified like on sync). Running segments are capped at 12 hours against a forgotten timer. Marks the device seen (the parents see "tracker offline" after 12 silent hours rather than a fake zero-minute day).',
        responses: {
          200: {
            description: 'Heartbeat recorded',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeHeartbeatResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/tracker/exceptions': {
      get: op({
        summary: 'List app exception rules (parents/admin)',
        tag: 'MediaTime',
        description: 'Active (non-revoked) rules, optionally filtered by `?user_id=`; a rule with a null `user_id` is the household default for every child. `version` feeds the client cache: it changes on every upsert and revoke. `exempt_from`: `quota` = never charged, still visible in history; `history` = out of charge AND evaluation; `charged` = the parent confirmed "charge it" (unknown packages are NOT charged by default). The Yuvomi app package is exempted in the server itself and cannot be listed or removed.',
      }),
      put: op({
        summary: 'Upsert and revoke app exception rules (parents/admin)',
        tag: 'MediaTime',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeExceptionsPutInput'),
        description: 'Body: { upsert?: [ { user_id|null, match_type, pattern, exempt_from?, note? } ], revoke?: [id, ...] }. An upsert hits the unique (user_id, match_type, pattern) and revives a revoked rule. Revoking sets `revoked_at`, nothing is deleted. Every touched child gets the classification of its sessions recomputed - the raw rows never change.',
        responses: {
          200: {
            description: 'Version after the change',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeExceptionsVersionResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device, quota) does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/today': {
      get: op({
        summary: 'Today for one child (or oneself): charged / exempt / unknown minutes',
        tag: 'MediaTime',
        params: [{ name: 'user_id', in: 'query', required: false, schema: { type: 'integer' }, description: 'A child; parents/admin only. Omitted: the caller themselves.' }],
        description: 'The day in the household time zone. `charged_min` reduces the quota, `exempt_min` (app exceptions and bought time credit the quota instead) and `system_min` never do, and `unknown_min` is usage of unclassified packages shown for the parents to decide (fail-open: never charged). `quota_min` is `daily_minutes` plus bought minutes, capped by `max_daily_minutes` when `hard_cap` is on. The household quiet window (`quiet`, `quiet_active`) is a signal visible to every member, not a lock. `tracker.online` says whether a device of this child reported within 12 hours.',
        responses: {
          200: {
            description: 'Today',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeTodayResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device, quota) does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/quotas': {
      get: op({
        summary: 'Daily quotas of the household children (parents/admin)',
        tag: 'MediaTime',
        params: [{ name: 'user_id', in: 'query', required: false, schema: { type: 'integer' }, description: 'One child instead of the full list.' }],
        responses: {
          200: {
            description: 'Quotas',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeQuotaListResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device, quota) does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/quotas/{userId}': {
      put: op({
        summary: 'Set the daily quota of a child (parents/admin)',
        tag: 'MediaTime',
        params: [idParam('userId', 'Child user id')],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeQuotaInput'),
        description: 'Body: { daily_minutes: 0..1440, max_daily_minutes?: 0..1440|null, enabled? }. The point exchange rate is NOT here: it is one rate for the whole household (PUT /media-time/settings).',
        responses: {
          200: {
            description: 'Stored quota',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeQuotaResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device, quota) does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/quiet-hours': {
      get: op({
        summary: 'Household quiet window (visible to every member)',
        tag: 'MediaTime',
        description: 'The quiet window is GLOBAL for the household (not per child) and shown to everyone: dashboard and child view render "quiet time active - X min left" as a signal, not as a rule that locks anything.',
        responses: {
          200: {
            description: 'Quiet window',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeQuietHoursResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      put: op({
        summary: 'Set the household quiet window (parents/admin)',
        tag: 'MediaTime',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeQuietHoursInput'),
        description: 'Body: { range: "HH:MM-HH:MM" | null }. A window crossing midnight (21:00-06:00) applies over the day boundary. Null turns it off (default off).',
        responses: {
          200: {
            description: 'Stored window',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeQuietHoursResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/settings': {
      get: op({
        summary: 'Media time household settings (exchange rate, cap mode, retention)',
        tag: 'MediaTime',
        responses: {
          200: {
            description: 'Settings',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeSettingsResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      put: op({
        summary: 'Update the exchange rate and the cap mode (parents/admin)',
        tag: 'MediaTime',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeSettingsInput'),
        description: 'The point->minutes exchange is ONE rate for the whole household (e.g. 10 points = 15 minutes), never per child: { exchange: "10:15" | {points, minutes} | null } (null/empty = exchange off). `hard_cap` (boolean, default true) decides whether `max_daily_minutes` is a hard ceiling or can be bought up to. The master switch `media_time_enabled` is a household preference and goes through PUT /preferences.',
        responses: {
          200: {
            description: 'Stored settings',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeSettingsResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/purchase': {
      post: op({
        summary: 'Exchange points for minutes (child for themselves, parent for a child)',
        tag: 'MediaTime',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimePurchaseInput'),
        description: 'Body: { user_id?, quantity? } (quantity 1..100, default 1). Points leave the point ledger (an `adjust` entry with reason `media_time:<purchase_id>` - the same currency, no second point system) and a `credit` session adds the minutes to the child\'s quota FOR THE DAY. With the household exchange off this is 400 `media_time_exchange_off`; with a hard cap and the exchange above it, 400 `media_time_cap_reached`; a balance below the price is 400 `media_time_insufficient_points`.',
        responses: {
          201: {
            description: 'Exchanged',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimePurchaseResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device, quota) does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/purchases': {
      get: op({
        summary: 'Exchange history of a child (own for the child, any for parents/admin)',
        tag: 'MediaTime',
        params: [{ name: 'user_id', in: 'query', required: false, schema: { type: 'integer' } }],
        responses: {
          200: {
            description: 'Purchases',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimePurchasesResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/devices': {
      get: op({
        summary: 'List tracker devices (parents/admin)',
        tag: 'MediaTime',
        params: [{ name: 'user_id', in: 'query', required: false, schema: { type: 'integer' } }],
        responses: {
          200: {
            description: 'Devices',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeDeviceListResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Create a tracker device, returns the token once (parents/admin)',
        tag: 'MediaTime',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeDeviceCreateInput'),
        description: 'Body: { user_id, name, platform? }. The token clear-text appears exactly once in this answer; the database holds only its sha256 hash. The token authenticates POST /tracker/sync and /tracker/heartbeat as this child.',
        responses: {
          201: {
            description: 'Device created',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeDeviceCreateResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device, quota) does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/devices/{id}/revoke': {
      post: op({
        summary: 'Revoke a tracker device (parents/admin)',
        tag: 'MediaTime',
        params: [idParam()],
        stateChanging: true,
        description: 'Sets `revoked_at`, nothing is deleted - the sessions keep their device. A revoked token answers 401 on the tracker paths.',
        responses: {
          200: { description: 'Device revoked' },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device, quota) does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/devices/{id}/inventory': {
      get: op({
        summary: 'Package inventory of a device (parents/admin)',
        tag: 'MediaTime',
        params: [idParam()],
        description: 'What the device reported installed (package, version, system flag, first/last seen) - the base for "newly installed?" in the parent UI.',
        responses: {
          200: {
            description: 'Inventory',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeInventoryResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device, quota) does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  });
}

const REASON_BAD = '`media_time_bad_request` (400, a field is missing or out of range)';
const CASE_REASONS = {
  '/api/v1/media-time/tracker/sync': {
    post: REASON_BAD + ' (400, a session payload is missing or out of range), '
      + '`media_time_device_required` (401, the bearer token is missing, unknown or revoked), '
      + '`media_time_disabled` (403, the household has media time switched off)',
  },
  '/api/v1/media-time/tracker/heartbeat': {
    post: REASON_BAD + ', `media_time_device_required` (401), `media_time_disabled` (403, household switch off)',
  },
  '/api/v1/media-time/tracker/exceptions': {
    put: REASON_BAD + ' (400, an unknown match_type, an empty or too long pattern, or a '
      + '`user_id` that is not a child), `media_time_forbidden` (403, not a parent or administrator)',
  },
  '/api/v1/media-time/today': {
    get: REASON_BAD + ' (400, `user_id` is missing or not a number), `media_time_unauthenticated` (401, no session), '
      + '`media_time_forbidden` (403, reading another child without being a parent)',
  },
  '/api/v1/media-time/quotas/{userId}': {
    put: REASON_BAD + ', `media_time_forbidden` (403), `media_time_not_a_child` (403, the target is not a child)',
  },
  '/api/v1/media-time/quiet-hours': {
    put: '`media_time_bad_request` (400, the range is not "HH:MM-HH:MM"), `media_time_forbidden` (403)',
  },
  '/api/v1/media-time/settings': {
    put: REASON_BAD + ', `media_time_forbidden` (403)',
  },
  '/api/v1/media-time/purchase': {
    post: REASON_BAD + ', `media_time_unauthenticated` (401, no session), '
      + '`media_time_disabled` (403, household switch off), '
      + '`media_time_no_quota` (400, the child has no quota), '
      + '`media_time_exchange_off` (400, the household exchange rate is unset), '
      + '`media_time_cap_reached` (400, the daily cap - hard or used up - blocks the exchange), '
      + '`media_time_insufficient_points` (400, the balance does not cover the price), '
      + '`media_time_forbidden` (403), `media_time_not_a_child` (403)',
  },
  '/api/v1/media-time/purchases': {
    get: REASON_BAD + ', `media_time_unauthenticated` (401, no session), `media_time_forbidden` (403)',
  },
  '/api/v1/media-time/devices': {
    post: '`media_time_bad_request`, `media_time_forbidden` (403), `media_time_not_a_child` (403)',
  },
  '/api/v1/media-time/devices/{id}/revoke': {
    post: REASON_BAD + ', `media_time_forbidden` (403)',
  },
  '/api/v1/media-time/devices/{id}/inventory': {
    get: REASON_BAD + ', `media_time_forbidden` (403)',
  },
};
