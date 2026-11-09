/**
 * Feature-Modul Medienzeit: OpenAPI-Bausteine (Praeferenz-Schluessel,
 * Antwortfelder und components-Eintraege der Medienzeit-Routen).
 *
 * Aus server/openapi/schemas.js ausgelagert (Merge-Flaeche minimieren);
 * dort bleibt der Spread-Haken `...mediaTimeComponents`, und
 * server/openapi/paths/media-time.js importiert mediaTimeProperties von hier.
 */
// Lokal gespiegelte Helfer aus server/openapi/schemas.js (Kreis-Import vermeiden).
const isoDay = (description) => ({ type: ['string', 'null'], format: 'date', description });
const utcStamp = (description) => ({ type: 'string', format: 'date-time', description });
// Medienzeit (Bildschirmzeit-Kontingente): Praeferenz-Schluessel in sync_config
// als einzige Wahrheit. media_time_quiet_hours_global ist die GLOBALE
// Haushalt-Ruhezeit ('HH:MM-HH:MM', Default leer/AUS) - sichtbar fuer alle
// Haushaltsmitglieder als Signal, nie als Zwang. media_time_exchange_rate ist
// EIN Kurs fuer den ganzen Haushalt ('points:minutes', z. B. '10:15'), nie pro
// Kind. media_time_hard_cap ('1' Default = hart, '0' = kaufbar) entscheidet,
// ob max_daily_minutes hart oder erstehbar ist. media_time_enabled ist das
// Hauptregal des Haushalts (Default AUS).

// Medienzeit (Bildschirmzeit-Kontingente): die Antwortfelder der Routen, flach
// wie taskProperties - ein erzeugtes Modell soll keine verschachtelten Teile
// bekommen. server/features/media-time/routes.js ist die Quelle jedes Feldes.
// Die Regex-Muster liegen in Konstanten, damit kein Backslash durch einen
// Editier-Loop laufen muss.
const MT_TIME_RE = '^[0-9]{2}:[0-9]{2}$';
const MT_RANGE_RE = '^[0-9]{2}:[0-9]{2}-[0-9]{2}:[0-9]{2}$';
const MT_RATE_RE = '^[0-9]{1,4}:[0-9]{1,4}$';

export const mediaTimeProperties = {
  user_id: { type: 'integer', description: 'The child the row belongs to.' },
  day: isoDay('The household calendar day the numbers stand for (set server-side, never by the device clock).'),
  enabled: { type: 'boolean', description: 'Whether the household has media time switched on.' },
  quota_min: { type: 'integer', minimum: 0, description: 'Minutes allowed today: the daily quota plus bought minutes, up to the cap when the cap is hard.' },
  used_min: { type: 'integer', minimum: 0, description: 'Charged minutes used today.' },
  remaining_min: { type: 'integer', minimum: 0, description: 'quota_min minus used_min, floored at 0.' },
  charged_min: { type: 'integer', minimum: 0, description: 'Sum of usage minutes classified as charged.' },
  exempt_min: { type: 'integer', minimum: 0, description: 'Usage minutes of app exceptions (never charged, still visible in history).' },
  duty_min: { type: 'integer', minimum: 0, description: 'Minutes of duty rules (Pflichtzeit) today: never charged against the quota, shown as its own line.' },
  enforcement: { type: 'string', enum: ['count', 'lock'], description: "Household policy at time-up: 'count' only reports (devices stay usable), 'lock' lets agent devices lock (PC sign-out, notice screen)." },
  checked_in: { type: 'boolean', description: 'True while the child has an open check-in (Einbuchen) on a device; its minutes count against the quota until check-out or midnight.' },
  checkin_id: { type: 'integer', description: 'Id of the open check-in row (media_time_checkins).' },
  device_name: { type: 'string', description: 'Display name of the device a check-in belongs to.' },
  end_reason: { type: ['string', 'null'], enum: ['manual', 'auto', null], description: "How a closed check-in ended: 'manual' (child/parent checked out) or 'auto' (midnight sweep)." },
  device_id: { type: ['integer', 'null'], description: 'When set, the quota row applies to this device only; null means the quota counts across every device of the child.' },
  unknown_min: { type: 'integer', minimum: 0, description: 'Usage minutes of packages no rule covers. Fail-open: never charged; the parents decide from here.' },
  purchased_min: { type: 'integer', minimum: 0, description: 'Minutes bought with points today (they raise quota_min instead of counting as usage).' },
  adjusted_min: { type: 'integer', description: 'Minutes the parents moved today\'s quota with notes (positive raises, negative lowers; the sum of media_time_quota_notes of the day, 0 when none).' },
  reason: { type: ['string', 'null'], description: 'The reason of the newest quota note of the day, null when no note exists. The child sees it: no quota change without an explained reason.' },
  delta_minutes: { type: 'integer', minimum: -1440, maximum: 1440, description: 'The adjustment a note carries (never 0).' },
  max_daily_minutes: { type: ['integer', 'null'], minimum: 0, maximum: 1440, description: 'The per-child daily cap, null when uncapped.' },
  hard_cap: { type: 'boolean', description: 'Whether the household treats the cap as final (true) or as buyable up to (false).' },
  quiet: {
    type: ['object', 'null'],
    description: 'The GLOBAL household quiet window (media_time_quiet_hours_global), visible to every member as a signal, never as a lock. Null when off.',
    properties: {
      from: { type: 'string', pattern: MT_TIME_RE, description: 'Start, wall clock HH:MM.' },
      to: { type: 'string', pattern: MT_TIME_RE, description: 'End, wall clock HH:MM; before the start means it crosses midnight.' },
    },
  },
  quiet_active: { type: 'boolean', description: 'Whether the quiet window covers the current household wall time.' },
  exchange: {
    type: ['object', 'null'],
    description: 'The ONE household exchange rate (points buy minutes for every child the same way), null when the exchange is off.',
    properties: {
      points: { type: 'integer', minimum: 1, description: 'Points the household asks for one block.' },
      minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'Minutes the block adds to the day.' },
    },
  },
  state: {
    type: 'string',
    enum: ['ok', 'nearing', 'exceeded', 'quiet'],
    description: 'What a tracker shows: under five minutes left is nearing; the quiet window wins over everything. A signal, never an enforced block.',
  },
  tracker: {
    type: 'object',
    description: 'The tracker of the child: when its device last reported and whether it counts as online (within 12 hours).',
    properties: {
      last_seen_at: { type: ['string', 'null'], format: 'date-time', description: 'UTC instant of the last report, null when the device never reported.' },
      online: { type: 'boolean', description: 'True when a device of this child reported within the last 12 hours.' },
    },
  },
  accepted: { type: 'integer', minimum: 0, description: 'Sessions stored or updated by this sync.' },
  rejected: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        session_key: { type: ['string', 'null'], description: 'The key of the refused session.' },
        reason: { type: 'string', description: 'Why it was refused (a reason code, e.g. media_time_bad_request).' },
      },
    },
    description: 'Sessions this sync refused, with the reason per key.',
  },
  server_day: isoDay('The household day the server counts right now - the client clock is never the authority.'),
  server_time: utcStamp('UTC instant of the answer, to the second (clock_offset reference).'),
  exceptions_version: { type: 'integer', minimum: 0, description: 'Changes with every exception upsert and revoke: the client cache invalidates on it.' },
  version: { type: 'integer', minimum: 0, description: 'Exception rules version after the change.' },
  ok: { type: 'boolean', description: 'Heartbeat recorded.' },
  items: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        user_id: { type: ['integer', 'null'], description: 'Null is the household default: the rule applies to every child.' },
        match_type: { type: 'string', enum: ['exact', 'prefix', 'glob'] },
        pattern: { type: 'string', description: 'Package name or pattern (glob: * and ?).' },
        exempt_from: { type: 'string', enum: ['quota', 'history', 'charged'], description: 'quota never charged but visible in history, history out of charge and evaluation, charged the parent confirmed charging.' },
        note: { type: ['string', 'null'] },
        created_at: utcStamp('UTC instant of creation, to the second.'),
      },
    },
  },
  daily_minutes: { type: 'integer', minimum: 0, maximum: 1440, description: 'Base minutes per day for this child.' },
  updated_at: utcStamp('UTC instant of the last change, to the second.'),
  updated_by: { type: ['integer', 'null'], description: 'Who set it last.' },
  display_name: { type: 'string' },
  username: { type: 'string' },
  purchase_id: { type: 'string', description: 'Stands in the ledger reason (media_time:<purchase_id>) and in the session key of the credit row.' },
  minutes: { type: 'integer', minimum: 1, description: 'Minutes the purchase adds to the day.' },
  points_spent: { type: 'integer', minimum: 1, description: 'Points booked off the ledger.' },
  id: { type: 'integer' },
  name: { type: 'string' },
  platform: { type: ['string', 'null'] },
  last_seen_at: { type: ['string', 'null'], format: 'date-time', description: 'UTC instant of the last device report.' },
  revoked_at: { type: ['string', 'null'], format: 'date-time', description: 'Set on revoke instead of deleting.' },
  created_at: utcStamp('UTC instant of creation, to the second.'),
  token: { type: 'string', description: 'The device token, present exactly once: on creation.' },
  note: { type: ['string', 'null'] },
  revoked: { type: 'boolean' },
  package_name: { type: 'string' },
  version_name: { type: ['string', 'null'] },
  system_app: { type: 'integer', enum: [0, 1] },
  first_seen_at: utcStamp('UTC instant the package first appeared on the device.'),
  first_install_estimate: { type: ['string', 'null'], description: 'Best effort from the device, may be null.' },
  session_key: { type: 'string', description: 'Idempotency key of the session (unique per device).' },
  editable: { type: 'boolean', description: "True when the row may be edited or deleted (source 'manual' bookings only; raw device sessions never are)." },
  app_label: { type: ['string', 'null'], description: 'Label shown for the session (the note of a manual booking).' },
  source: { type: 'string', enum: ['apk', 'pwa', 'manual', 'adjust', 'backfill', 'win'], description: 'Where the row came from; only manual bookings are editable.' },
  minute_key: isoDay('Household day of the session, set server-side at arrival.'),
  started_at: { type: 'string', description: 'Device-local ISO8601 with offset; only its difference to ended_at matters.' },
  ended_at: { type: ['string', 'null'], description: 'Null while the segment runs (a heartbeat extends it; the server caps running segments at 12 hours).' },
  used_minutes: { type: 'integer', minimum: 0, description: 'Minutes of the segment as reported.' },
  reported_by: { type: ['integer', 'null'], description: 'Whose account booked it.' },
  retention_days: { type: 'integer', minimum: 1, description: 'Days raw session rows (package, start, end) are kept before pruning; aggregates stay.' },
  range: { type: ['string', 'null'], pattern: MT_RANGE_RE, description: 'Quiet window "HH:MM-HH:MM", null when off.' },
  wall_time: { type: 'string', pattern: MT_TIME_RE, description: 'Current household wall-clock time (HH:MM).' },
};

const mediaTimeQuotaFields = {
  user_id: mediaTimeProperties.user_id,
  device_id: { type: ['integer', 'null'], minimum: 1, description: 'When set, the quota row applies to this device only (overrides the child-wide row for it); null is the child-wide base row.' },
  device_name: { type: ['string', 'null'], description: 'Display name of the device this quota row belongs to, null on the child-wide row.' },
  daily_minutes: mediaTimeProperties.daily_minutes,
  max_daily_minutes: mediaTimeProperties.max_daily_minutes,
  enabled: { type: 'integer', enum: [0, 1], description: '0 suspends the quota without deleting it.' },
  updated_at: mediaTimeProperties.updated_at,
  updated_by: mediaTimeProperties.updated_by,
};

export const mediaTimeComponents = {
        // ------------------------------------------------------------------
        // Medienzeit (server/features/media-time/routes.js): Felder aus mediaTimeProperties.
        // ------------------------------------------------------------------
        MediaTimeQuota: {
          type: 'object',
          required: ['user_id', 'daily_minutes', 'enabled'],
          properties: mediaTimeQuotaFields,
        },
        MediaTimeQuotaListResponse: {
          type: 'object', required: ['data'],
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/MediaTimeQuota' } } },
        },
        MediaTimeQuotaResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeQuota' } },
        },
        MediaTimeQuotaInput: {
          type: 'object',
          required: ['daily_minutes'],
          properties: {
            daily_minutes: { type: 'integer', minimum: 0, maximum: 1440 },
            max_daily_minutes: { type: ['integer', 'null'], minimum: 0, maximum: 1440 },
            enabled: { type: 'integer', enum: [0, 1] },
            device_id: { type: ['integer', 'null'], minimum: 1, description: 'Set to store a per-device quota row (overrides the child-wide row for that device); null or omitted keeps the child-wide base row.' },
          },
        },
        MediaTimeTodayData: {
          type: 'object',
          required: ['user_id', 'day', 'enabled', 'quota_min', 'used_min', 'remaining_min',
            'charged_min', 'exempt_min', 'unknown_min', 'adjusted_min', 'reason',
            'quiet_active', 'state', 'tracker'],
          properties: {
            user_id: mediaTimeProperties.user_id,
            familylink: { $ref: '#/components/schemas/MediaTimeFamilylinkDay', description: 'Real screen time from Google Family Link for today (never zeros when the collector cannot report).' },
            day: mediaTimeProperties.day,
            enabled: mediaTimeProperties.enabled,
            quota_min: mediaTimeProperties.quota_min,
            used_min: mediaTimeProperties.used_min,
            remaining_min: mediaTimeProperties.remaining_min,
            charged_min: mediaTimeProperties.charged_min,
            exempt_min: mediaTimeProperties.exempt_min,
            unknown_min: mediaTimeProperties.unknown_min,
            purchased_min: mediaTimeProperties.purchased_min,
            adjusted_min: mediaTimeProperties.adjusted_min,
            reason: mediaTimeProperties.reason,
            duty_min: mediaTimeProperties.duty_min,
            checked_in: mediaTimeProperties.checked_in,
            enforcement: mediaTimeProperties.enforcement,
            max_daily_minutes: mediaTimeProperties.max_daily_minutes,
            hard_cap: mediaTimeProperties.hard_cap,
            quiet: mediaTimeProperties.quiet,
            quiet_active: mediaTimeProperties.quiet_active,
            exchange: mediaTimeProperties.exchange,
            state: mediaTimeProperties.state,
            wall_time: mediaTimeProperties.wall_time,
            tracker: mediaTimeProperties.tracker,
            devices: {
              type: 'array',
              description: "Usage of the day per device, on the same basis dayUsage counts (tracker sessions, manual bookings, family link replacement per device mapping); usage without a device is the row with device_id null.",
              items: {
                type: 'object',
                required: ['device_id', 'device_name', 'minutes'],
                properties: {
                  device_id: { type: ['integer', 'null'], minimum: 1, description: 'The media-time device; null for usage booked without one (and for family link days of a child without devices).' },
                  device_name: { type: ['string', 'null'], description: 'Display name of the device, null on the no-device row.' },
                  minutes: { type: 'integer', minimum: 0, description: 'Charged minutes of this device today (family link values replace the device sessions, never add to them).' },
                },
              },
            },
          },
        },
        MediaTimeTodayResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeTodayData' } },
        },
        MediaTimeQuotaDayAdjustInput: {
          type: 'object',
          required: ['delta_minutes', 'reason'],
          description: 'One adjustment of the current day. The note is never rewritten: several notes on a day sum.',
          properties: {
            delta_minutes: { ...mediaTimeProperties.delta_minutes, description: 'Minutes to add (positive) or take away (negative) for today. Never 0.' },
            reason: { type: 'string', minLength: 3, maxLength: 300, description: 'Why the parents moved the quota. Mandatory: the child sees it in GET /today.' },
          },
        },
        MediaTimeQuotaDayAdjustData: {
          type: 'object',
          required: ['day_key', 'delta_minutes', 'quota_min'],
          properties: {
            day_key: isoDay('The household day the note was written for (server-side, never the device clock).'),
            delta_minutes: mediaTimeProperties.delta_minutes,
            quota_min: mediaTimeProperties.quota_min,
            adjusted_min: mediaTimeProperties.adjusted_min,
            remaining_min: mediaTimeProperties.remaining_min,
          },
        },
        MediaTimeQuotaDayAdjustResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeQuotaDayAdjustData' } },
        },
        MediaTimeQuotaNoteItem: {
          type: 'object',
          required: ['day_key', 'delta_minutes', 'reason', 'created_at'],
          properties: {
            day_key: isoDay('The household day the note applies to.'),
            delta_minutes: mediaTimeProperties.delta_minutes,
            reason: { type: 'string', description: 'The mandatory reason the parent gave.' },
            created_by: { type: ['integer', 'null'], description: 'The parent who wrote it (null when that account is gone).' },
            created_at: mediaTimeProperties.created_at,
          },
        },
        MediaTimeQuotaDayNotesResponse: {
          type: 'object', required: ['data'],
          properties: {
            data: {
              type: 'object', required: ['items'],
              properties: { items: { type: 'array', maxItems: 30, items: { $ref: '#/components/schemas/MediaTimeQuotaNoteItem' } } },
            },
          },
        },
        MediaTimeQuotaState: {
          type: 'object',
          required: ['remaining_min', 'used_min', 'state'],
          properties: {
            remaining_min: mediaTimeProperties.remaining_min,
            used_min: mediaTimeProperties.used_min,
            quota_min: mediaTimeProperties.quota_min,
            quiet_active: mediaTimeProperties.quiet_active,
            state: mediaTimeProperties.state,
            enforcement: mediaTimeProperties.enforcement,
            reason: mediaTimeProperties.reason,
            device_id: mediaTimeProperties.device_id,
          },
        },
        MediaTimeTrackerSyncInput: {
          type: 'object',
          description: 'Sessions of the tracker, replayed by the client. session_key is the idempotency key (unique per device).',
          properties: {
            device_time: { type: ['string', 'null'], description: 'Device-local ISO8601 with offset, informational only.' },
            sessions: {
              type: 'array',
              maxItems: 200,
              items: {
                type: 'object',
                required: ['session_key', 'started_at'],
                properties: {
                  session_key: { type: 'string', maxLength: 200 },
                  package: { type: ['string', 'null'], maxLength: 200 },
                  app_label: { type: ['string', 'null'], maxLength: 200 },
                  started_at: { type: 'string', description: 'Device-local ISO8601 with offset.' },
                  ended_at: { type: ['string', 'null'], description: 'Null while the segment runs.' },
                  foreground_ms: { type: 'integer', minimum: 0, description: 'Active foreground milliseconds (clipped by the client).' },
                  screen_on_ms: { type: 'integer', minimum: 0, description: 'Overlap with screen-on time; informational, never the charge basis.' },
                  kind: { type: 'string', enum: ['foreground', 'screen_on', 'service'], description: 'Only foreground can ever be charged.' },
                  system: { type: 'integer', enum: [0, 1], description: '1 for launcher/phone/settings-style components: implicit exception, never charged.' },
                },
              },
            },
            inventory_delta: {
              type: ['array', 'null'],
              items: {
                type: 'object',
                required: ['package'],
                properties: {
                  package: { type: 'string', maxLength: 200 },
                  version_name: { type: ['string', 'null'], maxLength: 100 },
                  system_app: { type: 'integer', enum: [0, 1] },
                  first_install_estimate: { type: ['string', 'null'] },
                },
              },
            },
          },
        },
        MediaTimeTrackerSyncData: {
          type: 'object',
          required: ['accepted', 'rejected', 'server_day', 'server_time', 'quota', 'exceptions_version'],
          properties: {
            accepted: mediaTimeProperties.accepted,
            rejected: mediaTimeProperties.rejected,
            server_day: mediaTimeProperties.server_day,
            server_time: mediaTimeProperties.server_time,
            quota: { $ref: '#/components/schemas/MediaTimeQuotaState' },
            exceptions_version: mediaTimeProperties.exceptions_version,
          },
        },
        MediaTimeTrackerSyncResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeTrackerSyncData' } },
        },
        MediaTimeTrackerHeartbeatInput: {
          type: 'object',
          required: ['session_key'],
          properties: {
            session_key: { type: 'string', maxLength: 200 },
            package: { type: ['string', 'null'], maxLength: 200 },
            used_minutes: { type: 'integer', minimum: 0, description: 'Minutes so far; the higher of stored and sent wins.' },
            running: { type: 'boolean', description: 'Informational: the segment is still open.' },
          },
        },
        MediaTimeHeartbeatData: {
          type: 'object',
          required: ['ok', 'quota'],
          properties: {
            ok: mediaTimeProperties.ok,
            quota: { $ref: '#/components/schemas/MediaTimeQuotaState' },
          },
        },
        MediaTimeHeartbeatResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeHeartbeatData' } },
        },
        MediaTimeExceptionsListData: {
          type: 'object',
          required: ['items', 'version'],
          properties: {
            items: mediaTimeProperties.items,
            version: mediaTimeProperties.version,
          },
        },
        MediaTimeExceptionsListResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeExceptionsListData' } },
        },
        MediaTimeExceptionInput: {
          type: 'object',
          required: ['match_type', 'pattern'],
          properties: {
            user_id: { type: ['integer', 'null'], description: 'Null is the household default for every child.' },
            match_type: { type: 'string', enum: ['exact', 'prefix', 'glob'] },
            pattern: { type: 'string', minLength: 1, maxLength: 200 },
            exempt_from: { type: 'string', enum: ['quota', 'history', 'charged'], description: 'Default quota. The Yuvomi app package cannot be listed.' },
            kind: { type: 'string', enum: ['quota', 'duty'], description: "'duty' marks a required-time block (Pflichtzeit): its minutes are never charged against the quota and show as duty_min on the day page." },
            note: { type: ['string', 'null'], maxLength: 500 },
          },
        },
        MediaTimeExceptionsPutInput: {
          type: 'object',
          properties: {
            upsert: { type: 'array', items: { $ref: '#/components/schemas/MediaTimeExceptionInput' } },
            revoke: { type: 'array', items: { type: 'integer' }, description: 'Ids to revoke; revoking sets revoked_at, nothing is deleted.' },
          },
        },
        MediaTimeExceptionsVersionResponse: {
          type: 'object', required: ['data'],
          properties: { data: { type: 'object', required: ['version'], properties: { version: mediaTimeProperties.version } } },
        },
        MediaTimeQuietHoursData: {
          type: 'object',
          required: ['enabled', 'range'],
          properties: {
            enabled: { type: 'boolean' },
            range: mediaTimeProperties.range,
            active_now: mediaTimeProperties.quiet_active,
          },
        },
        MediaTimeQuietHoursResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeQuietHoursData' } },
        },
        MediaTimeQuietHoursInput: {
          type: 'object',
          required: ['range'],
          properties: { range: mediaTimeProperties.range },
        },
        MediaTimeSettingsData: {
          type: 'object',
          required: ['enabled', 'hard_cap'],
          properties: {
            enabled: mediaTimeProperties.enabled,
            exchange: mediaTimeProperties.exchange,
            hard_cap: mediaTimeProperties.hard_cap,
            retention_days: mediaTimeProperties.retention_days,
            enforcement: mediaTimeProperties.enforcement,
            familylink_ingest_enabled: { type: 'boolean', description: 'True when the five-minute family link ingest runs on this household.' },
            familylink_status: { type: ['string', 'null'], enum: ['ok', 'login_noetig', null], description: 'Last collector outcome; null before the first run.' },
            familylink_email: { type: ['string', 'null'], description: 'Kontoadresse des letzten erfolgreichen Auto-Logins (Vorbelegung der App); null, bevor je ein Auto-Login gelang. Ein Passwort wird nie gespeichert.' },
            familylink_status_at: { type: ['string', 'null'], description: 'When the collector status was last set (ISO instant); null before the first run.' },
            familylink_last_report_at: { type: ['string', 'null'], description: 'Newest fetched_at of a collected family link day row (the last real report); null when nothing was ever collected - a login_noetig status alone does not move it.' },
          },
        },
        MediaTimeFamilylinkReportInput: {
          description: 'Zwei Formen, eine Route: der Report, den scripts/familylink/familyhub_screen.py --json liefert\n'
            + '(Push vom Collector-Host), oder der reine Status-Report { status } ohne children, mit dem der Collector\n'
            + 'seine abgelaufene Google-Sitzung meldet (derselbe setStatus-Pfad wie der lokale Takt).',
          oneOf: [
            {
              type: 'object',
              required: ['date', 'children'],
              properties: {
                date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
                children: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['userId', 'devices'],
                    properties: {
                      userId: { type: 'string', description: 'Pseudonyme Google-Kennung (Ziffernfolge).' },
                      name: { type: 'string', description: 'Wird verworfen - Kind-Namen landen nicht in der Datenbank.' },
                      downtime: { type: ['string', 'null'] },
                      devices: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, consumed_min: { type: ['number', 'null'] }, allowed_min: { type: ['number', 'null'] }, remaining_min: { type: ['number', 'null'] } } } },
                    },
                  },
                },
              },
            },
            {
              type: 'object',
              required: ['status'],
              properties: {
                status: { type: 'string', enum: ['ok', 'login_noetig'], description: 'Nur der Status ohne children-Liste; ein unbekannter Wert ist 400.' },
              },
            },
          ],
        },
        MediaTimeFamilylinkReportResponse: {
          type: 'object', required: ['data'],
          properties: { data: {
            description: 'Report-Pfad: written/errors; Status-Pfad: das gesetzte status.',
            oneOf: [
              { type: 'object', required: ['written', 'errors'], properties: { written: { type: 'integer', minimum: 0 }, errors: { type: 'integer', minimum: 0 } } },
              { type: 'object', required: ['status'], properties: { status: { type: 'string', enum: ['ok', 'login_noetig'] } } },
            ],
          } },
        },
        MediaTimeFamilylinkTokenData: {
          type: 'object',
          required: ['token'],
          properties: {
            token: { type: 'string', description: 'Klartext nur einmal in dieser Antwort; gespeichert ist ausschliesslich der Hash.' },
            note: { type: 'string' },
          },
        },
        MediaTimeFamilylinkLoginSessionData: {
          type: 'object',
          required: ['viewer_url', 'expires_at'],
          properties: {
            viewer_url: { type: 'string', description: 'Einmal-Viewer-Seite des Collectors (traegt das Sitzungs-Token); gueltig bis expires_at, danach 404 am Collector.' },
            expires_at: { type: 'string', description: 'ISO-Moment des Ablaufs (10 Minuten nach Start, harte Collector-Grenze 15).' },
          },
        },
        MediaTimeFamilylinkLoginSessionResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeFamilylinkLoginSessionData' } },
        },
        MediaTimeFamilylinkLoginInput: {
          description: 'Zwei Formen, eine Route: { email, password } startet einen Auto-Login-Versuch (der Sammler\n'
            + 'fuellt das Google-Formular selbst), { code } loest eine offene pending-Sitzung auf der OTP-Seite auf.\n'
            + 'Niemals gemischt; das Passwort verlaesst den Server nur als Request an den Collector.',
          type: 'object',
          properties: {
            email: { type: 'string', maxLength: 320, description: 'Google-Kontoadresse des Familienverwalters.' },
            password: { type: 'string', minLength: 1, maxLength: 300, writeOnly: true, description: 'Nur Eingabe - erscheint in keiner Antwort und wird nie gespeichert.' },
            code: { type: 'string', pattern: '^[0-9A-Za-z .-]{4,16}$', description: 'OTP-Code fuer die offene pending-Sitzung.' },
          },
        },
        MediaTimeFamilylinkLoginData: {
          type: 'object',
          required: ['state'],
          properties: {
            state: { type: 'string', enum: ['ok', 'otp_needed', 'bad_code', 'challenge'], description: 'ok: anmeldet und Cookies frisch. otp_needed: die App fragt den Code ab (pending offen, 10 Minuten). bad_code: Code war falsch, erneut erlaubt. challenge: nicht automatisierbar - die Antwort traegt den Viewer-Pfad.' },
            viewer_url: { type: ['string', 'null'], description: 'Nur bei state challenge: Einmal-Viewer-Seite des Collectors (dieselbe Sitzung wie POST /familylink/login-session).' },
            expires_at: { type: ['string', 'null'], description: 'Nur bei state challenge: ISO-Moment des Viewer-Ablaufs.' },
          },
        },
        MediaTimeFamilylinkLoginResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeFamilylinkLoginData' } },
        },
        MediaTimeFamilylinkDay: {
          type: 'object',
          required: ['mapped', 'devices'],
          properties: {
            mapped: { type: 'boolean', description: 'False without a parent mapping - the UI then says nothing instead of zero.' },
            status: { type: ['string', 'null'], enum: ['ok', 'login_noetig', null], description: "Collector status: 'ok' or 'login_noetig' (a failed run never writes zero snapshots)." },
            devices: { type: 'array', items: { $ref: '#/components/schemas/MediaTimeFamilylinkDevice' } },
          },
        },
        MediaTimeFamilylinkDevice: {
          type: 'object',
          required: ['day', 'fetched_at'],
          properties: {
            media_time_device_id: { type: ['integer', 'null'], description: 'The Yuvomi device this Google device is mapped to.' },
            device_name: { type: ['string', 'null'] },
            day: { type: 'string', description: 'Day of the aggregate (YYYY-MM-DD).' },
            limit_min: { type: ['number', 'null'] },
            consumed_min: { type: ['number', 'null'] },
            remaining_min: { type: ['number', 'null'] },
            downtime: { type: ['string', 'null'], description: "Google's downtime window, display only - Yuvomi enforces its own quiet hours." },
            fetched_at: { type: 'string' },
          },
        },
        MediaTimeFamilylinkUsageData: {
          type: 'object',
          required: ['user_id', 'day', 'mapped', 'devices'],
          properties: {
            user_id: { type: 'integer' },
            day: { type: 'string' },
            mapped: { type: 'boolean' },
            status: { type: ['string', 'null'], enum: ['ok', 'login_noetig', null] },
            devices: { type: 'array', items: { $ref: '#/components/schemas/MediaTimeFamilylinkDevice' } },
          },
        },
        MediaTimeFamilylinkUsageResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeFamilylinkUsageData' } },
        },
        MediaTimeFamilylinkAppUsageItem: {
          type: 'object',
          required: ['google_uid', 'pkg', 'minutes'],
          properties: {
            google_uid: { type: 'string', description: 'Pseudonymous Google account id (digit string from the collector) - never a child name.' },
            yuvomi_user_id: { type: ['integer', 'null'], description: 'The mapped child (enabled mapping); null without one.' },
            pkg: { type: 'string', minLength: 1, maxLength: 200, description: 'App package name.' },
            name: { type: ['string', 'null'], maxLength: 200, description: 'Display name as reported, or null.' },
            minutes: { type: 'number', minimum: 0 },
          },
        },
        MediaTimeFamilylinkAppUsageData: {
          type: 'object',
          required: ['day', 'items'],
          properties: {
            day: { type: 'string', description: 'Day of the list (YYYY-MM-DD).' },
            items: { type: 'array', maxItems: 100, items: { $ref: '#/components/schemas/MediaTimeFamilylinkAppUsageItem' }, description: 'Collected app rows of the day, minutes descending, at most 100.' },
          },
        },
        MediaTimeFamilylinkAppUsageResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeFamilylinkAppUsageData' } },
        },
        MediaTimeFamilylinkMappingDevice: {
          type: 'object',
          required: ['google_device_id'],
          properties: {
            google_device_id: { type: 'string', minLength: 3, maxLength: 64 },
            media_time_device_id: { type: ['integer', 'null'] },
            device_name: { type: ['string', 'null'] },
          },
        },
        MediaTimeFamilylinkMappingData: {
          type: 'object',
          required: ['mapped', 'devices'],
          properties: {
            mapped: { type: 'boolean' },
            google_uid: { type: ['string', 'null'], description: 'Pseudonymous Google account id (digit string from the collector).' },
            enabled: { type: 'boolean' },
            devices: { type: 'array', items: { $ref: '#/components/schemas/MediaTimeFamilylinkMappingDevice' } },
          },
        },
        MediaTimeFamilylinkMappingResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeFamilylinkMappingData' } },
        },
        MediaTimeFamilylinkMappingInput: {
          type: 'object',
          required: ['user_id'],
          properties: {
            user_id: { type: 'integer', minimum: 1 },
            google_uid: { type: ['string', 'null'], pattern: '^[0-9]{6,40}$', description: 'Digit string from the collector report; null or empty removes the mapping.' },
            devices: { type: ['array', 'null'], items: { type: 'object', required: ['google_device_id'], properties: { google_device_id: { type: 'string', minLength: 3, maxLength: 64 }, media_time_device_id: { type: ['integer', 'null'] } } } },
          },
        },
        MediaTimeFamilylinkMappingSaveData: {
          type: 'object',
          required: ['mapped'],
          properties: {
            mapped: { type: 'boolean' },
            google_uid: { type: ['string', 'null'] },
          },
        },
        MediaTimeFamilylinkIngestData: {
          type: 'object',
          required: ['ok', 'status'],
          properties: {
            ok: { type: 'boolean' },
            written: { type: 'integer', minimum: 0 },
            status: { type: 'string', enum: ['ok', 'login_noetig'] },
          },
        },
        MediaTimeFamilylinkIngestResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeFamilylinkIngestData' } },
        },
        MediaTimeSettingsResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeSettingsData' } },
        },
        MediaTimeSettingsInput: {
          type: 'object',
          properties: {
            exchange: {
              description: 'ONE rate for the whole household: "points:minutes" (e.g. "10:15"), {points, minutes}, or null/empty to turn the exchange off.',
              oneOf: [
                { type: 'string', pattern: '^\\d{1,4}:\\d{1,4}$' },
                { type: 'null' },
                { type: 'object', required: ['points', 'minutes'], properties: { points: { type: 'integer', minimum: 1 }, minutes: { type: 'integer', minimum: 1, maximum: 1440 } } },
              ],
            },
            enforcement: { type: 'string', enum: ['count', 'lock'], description: "Household policy at time-up (see MediaTimeTodayData.enforcement)." },
            hard_cap: { type: 'boolean', description: 'Default true: max_daily_minutes is final. False: it can be bought up to.' },
            familylink_ingest_enabled: { type: 'boolean', description: 'Turn the five-minute family link ingest on or off (default off).' },
          },
        },
        MediaTimePurchaseInput: {
          type: 'object',
          properties: {
            user_id: { type: ['integer', 'null'], description: 'A child, parents/admin only; defaults to the caller.' },
            quantity: { type: 'integer', minimum: 1, maximum: 100, description: 'Blocks at the household rate, default 1.' },
          },
        },
        MediaTimePurchaseData: {
          type: 'object',
          required: ['purchase_id', 'minutes', 'points_spent', 'quota'],
          properties: {
            purchase_id: mediaTimeProperties.purchase_id,
            minutes: mediaTimeProperties.minutes,
            points_spent: mediaTimeProperties.points_spent,
            quota: { $ref: '#/components/schemas/MediaTimeQuotaState' },
          },
        },
        MediaTimePurchaseResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimePurchaseData' } },
        },
        MediaTimePurchaseItem: {
          type: 'object',
          properties: {
            session_key: mediaTimeProperties.session_key,
            minute_key: mediaTimeProperties.minute_key,
            started_at: mediaTimeProperties.started_at,
            used_minutes: mediaTimeProperties.used_minutes,
            reported_by: mediaTimeProperties.reported_by,
            created_at: mediaTimeProperties.created_at,
          },
        },
        MediaTimePurchasesResponse: {
          type: 'object', required: ['data'],
          properties: {
            data: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/MediaTimePurchaseItem' } } } },
          },
        },
        MediaTimeManualSessionInput: {
          type: 'object',
          required: ['user_id'],
          description: 'Either `minutes` (booked backwards from now) or the explicit pair `start_at`/`end_at` (both same household day; the pair wins over minutes).',
          properties: {
            user_id: { type: 'integer', minimum: 1 },
            minutes: { type: 'integer', minimum: 1, maximum: 720, description: 'Booked usage minutes for a device without an agent (console, TV).' },
            start_at: { type: ['string', 'null'], description: 'ISO instant with offset; the booking start. Needs end_at.' },
            end_at: { type: ['string', 'null'], description: 'ISO instant with offset; the booking end. Needs start_at; same household day as start_at.' },
            note: { type: ['string', 'null'], maxLength: 120, description: 'Optional reason shown to the child.' },
            device_id: { type: ['integer', 'null'], minimum: 1, description: 'Optional device the booking belongs to.' },
          },
        },
        MediaTimeManualSessionData: {
          type: 'object',
          required: ['charged_min'],
          properties: {
            charged_min: { type: 'integer', description: "Today's charged minutes after the booking." },
            remaining_min: mediaTimeProperties.remaining_min,
            state: mediaTimeProperties.state,
          },
        },
        MediaTimeManualSessionResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeManualSessionData' } },
        },
        MediaTimeSessionItem: {
          type: 'object',
          required: ['id', 'session_key', 'user_id', 'device_id', 'device_name', 'app_label', 'used_minutes', 'started_at', 'ended_at', 'source', 'editable'],
          description: 'A charged usage row of a household day. `editable` is true only for manual bookings (the raw rows of a device are never rewritten).',
          properties: {
            id: mediaTimeProperties.id,
            session_key: mediaTimeProperties.session_key,
            user_id: mediaTimeProperties.user_id,
            device_id: { type: ['integer', 'null'], description: 'Device the row belongs to, null for agent-less bookings (console, TV).' },
            device_name: { type: ['string', 'null'], description: 'Display name of that device (media_time_devices.name), null when there is none.' },
            app_label: mediaTimeProperties.app_label,
            used_minutes: mediaTimeProperties.used_minutes,
            started_at: mediaTimeProperties.started_at,
            ended_at: mediaTimeProperties.ended_at,
            source: mediaTimeProperties.source,
            editable: mediaTimeProperties.editable,
          },
        },
        MediaTimeSessionListResponse: {
          type: 'object', required: ['data'],
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/MediaTimeSessionItem' } } },
        },
        MediaTimeSessionUpdateInput: {
          type: 'object',
          minProperties: 1,
          description: 'Correction of a manual booking. `minutes` keeps `ended_at` and moves `started_at` to ended_at minus minutes.',
          properties: {
            minutes: { type: 'integer', minimum: 1, maximum: 720, description: 'New length: started_at = ended_at - minutes, ended_at stays the anchor.' },
            note: { type: ['string', 'null'], maxLength: 120, description: 'New label for the child (app_label).' },
            device_id: { type: ['integer', 'null'], minimum: 1, description: 'New device (must belong to the child, unrevoked); null books it without a device.' },
          },
        },
        MediaTimeSessionResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeSessionItem' } },
        },
        MediaTimeSessionDeleteResponse: {
          type: 'object', required: ['data'],
          properties: {
            data: {
              type: 'object', required: ['deleted'],
              properties: { deleted: { type: 'boolean', description: 'True: the manual booking is gone (hard delete - manual rows are not audit data).' } },
            },
          },
        },
        MediaTimeCheckinInput: {
          type: 'object',
          required: ['user_id', 'device_id'],
          properties: {
            user_id: { type: 'integer', minimum: 1 },
            device_id: { type: 'integer', minimum: 1 },
          },
        },
        MediaTimeCheckinItem: {
          type: 'object',
          required: ['id', 'device_id', 'started_at'],
          properties: {
            id: mediaTimeProperties.id,
            device_id: { type: 'integer', description: 'Device the check-in runs on.' },
            device_name: mediaTimeProperties.device_name,
            started_at: { type: 'string', description: 'When the child checked in (ISO 8601).' },
            ended_at: { type: ['string', 'null'], description: 'When it ended; null while open.' },
            end_reason: mediaTimeProperties.end_reason,
          },
        },
        MediaTimeCheckinsResponse: {
          type: 'object', required: ['data'],
          properties: {
            data: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/MediaTimeCheckinItem' } } } },
          },
        },
        MediaTimeCheckinData: {
          type: 'object',
          required: ['checked_in'],
          properties: {
            id: mediaTimeProperties.id,
            device_id: { type: 'integer', description: 'Device the check-in runs on.' },
            checked_in: mediaTimeProperties.checked_in,
            state: mediaTimeProperties.state,
            remaining_min: mediaTimeProperties.remaining_min,
          },
        },
        MediaTimeCheckinResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeCheckinData' } },
        },
        MediaTimeDevice: {
          type: 'object',
          required: ['id', 'user_id', 'name'],
          properties: {
            id: mediaTimeProperties.id,
            user_id: mediaTimeProperties.user_id,
            name: mediaTimeProperties.name,
            platform: mediaTimeProperties.platform,
            last_seen_at: mediaTimeProperties.last_seen_at,
            revoked_at: mediaTimeProperties.revoked_at,
            created_at: mediaTimeProperties.created_at,
          },
        },
        MediaTimeDeviceListResponse: {
          type: 'object', required: ['data'],
          properties: { data: { type: 'array', items: { $ref: '#/components/schemas/MediaTimeDevice' } } },
        },
        MediaTimeDeviceCreateInput: {
          type: 'object',
          required: ['user_id', 'name'],
          properties: {
            user_id: { type: 'integer', minimum: 1 },
            name: { type: 'string', minLength: 1, maxLength: 100 },
            platform: { type: ['string', 'null'], maxLength: 40 },
          },
        },
        MediaTimeDeviceCreateData: {
          type: 'object',
          required: ['id', 'user_id', 'name', 'token'],
          properties: {
            id: mediaTimeProperties.id,
            user_id: mediaTimeProperties.user_id,
            name: mediaTimeProperties.name,
            token: { type: 'string', description: 'The device token, shown exactly once.' },
            note: { type: ['string', 'null'] },
          },
        },
        MediaTimeDeviceCreateResponse: {
          type: 'object', required: ['data'],
          properties: { data: { $ref: '#/components/schemas/MediaTimeDeviceCreateData' } },
        },
        MediaTimeInventoryItem: {
          type: 'object',
          required: ['package_name', 'first_seen_at', 'last_seen_at'],
          properties: {
            package_name: mediaTimeProperties.package_name,
            version_name: mediaTimeProperties.version_name,
            system_app: mediaTimeProperties.system_app,
            first_seen_at: mediaTimeProperties.first_seen_at,
            last_seen_at: { type: 'string', format: 'date-time', description: 'UTC instant of the last sighting.' },
            first_install_estimate: mediaTimeProperties.first_install_estimate,
          },
        },
        MediaTimeInventoryResponse: {
          type: 'object', required: ['data'],
          properties: {
            data: { type: 'object', required: ['items'], properties: { items: { type: 'array', items: { $ref: '#/components/schemas/MediaTimeInventoryItem' } } } },
          },
        },
};
