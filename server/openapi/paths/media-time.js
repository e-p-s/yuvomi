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
        description: 'The day in the household time zone. `charged_min` reduces the quota, `exempt_min` (app exceptions and bought time credit the quota instead) and `system_min` never do, and `unknown_min` is usage of unclassified packages shown for the parents to decide (fail-open: never charged). `quota_min` is `daily_minutes` plus bought minutes plus the parents\' note adjustments of the day (`adjusted_min`, see PUT /media-time/quotas/{userId}/day), capped by `max_daily_minutes` when `hard_cap` is on. `reason` carries the reason of the newest note of the day (null when none) - the child sees every quota change with its explained reason. The household quiet window (`quiet`, `quiet_active`) is a signal visible to every member, not a lock. `tracker.online` says whether a device of this child reported within 12 hours. `devices` breaks the counted minutes down per device (same basis: a family link day value replaces the device sessions; usage without a device is the row with `device_id` null).',
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
        params: [{ name: 'user_id', in: 'query', required: false, schema: { type: 'integer' }, description: 'One child instead of the full list: the child-wide row plus its per-device rows (with device_name).' }],
        description: 'With `user_id` the answer is the child-wide base row (`device_id` null) plus one row per device quota (`device_id`/`device_name` set) - a device row overrides the base for exactly that device. The full list keeps the per-child rows with their display names.',
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
        description: 'Body: { daily_minutes: 0..1440, max_daily_minutes?: 0..1440|null, enabled?, device_id?: int|null }. Without `device_id` this is the child-wide base row (unique per child); with it, a per-device row that overrides the base for exactly that device (unique per child and device). The answer carries the stored row with its `device_name`. The point exchange rate is NOT here: it is one rate for the whole household (PUT /media-time/settings).',
        responses: {
          200: {
            description: 'Stored quota',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeQuotaResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device, quota) does not exist in this household (a `device_id` that is unknown, revoked, or belongs to another child).' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/quotas/{userId}/day': {
      put: op({
        summary: 'Adjust a child\'s quota for TODAY, with a mandatory reason (parents/admin)',
        tag: 'MediaTime',
        params: [idParam('userId', 'Child user id')],
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeQuotaDayAdjustInput'),
        description: 'Body: { delta_minutes: non-zero integer -1440..1440, reason: 3..300 chars }. Raises or lowers the quota of the CURRENT household day (the same `mediaTimeDayKey` day GET /today counts) - the base `daily_minutes` row is never rewritten (adjust philosophy: correct, never erase). The note is a protocol entry, not a state: several notes on one day sum into `adjusted_min`, and the child sees the newest `reason` in GET /today (transparency: no quota change without an explained reason). The answer carries the day, the delta, and the resulting `quota_min`/`adjusted_min`/`remaining_min`. A positive note is still bounded by `max_daily_minutes` when the household cap is hard.',
        responses: {
          200: {
            description: 'Adjustment stored, quota after it',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeQuotaDayAdjustResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device, quota) does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/quotas/{userId}/day-notes': {
      get: op({
        summary: 'Quota adjustment notes of a child (last 30, newest first)',
        tag: 'MediaTime',
        params: [idParam('userId', 'Child user id')],
        description: 'The transparency counterpart of PUT /media-time/quotas/{userId}/day: parents/admin read any child, a child reads all their own notes (the last 30, newest first) - every adjustment stays visible with its reason.',
        responses: {
          200: {
            description: 'Notes',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeQuotaDayNotesResponse' } } },
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
    '/api/v1/media-time/sessions': {
      get: op({
        summary: 'Charged usage sessions of a household day (own for the child, any child for parents/admin)',
        tag: 'MediaTime',
        params: [
          { name: 'day', in: 'query', required: false, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, description: 'Household day (YYYY-MM-DD). Omitted: today.' },
          { name: 'user_id', in: 'query', required: false, schema: { type: 'integer' }, description: 'A child; parents/admin only. Omitted: parents/admin get every child of the household day, a child gets themselves.' },
        ],
        description: 'Only rows with `classification` charged, newest start first - the base for the parents\' correction list. `editable` is true only for manual bookings (`source` manual); the raw rows a device reported are never rewritten (adjust philosophy: correct, never erase).',
        responses: {
          200: {
            description: 'Sessions of the day',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeSessionListResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target child does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Book usage minutes manually for a child (parents/admin; devices without an agent)',
        tag: 'MediaTime',
        stateChanging: true,
        description: 'Body: { user_id, minutes (1..720) | start_at + end_at, note?, device_id? }. The minutes count as charged usage - for consoles, TVs and corrections. With the explicit pair `start_at`/`end_at` (ISO instants with offset, same household day - a booking may not cross midnight) the difference is the length, both instants are stored as given, and `minute_key` follows them (a correction for another day); the pair takes precedence over `minutes`.',
        requestBody: jsonBody('#/components/schemas/MediaTimeManualSessionInput'),
        responses: {
          200: {
            description: 'Booked',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeManualSessionResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target child or the device does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/sessions/{id}': {
      patch: op({
        summary: 'Correct a manual booking: minutes move started_at, note relabels, device re-books (parents/admin)',
        tag: 'MediaTime',
        stateChanging: true,
        params: [idParam()],
        requestBody: jsonBody('#/components/schemas/MediaTimeSessionUpdateInput'),
        description: 'Only rows with `source` manual can be corrected - a raw device session answers 404 (its raw values are never rewritten). `minutes` keeps `ended_at` as the anchor and moves `started_at` to ended_at minus minutes; `note` becomes the `app_label`; `device_id` must belong to the child and be unrevoked (null books without a device). The answer is the row in the GET /sessions shape.',
        responses: {
          200: {
            description: 'Corrected row',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeSessionResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'No manual session with this id (unknown id, or the row is device-raw data).' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      delete: op({
        summary: 'Strike a manual booking out (parents/admin)',
        tag: 'MediaTime',
        stateChanging: true,
        params: [idParam()],
        description: 'Hard delete: a manual booking is not a raw device time and not an audit entry - what the parents booked wrong disappears instead of lingering as a corrected row. Only rows with `source` manual; anything else answers 404.',
        responses: {
          200: {
            description: 'Deleted',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeSessionDeleteResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'No manual session with this id (unknown id, or the row is device-raw data).' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
  
  '/api/v1/media-time/checkins': {
      get: op({
        summary: 'Check-ins of a child (open first; own for the child, any for parents/admin)',
        tag: 'MediaTime',
        params: [{ name: 'user_id', in: 'query', required: true, schema: { type: 'integer' } }],
        responses: {
          200: {
            description: 'Check-ins',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeCheckinsResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      post: op({
        summary: 'Check a child in on a device (open session counts against the quota until check-out or midnight)',
        tag: 'MediaTime',
        stateChanging: true,
        description: 'Body: { user_id, device_id }. One open check-in per child and device; a second attempt answers 409. The open minutes fold into the day quota (server-side).',
        requestBody: jsonBody('#/components/schemas/MediaTimeCheckinInput'),
        responses: {
          201: {
            description: 'Checked in',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeCheckinResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The device does not exist for this child (or is revoked).' },
          409: { description: 'Already checked in on this device.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/checkins/{id}/end': {
      post: op({
        summary: 'End an open check-in (check out)',
        tag: 'MediaTime',
        stateChanging: true,
        params: [idParam()],
        responses: {
          200: {
            description: 'Checked out',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeCheckinResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'No open check-in with this id.' },
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
    '/api/v1/media-time/familylink/usage': {
      get: op({
        summary: 'Real screen time collected from Google Family Link (read only, never enforced back)',
        tag: 'MediaTime',
        params: [
          { name: 'user_id', in: 'query', required: false, schema: { type: 'integer' }, description: 'A child; parents/admin only. Omitted: the caller themselves.' },
          { name: 'day', in: 'query', required: false, schema: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, description: 'Day of the aggregate (YYYY-MM-DD). Omitted: today.' },
        ],
        description: 'Google-Family-Link-Istzeit fuer einen Tag. mapped=false ohne Zuordnung; status login_noetig, wenn der Collector\n'
          + 'keine Sitzung hat - dann gibt es KEINE Null-Snapshots, sondern den Hinweis. Die verbrauchten Minuten\n'
          + 'zaehlen gegen das Tageskontingent des Kindes (Ersatz, nicht Zusatz, pro Geraet).',
        responses: {
          200: {
            description: 'Family link usage for the day',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeFamilylinkUsageResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/familylink/mapping': {
      get: op({
        summary: 'Family link mapping of a child (google_uid + device mapping, parents/admin or the child)',
        tag: 'MediaTime',
        params: [{ name: 'user_id', in: 'query', required: false, schema: { type: 'integer' }, description: 'A child; parents/admin only. Omitted: the caller themselves.' }],
        responses: {
          200: {
            description: 'Mapping state',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeFamilylinkMappingResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
      put: op({
        summary: 'Map a child to a Google account and its devices to media-time devices (parents/admin)',
        tag: 'MediaTime',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeFamilylinkMappingInput'),
        description: 'display_name is stored as the YUVOMI name of the child, never the Google name. google_uid null or empty\n'
          + 'removes the mapping (collected history stays, it is not silently deleted).',
        responses: {
          200: {
            description: 'Saved',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeFamilylinkMappingSaveData' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          404: { description: 'The target (child, device) does not exist in this household.' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/familylink/report': {
      post: op({
        summary: 'Push a family link report or a bare status from the collector host (x-familylink-token, same ingest as the local run)',
        tag: 'MediaTime',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeFamilylinkReportInput'),
        description: 'Der Collector-Host (einziger Rechner mit Google-Sitzung) schickt seinen --json-Report hierher.\n'
          + 'Falscher Token 401, kaputter Koerper 400 - geschrieben wird nie etwas Halbes und nie eine Null (Spec-Regel).\n'
          + 'Nimmt zusaetzlich einen reinen Status-Report an ({ "status": "login_noetig" } oder { "status": "ok" } ohne\n'
          + 'children): der Collector meldet so seine abgelaufene Sitzung, bevor der Python-Teil scheitert - derselbe\n'
          + 'setStatus-Pfad wie der lokale Takt, Antwort 200 { data: { status } }; ein unbekannter Status-Wert ist 400.',
        responses: {
          200: {
            description: 'Accepted (written = rows stored, errors = skipped rows)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeFamilylinkReportResponse' } } },
          },
          400: { $ref: '#/components/responses/BadRequest' },
          401: { $ref: '#/components/responses/Unauthorized' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/familylink/token': {
      post: op({
        summary: 'Create (rotate) the family link report token - plaintext shown exactly once (parents/admin)',
        tag: 'MediaTime',
        stateChanging: true,
        responses: {
          200: {
            description: 'New token (store in the collector cron file with 0600, never in the repo)',
            content: { 'application/json': { schema: { type: 'object', required: ['data'], properties: { data: { $ref: '#/components/schemas/MediaTimeFamilylinkTokenData' } } } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/familylink/ingest': {
      post: op({
        summary: 'Run one family link collector cycle now (parents/admin, same as the five-minute job)',
        tag: 'MediaTime',
        stateChanging: true,
        description: 'Ohne Collector-Sitzung setzt der Lauf nur den Status login_noetig - nie 0er-Snapshots.',
        responses: {
          200: {
            description: 'Run outcome (ok=false is a normal result: status login_noetig)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeFamilylinkIngestResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          500: { $ref: '#/components/responses/InternalServerError' },
        },
      }),
    },
    '/api/v1/media-time/familylink/login': {
      post: op({
        summary: 'Automated family link login on the collector (parents/admin): fill email/password, then code',
        tag: 'MediaTime',
        stateChanging: true,
        requestBody: jsonBody('#/components/schemas/MediaTimeFamilylinkLoginInput'),
        description: 'Der Parent tippt E-Mail+Passwort nur in die App - der Sammler fuellt den Google-Login selbst aus\n'
          + '(CDP-Auto-Ausfuellen in scripts/familylink/familylink_login_proxy.py). Zwei Formen, eine Route:\n'
          + '{ email, password } startet einen Versuch, { code } loest eine offene pending-Sitzung (OTP-Seite) auf.\n'
          + 'Antworten: state ok (Cookies frisch, familylink_status ok, die Adresse bleibt als familylink_email\n'
          + 'vorgemerkt - das Passwort wird NIE gespeichert und erscheint in keiner Antwort), otp_needed (die App\n'
          + 'fragt den Code ab, die pending bleibt 10 Minuten offen), bad_code (erneut mit code erlaubt),\n'
          + 'challenge (fuer den Menschen: data traegt viewer_url + expires_at der bestehenden Viewer-Sitzung,\n'
          + 'derselbe Target - die App wechselt nahtlos ins Fenster). Kein Fenster im Normalfall.',
        responses: {
          200: {
            description: 'Outcome of the attempt (state ok / otp_needed / bad_code / challenge; viewer_url and expires_at only with challenge)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeFamilylinkLoginResponse' } } },
          },
          400: { description: 'Neither email+password nor code in the body, or a field is out of range' },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          422: { description: 'bad_credentials: Google rejected the password (the pending attempt is closed) / login_expired: no pending login session - start a new attempt with email and password' },
          429: { description: 'More than 10 login attempts in 10 minutes for this account' },
          500: { $ref: '#/components/responses/InternalServerError' },
          502: { description: 'The collector did not answer or reported a broken flow' },
          503: { description: 'FAMILYLINK_COLLECTOR_BASE or FAMILYLINK_LOGIN_SECRET is unset' },
        },
      }),
    },
    '/api/v1/media-time/familylink/login-session': {
      post: op({
        summary: 'Start a remote family link login session on the collector (parents/admin) - returns the one-shot viewer URL',
        tag: 'MediaTime',
        stateChanging: true,
        description: 'Fernlogin fuer den Sammler-Host (einziger Rechner mit Chromium-Profil): die Eltern-UI oeffnet die\n'
          + 'zurueckgegebene Viewer-Seite des Collectors (scripts/familylink/familylink_login_proxy.py), tippt dort die\n'
          + 'Anmeldung, und der Collector faengt die frischen Cookies selbst ab (session.json, 0600) und meldet danach\n'
          + 'status ok. Ein Doppelstart storniert die alte Sitzung am Collector (best effort) - es lebt nie eine zweite.\n'
          + 'Die Sitzung laeuft nach 10 Minuten aus (harte Collector-Grenze 15); die Viewer-URL traegt das Einmal-Token,\n'
          + 'das Login-Geheimnis selbst verlaesst den Server nie. Konfiguration ueber env (FAMILYLINK_COLLECTOR_BASE,\n'
          + 'FAMILYLINK_LOGIN_SECRET) - beides Deploy-Sache, nie hartkodiert.',
        responses: {
          200: {
            description: 'Session started (viewer_url is one-shot, valid until expires_at)',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/MediaTimeFamilylinkLoginSessionResponse' } } },
          },
          401: { $ref: '#/components/responses/Unauthorized' },
          403: { $ref: '#/components/responses/Forbidden' },
          429: { description: 'More than 10 session starts in 10 minutes for this account (`media_time_login_session_rate_limited`)' },
          500: { $ref: '#/components/responses/InternalServerError' },
          502: { description: 'The collector did not accept the session start - unreachable or non-2xx (`media_time_familylink_collector_unreachable`)' },
          503: { description: 'FAMILYLINK_COLLECTOR_BASE or FAMILYLINK_LOGIN_SECRET is unset (`media_time_familylink_not_configured`)' },
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
    put: REASON_BAD + ', `media_time_forbidden` (403), `media_time_not_a_child` (403, the target is not a child), '
      + '`media_time_not_found` (404, the `device_id` is unknown, revoked, or belongs to another child)',
  },
  '/api/v1/media-time/quotas/{userId}/day': {
    put: REASON_BAD + ' (400, `delta_minutes` is zero, not an integer, out of -1440..1440, or `reason` is missing or outside 3..300 characters), '
      + '`media_time_disabled` (403, the household has media time switched off), '
      + '`media_time_forbidden` (403), `media_time_not_a_child` (403, the target is not a child)',
  },
  '/api/v1/media-time/quotas/{userId}/day-notes': {
    get: REASON_BAD + ', `media_time_unauthenticated` (401, no session), `media_time_forbidden` (403, reading another child without being a parent)',
  },
  '/api/v1/media-time/quiet-hours': {
    put: '`media_time_bad_request` (400, the range is not "HH:MM-HH:MM"), `media_time_forbidden` (403)',
  },
  '/api/v1/media-time/settings': {
    put: REASON_BAD + ', `media_time_forbidden` (403)',
  },
  '/api/v1/media-time/familylink/usage': {
    get: REASON_BAD + ' (400, `user_id` or `day` is malformed), `media_time_unauthenticated` (401, no session), '
      + '`media_time_forbidden` (403, reading another child without being a parent)',
  },
  '/api/v1/media-time/familylink/report': {
    post: REASON_BAD + ' (400, Report-Koerper wird von der Ingest-Funktion abgelehnt), `media_time_unauthenticated` (401, x-familylink-token fehlt oder passt nicht)',
  },
  '/api/v1/media-time/familylink/login': {
    post: REASON_BAD + ' (400, weder email+password noch code im Koerper oder ein Feld ausserhalb der Grenze), '
      + '`media_time_unauthenticated` (401, keine Session), `media_time_forbidden` (403, nicht Elternteil oder Admin), '
      + '`media_time_familylink_login_rate_limited` (429, mehr als zehn Versuche in zehn Minuten je Mitglied), '
      + '`media_time_familylink_bad_credentials` (422, Google verwirft das Passwort — die pending-Sitzung ist geschlossen), '
      + '`media_time_familylink_login_expired` (422, keine offene pending-Sitzung — mit E-Mail+Passwort neu ansetzen), '
      + '`media_time_familylink_collector_unreachable` (502, der Collector antwortet nicht oder meldet kaputten Ablauf), '
      + '`media_time_familylink_not_configured` (503, FAMILYLINK_COLLECTOR_BASE oder FAMILYLINK_LOGIN_SECRET fehlt)',
  },
  '/api/v1/media-time/familylink/login-session': {
    post: '`media_time_familylink_not_configured` (503, FAMILYLINK_COLLECTOR_BASE oder FAMILYLINK_LOGIN_SECRET fehlt), '
      + '`media_time_familylink_collector_unreachable` (502, der Collector nimmt den Sitzungsstart nicht an), '
      + '`media_time_login_session_rate_limited` (429, mehr als zehn Starts in zehn Minuten je Mitglied), '
      + '`media_time_forbidden` (403, nicht Elternteil oder Admin)',
  },
  '/api/v1/media-time/familylink/mapping': {
    get: REASON_BAD + ', `media_time_unauthenticated` (401, no session), `media_time_forbidden` (403, reading another child without being a parent)',
    put: REASON_BAD + ' (400, `google_uid` is not a digit string 6-40 or a device id is malformed), '
      + '`media_time_forbidden` (403, not a parent or admin), `media_time_not_a_child` (403, the target is not a child), '
      + '`media_time_not_found` (404, the device is unknown or belongs to another child)',
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
  '/api/v1/media-time/sessions': {
    get: REASON_BAD + ' (400, `day` is not YYYY-MM-DD, `user_id` is not a number, or a parent reads without naming a child), '
      + '`media_time_unauthenticated` (401, no session), `media_time_forbidden` (403, reading another child without being a parent)',
    post: REASON_BAD + ' (400, minutes is not an integer 1..720, or start_at/end_at are incomplete, unparseable, cross the household midnight, or differ by not 1..720 whole minutes), '
      + '`media_time_disabled` (403, the household has media time switched off), '
      + '`media_time_not_a_child` (403, the target is not a child), `media_time_not_found` (404, the device is unknown)',
  },
  '/api/v1/media-time/sessions/{id}': {
    patch: REASON_BAD + ' (400, `id` is not a number, the body is empty, `minutes` is outside 1..720, `note` is longer than 120 characters, or `device_id` belongs to another child or is revoked), '
      + '`media_time_forbidden` (403, not a parent or administrator), '
      + '`media_time_not_found` (404, no manual booking with this id - device-raw rows are never corrected)',
    delete: REASON_BAD + ', `media_time_forbidden` (403), '
      + '`media_time_not_found` (404, no manual booking with this id - device-raw rows are never deleted here)',
  },
  '/api/v1/media-time/checkins': {
    get: REASON_BAD + ', `media_time_forbidden` (403, reading another child without being a parent)',
    post: REASON_BAD + ', `media_time_disabled` (403, the household has media time switched off), '
      + '`media_time_not_a_child` (403, the target is not a child of the caller), '
      + '`media_time_not_found` (404, the device is unknown or revoked), '
      + '`media_time_already_checked_in` (409, an open check-in exists on this device)',
  },
  '/api/v1/media-time/checkins/{id}/end': {
    post: REASON_BAD + ', `media_time_forbidden` (403), `media_time_not_found` (404, no open check-in)',
  },
  '/api/v1/media-time/devices': {
    get: REASON_BAD + ', `media_time_forbidden` (403, reading another child without being a parent)',
    post: '`media_time_bad_request`, `media_time_forbidden` (403), `media_time_not_a_child` (403)',
  },
  '/api/v1/media-time/devices/{id}/revoke': {
    post: REASON_BAD + ', `media_time_forbidden` (403)',
  },
  '/api/v1/media-time/devices/{id}/inventory': {
    get: REASON_BAD + ', `media_time_forbidden` (403)',
  },
};
