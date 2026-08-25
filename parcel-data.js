/* MMM-ParcelApp — pure data helpers.
 *
 * Everything in this file is side-effect free and has no dependency on
 * MagicMirror or on Node's runtime APIs, so node_helper.js and the unit tests
 * can share it. All normalisation (parsing, filtering, sorting, collapsing,
 * formatting) happens here; node_helper.js does the I/O and the frontend only
 * builds DOM.
 */
"use strict";

const MS_MINUTE = 60 * 1000;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

const ELLIPSIS = "…";
const EN_DASH = "–";
const NO_DATE = "--//--";

/* Amazon descriptions arrive pre-truncated by the source at 50 characters,
 * trailing U+2026 included. This cap sits above that so those pass through
 * untouched; it is a sanity bound on payload size, not the layout. The column
 * width is what actually fits text to the mirror, via CSS ellipsis. */
const MAX_DESCRIPTION = 60;
const MAX_ERROR_MESSAGE = 120;

const MONTHS = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday",
  "Friday", "Saturday"];
const WEEKDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug",
  "Sep", "Oct", "Nov", "Dec"];

/* Status codes, in display order. `rank` sorts the list; `tone` drives colour.
 * Rank 3 is reserved for a status 5 that has aged past its grace period and
 * been promoted into the needs-attention group. */
const STATUS = {
  7: { label: "Exception", tone: "alert", rank: 0, needsAction: true },
  6: { label: "Failed attempt", tone: "alert", rank: 1, needsAction: true },
  3: { label: "Ready to collect", tone: "warn", rank: 2, needsAction: true },
  4: { label: "Out for delivery", tone: "good", rank: 4, needsAction: false },
  2: { label: "In transit", tone: "normal", rank: 5, needsAction: false },
  8: { label: "Label created", tone: "dim", rank: 6, needsAction: false },
  5: { label: "Not found", tone: "dim", rank: 7, needsAction: false },
  0: { label: "Delivered", tone: "done", rank: 8, needsAction: false },
  1: { label: "Frozen", tone: "dim", rank: 9, needsAction: false, hidden: true }
};

/* A completed delivery whose date cannot be read at all. It keeps the
 * Delivered label — it did arrive — but is presented as abnormal and sorted
 * with the things worth noticing rather than with the ordinary completed
 * parcels. There is no delivered-at field beyond events[0].date, so its 48
 * hour window can never be evaluated; it leaves the display when the API stops
 * returning it. Dropping it instead would be a parcel vanishing in silence,
 * which on an unattended mirror is the worse failure. */
const DELIVERED_UNKNOWN_DATE = {
  label: "Delivered", tone: "warn", rank: 3, needsAction: true
};

/* Shown where the event time would go, so the gap is stated in the place the
 * reader is already looking for it. Never a fabricated clock time. */
const DATE_UNKNOWN = "Date unknown";

/* A marked delivery has no date to age out on, so it ages out on when this
 * module first saw it instead. Three days rather than the 48 hour window,
 * because that clock starts when the parcel appeared here rather than when it
 * actually arrived. This is a retention bound and nothing more: no value
 * derived from it is ever displayed or sorted on. */
const UNKNOWN_DATE_RETENTION_MS = 72 * MS_HOUR;

/* A status 5 old enough to be a typo rather than an unscanned label. */
const PROMOTED_NOT_FOUND = {
  label: "Not found", tone: "warn", rank: 3, needsAction: true
};

/* An unrecognised status code is shown rather than dropped — fail visible. */
const unknownStatus = (code) => ({
  label: code === null ? "Unknown" : `Status ${code}`,
  tone: "normal", rank: 5, needsAction: false
});

/* Number(null) and Number("") are both 0, which is "Delivered" — a missing
 * status would be silently swallowed by the 48 hour window. Only accept a
 * value that really is an integer. */
const statusCodeOf = (raw) => {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
};

const CONFIG_DEFAULTS = Object.freeze({
  apiKeyEnvVar: "PARCEL_API_KEY",
  updateInterval: 20 * MS_MINUTE,
  maxItems: 6,
  deliveredWindowHours: 48,
  notFoundGraceHours: 24,
  showCarrier: true,
  showExpectedDate: true,
  hideWhenEmpty: true,
  fadePoint: 0.4
});

/* The API allows 20 requests/hour. Five minutes (12/hour) is the fastest we
 * will ever poll, and the responses are server-cached anyway. */
const MIN_UPDATE_INTERVAL = 5 * MS_MINUTE;

const NOOP_LOGGER = { warn: () => {}, error: () => {}, info: () => {} };

/* -------------------------------------------------------------------------
 * Date parsing
 *
 * Event dates arrive in at least five carrier-specific formats. Detect by
 * shape, never by carrier_code — we will meet carriers not in the sample.
 * Returns null when nothing matches; the caller logs the unmatched string.
 *
 * matchEventDate also reports whether the string carried a time at all, so a
 * date with no time is never rendered as a fabricated midnight. parseEventDate
 * is the plain Date-or-null form.
 * ---------------------------------------------------------------------- */
/* Clock components are checked as written rather than by seeing whether the
 * constructed Date comes back unchanged. 10:99 rolls quietly into the next
 * hour, so rollover cannot be used to detect it; and checking the resulting
 * local hour would wrongly reject a legitimate time on the day a clock change
 * skips it. Ranges only, before anything is constructed. */
const validClock = (hours, minutes, seconds, meridiem) => {
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return false;
  if (minutes < 0 || minutes > 59) return false;
  if (seconds !== null
    && (!Number.isInteger(seconds) || seconds < 0 || seconds > 59)) return false;
  return meridiem
    ? hours >= 1 && hours <= 12          // 12-hour clock has no hour 0 or 13
    : hours >= 0 && hours <= 23;
};

/* Every pattern is anchored at both ends: an otherwise valid date followed by
 * something we do not understand is a format we have not met, and guessing at
 * it is worse than logging it and showing the row without a time. */
const matchEventDate = (raw, now = new Date()) => {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (s === "" || s === NO_DATE) return null;   // Amazon: no date available

  let m;
  const found = (date, hasTime) => (date ? { date, hasTime } : null);
  const num = (value) => (value === undefined ? null : Number(value));

  // 11.08.2026 10:07 — Deutsche Post / An Post. Day first: never hand this to
  // new Date(), which reads it as 8 November.
  if ((m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/))) {
    const hasTime = m[4] !== undefined;
    const hours = hasTime ? +m[4] : 0;
    const minutes = hasTime ? +m[5] : 0;
    if (hasTime && !validClock(hours, minutes, num(m[6]), null)) return null;
    return found(build(+m[3], +m[2] - 1, +m[1], hours, minutes), hasTime);
  }

  // 2026-08-13 06:22 — UPS. The optional seconds also cover date_expected,
  // which arrives as 2026-08-25 00:00:00, and the fractional part covers FedEx,
  // which sends 2026-08-16 19:00:59.208. Seen in live data, not invented: the
  // millisecond is discarded, but rejecting the whole timestamp over it would
  // lose a real event time.
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[\sT]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/))) {
    const hasTime = m[4] !== undefined;
    const hours = hasTime ? +m[4] : 0;
    const minutes = hasTime ? +m[5] : 0;
    if (hasTime && !validClock(hours, minutes, num(m[6]), null)) return null;
    return found(build(+m[1], +m[2] - 1, +m[3], hours, minutes), hasTime);
  }

  // August 12, 2026 22:47 — FedEx. Parsed here rather than by the engine, so
  // that the clock is validated the same way as every other shape.
  if ((m = s.match(
    /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i
  ))) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month === undefined) return null;
    const hasTime = m[4] !== undefined;
    let hours = hasTime ? +m[4] : 0;
    const minutes = hasTime ? +m[5] : 0;
    if (hasTime && !validClock(hours, minutes, num(m[6]), m[7])) return null;
    if (m[7]) {
      hours %= 12;
      if (/pm/i.test(m[7])) hours += 12;
    }
    return found(build(+m[3], month, +m[2], hours, minutes), hasTime);
  }

  // Monday, August 24 5:00 PM | Monday, August 24 — Amazon Logistics. No year.
  if ((m = s.match(
    /^[A-Za-z]+,\s+([A-Za-z]+)\s+(\d{1,2})(?:\s+(\d{1,2}):(\d{2})\s*(AM|PM)?)?$/i
  ))) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month === undefined) return null;
    const hasTime = m[3] !== undefined;
    let hours = hasTime ? +m[3] : 0;
    const minutes = hasTime ? +m[4] : 0;
    if (hasTime && !validClock(hours, minutes, null, m[5])) return null;
    if (m[5]) {                                  // 12-hour clock
      hours %= 12;
      if (/pm/i.test(m[5])) hours += 12;
    }
    const day = +m[2];
    let d = build(now.getFullYear(), month, day, hours, minutes);
    // The year has to be inferred. Assuming "this year" is right for eleven
    // months and catastrophically wrong every January, when a late-December
    // event would read as eleven months in the future.
    if (d && d - now > 7 * MS_DAY) d = build(now.getFullYear() - 1, month, day, hours, minutes);
    return found(d, hasTime);
  }

  return null;
};

const parseEventDate = (raw, now = new Date()) => {
  const match = matchEventDate(raw, now);
  return match ? match.date : null;
};

const build = (year, month, day, hours, minutes) => {
  const d = new Date(year, month, day, hours, minutes, 0, 0);
  // new Date(y, m, ...) maps years 0-99 onto 1900-1999. Nothing should ever
  // send a two-digit year, but be explicit rather than silently wrong.
  if (year >= 0 && year < 100) d.setFullYear(year);
  if (isNaN(d.getTime())) return null;
  // It also rolls out-of-range components over rather than rejecting them, so
  // "32.13.2026" would quietly become 1 February 2027. A garbage date must come
  // back as null and be logged, not as a plausible wrong one. The hour is left
  // unchecked so that a clock change on the day still parses.
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day)
    return null;
  return d;
};

/* -------------------------------------------------------------------------
 * Formatting
 * ---------------------------------------------------------------------- */
const pad2 = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const isSameDay = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/* Absolute rather than relative ("3h ago"), because the helper formats once per
 * poll and a relative string would rot between polls. */
const formatEventTime = (d, now, hasTime = true) => {
  if (!d) return null;
  const withinWeek = Math.abs(d - now) < 7 * MS_DAY;
  const dayAndMonth = `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  // Amazon's "Monday, August 24" carries no time. Rendering it as 00:00 would
  // assert a midnight scan the carrier never reported, and would be
  // indistinguishable from a real one.
  if (!hasTime) return withinWeek ? WEEKDAYS_SHORT[d.getDay()] : dayAndMonth;
  if (isSameDay(d, now)) return hhmm(d);
  if (withinWeek) return `${WEEKDAYS_SHORT[d.getDay()]} ${hhmm(d)}`;
  return dayAndMonth;
};

/* Amazon titles arrive already cut with a U+2026 baked in, and the full text
 * is not recoverable from the API. Never append a second ellipsis. This is the
 * single place descriptions are handled, so a privacy filter can be added here
 * later without restructuring. */
const formatDescription = (raw) => {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "(no description)";
  if (text.length <= MAX_DESCRIPTION) return text;
  // Leave room for the ellipsis, so the result is never longer than the cap.
  const cut = text.slice(0, MAX_DESCRIPTION - 1).trimEnd();
  if (cut.endsWith(ELLIPSIS)) return cut;
  return cut.replace(/[\s.,;:!?\-–—]+$/, "") + ELLIPSIS;
};

const formatErrorMessage = (raw) => {
  const text = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "Parcel: unknown error";
  return text.length <= MAX_ERROR_MESSAGE
    ? text
    : text.slice(0, MAX_ERROR_MESSAGE).trimEnd() + ELLIPSIS;
};

/* Expected delivery. Prefer timestamp_expected (epoch, UTC) — it and
 * date_expected (local time, no zone) disagree in the wild. */
const buildExpected = (delivery, now) => {
  const epoch = (v) =>
    typeof v === "number" && isFinite(v) && v > 0 ? new Date(v * 1000) : null;

  const start = epoch(delivery.timestamp_expected)
    || parseEventDate(delivery.date_expected, now);
  if (!start) return null;

  const end = epoch(delivery.timestamp_expected_end)
    || parseEventDate(delivery.date_expected_end, now);

  // 00:00:00 means the carrier gave a date but no time. Render "Monday", never
  // "Monday 12:00am". That is a property of the delivery, so it holds even when
  // timestamp_expected is also present and supplied the instant above — the day
  // itself comes from date_expected, which is the field carrying the intent.
  if (/\s00:00:00\s*$/.test(String(delivery.date_expected ?? "")))
    return WEEKDAYS[(parseEventDate(delivery.date_expected, now) || start).getDay()];

  const head = `${WEEKDAYS_SHORT[start.getDay()]} ${hhmm(start)}`;
  if (!end || end <= start) return head;
  return isSameDay(start, end)
    ? `${head}${EN_DASH}${hhmm(end)}`
    : `${head} ${EN_DASH} ${WEEKDAYS_SHORT[end.getDay()]} ${hhmm(end)}`;
};

/* -------------------------------------------------------------------------
 * Config
 * ---------------------------------------------------------------------- */
/* Readable enough for a log line the user has to act on. */
const describeValue = (value) => {
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  if (Array.isArray(value)) return "an array";
  if (value !== null && typeof value === "object") return "an object";
  return String(value);
};

const normaliseConfig = (raw = {}, logger = NOOP_LOGGER) => {
  const config = { ...CONFIG_DEFAULTS, ...(raw || {}) };

  const num = (key, { min, max, integer = false }) => {
    let value = Number(config[key]);
    if (!isFinite(value)) {
      logger.warn(`[MMM-ParcelApp] ${key} is not a number, using ${CONFIG_DEFAULTS[key]}`);
      value = CONFIG_DEFAULTS[key];
    }
    if (integer) value = Math.round(value);
    if (min !== undefined && value < min) {
      logger.warn(`[MMM-ParcelApp] ${key} of ${config[key]} is below the minimum, clamping to ${min}`);
      value = min;
    }
    if (max !== undefined && value > max) {
      logger.warn(`[MMM-ParcelApp] ${key} of ${config[key]} is above the maximum, clamping to ${max}`);
      value = max;
    }
    config[key] = value;
  };

  // Clamped, not rejected: a too-fast interval would breach the 20 req/hour
  // rate limit, and the responses are server-cached so it would gain nothing.
  num("updateInterval", { min: MIN_UPDATE_INTERVAL, max: 24 * MS_HOUR });
  num("maxItems", { min: 1, max: 50, integer: true });
  num("deliveredWindowHours", { min: 0, max: 24 * 30 });
  num("notFoundGraceHours", { min: 0, max: 24 * 30 });
  num("fadePoint", { min: 0, max: 1 });

  // Boolean("false") is true, so a quoted boolean in config.js would silently
  // mean the opposite of what it reads like. Accept only real booleans and say
  // so; no truthy/falsy coercion of any kind.
  for (const key of ["showCarrier", "showExpectedDate", "hideWhenEmpty"]) {
    if (typeof config[key] === "boolean") continue;
    logger.warn(`[MMM-ParcelApp] ${key} must be true or false, not ${describeValue(config[key])}; using ${CONFIG_DEFAULTS[key]}`);
    config[key] = CONFIG_DEFAULTS[key];
  }

  if (typeof config.apiKeyEnvVar !== "string" || !config.apiKeyEnvVar.trim()) {
    logger.warn(`[MMM-ParcelApp] apiKeyEnvVar is not set, using ${CONFIG_DEFAULTS.apiKeyEnvVar}`);
    config.apiKeyEnvVar = CONFIG_DEFAULTS.apiKeyEnvVar;
  }
  config.apiKeyEnvVar = config.apiKeyEnvVar.trim();

  return config;
};

/* -------------------------------------------------------------------------
 * Carrier names
 * ---------------------------------------------------------------------- */
/* The live map is {"ups": {"name": "UPS"}, ...}. Tolerate the other plausible
 * shapes too — this file is fetched daily and we do not control it. */
const normaliseCarrierMap = (json) => {
  const map = {};
  const add = (code, name) => {
    if (typeof code === "string" && typeof name === "string" && code && name)
      map[code.toLowerCase()] = name;
  };

  if (Array.isArray(json)) {
    for (const entry of json)
      if (entry && typeof entry === "object")
        add(entry.code ?? entry.carrier_code ?? entry.id, entry.name ?? entry.title);
  } else if (json && typeof json === "object") {
    const root = json.carriers && typeof json.carriers === "object" ? json.carriers : json;
    if (Array.isArray(root)) return normaliseCarrierMap(root);
    for (const [code, value] of Object.entries(root)) {
      if (typeof value === "string") add(code, value);
      else if (value && typeof value === "object") add(code, value.name ?? value.title);
    }
  }
  return map;
};

/* The published map has 300+ carriers. A handful of keys means this is not a
 * carrier map at all — an error envelope, a CDN error page served as JSON, a
 * changed endpoint — and normaliseCarrierMap is shape-only, so it would accept
 * any object of strings quite happily. Caching one would leave the mirror
 * showing raw codes for a week. Rejecting early and falling back to raw codes
 * immediately is the cheaper mistake, and it self-heals on the next refresh. */
const MIN_CARRIERS = 20;

const isPlausibleCarrierMap = (raw, map) => {
  if (raw && typeof raw === "object" && !Array.isArray(raw)
    && ("success" in raw || "error_message" in raw)) return false;
  return Object.keys(map || {}).length >= MIN_CARRIERS;
};

const carrierName = (code, carriers) => {
  if (typeof code !== "string" || !code.trim()) return null;
  const key = code.trim().toLowerCase();
  return (carriers && carriers[key]) || code.trim();   // fall back to raw code
};

/* -------------------------------------------------------------------------
 * The main normalisation pass
 * ---------------------------------------------------------------------- */
const buildDeliveries = (data, {
  now = new Date(),
  config = CONFIG_DEFAULTS,
  carriers = {},
  firstSeen = new Map(),
  logger = NOOP_LOGGER
} = {}) => {
  // Documented as always present; observed as null on an empty account. This
  // is the module's most common steady state, so normalise before anything
  // else touches it.
  const raw = data && Array.isArray(data.deliveries) ? data.deliveries : [];

  const deliveredWindowMs = config.deliveredWindowHours * MS_HOUR;
  const notFoundGraceMs = config.notFoundGraceHours * MS_HOUR;
  const nowMs = now.getTime();
  const seenKeys = new Set();
  const items = [];

  raw.forEach((delivery, index) => {
    if (!delivery || typeof delivery !== "object") return;

    const code = statusCodeOf(delivery.status_code);
    const known = code !== null && STATUS[code];
    if (known && known.hidden) return;             // status 1: hide entirely

    const key = typeof delivery.tracking_number === "string" && delivery.tracking_number
      ? delivery.tracking_number
      : `index-${index}`;
    // A duplicate tracking number would otherwise share a first-seen clock.
    const uniqueKey = seenKeys.has(key) ? `${key}#${index}` : key;
    seenKeys.add(uniqueKey);

    if (!firstSeen.has(uniqueKey)) firstSeen.set(uniqueKey, nowMs);
    const firstSeenMs = firstSeen.get(uniqueKey);

    const events = Array.isArray(delivery.events) ? delivery.events : [];
    const latest = events[0] && typeof events[0] === "object" ? events[0] : null;
    const rawDate = latest && typeof latest.date === "string" ? latest.date : null;
    const match = matchEventDate(rawDate, now);
    const eventDate = match ? match.date : null;
    if (rawDate && rawDate.trim() && rawDate.trim() !== NO_DATE && !eventDate) {
      // Never log the delivery object itself — extra_information lives there.
      logger.warn(`[MMM-ParcelApp] unrecognised event date format: ${JSON.stringify(rawDate)} (carrier ${delivery.carrier_code})`);
    }

    let status = known || unknownStatus(code);
    let dateUnknown = false;

    if (code === 0) {
      // The only source for "when did it arrive" is events[0].date.
      if (eventDate) {
        if (nowMs - eventDate.getTime() > deliveredWindowMs) return;
      } else {
        // No date means the 48 hour window cannot be evaluated. Say so on the
        // row rather than removing the parcel — and never invent a time to
        // stand in for the one the carrier did not give us. It goes once it
        // has been on screen for three days, measured from when it was first
        // seen, so an unreadable date cannot hold an attention slot forever.
        if (nowMs - firstSeenMs > UNKNOWN_DATE_RETENTION_MS) return;
        logger.warn(`[MMM-ParcelApp] a completed delivery has no readable date; showing it with the date marked unknown (carrier ${delivery.carrier_code})`);
        status = DELIVERED_UNKNOWN_DATE;
        dateUnknown = true;
      }
    }

    if (code === 5) {
      // "Not found" is normal for the first hours after adding a parcel. A
      // persistent one is usually a typo'd tracking number, so promote it into
      // the needs-attention group rather than letting it stay dim forever.
      const anchor = eventDate ? eventDate.getTime() : firstSeenMs;
      if (nowMs - anchor >= notFoundGraceMs) status = PROMOTED_NOT_FOUND;
    }

    items.push({
      key: uniqueKey,
      statusCode: code,
      statusLabel: status.label,
      tone: status.tone,
      needsAction: status.needsAction,
      rank: status.rank,
      description: formatDescription(delivery.description),
      carrier: config.showCarrier ? carrierName(delivery.carrier_code, carriers) : null,
      event: latest && typeof latest.event === "string" && latest.event.trim()
        ? latest.event.trim()
        : null,
      // Null when the date was "--//--" or unparseable: an in-flight parcel is
      // shown without a timestamp rather than dropped. A completed one says so
      // outright, because for it the missing date is the whole story.
      eventTime: dateUnknown
        ? DATE_UNKNOWN
        : formatEventTime(eventDate, now, match ? match.hasTime : true),
      dateUnknown,
      expected: config.showExpectedDate && code !== 0 ? buildExpected(delivery, now) : null,
      sortTime: eventDate ? eventDate.getTime() : null,
      collapsed: false
    });
  });

  // Rank first, then freshest news, then key so the order is deterministic.
  items.sort((a, b) =>
    a.rank - b.rank
    || (b.sortTime ?? -Infinity) - (a.sortTime ?? -Infinity)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const collapsed = collapseLabelCreated(items);
  const total = collapsed.length;
  return { items: collapsed.slice(0, config.maxItems), total };
};

/* The Parcel app auto-adds every Amazon order, so status 8 dominates. Five
 * identical "Preparing for shipment" rows would push everything that matters
 * off a six-item display. */
const collapseLabelCreated = (items) => {
  const indexes = [];
  items.forEach((item, i) => { if (item.statusCode === 8) indexes.push(i); });
  if (indexes.length < 2) return items;

  const first = indexes[0];
  const rest = items.filter((item) => item.statusCode !== 8);
  const summary = {
    key: "__collapsed_label_created__",
    statusCode: 8,
    statusLabel: null,
    tone: "dim",
    needsAction: false,
    rank: STATUS[8].rank,
    // Not "N more": every status 8 row has been removed, so there is no
    // visible item for the summary to be "more" than.
    description: `${indexes.length} preparing for shipment`,
    carrier: null,
    event: null,
    eventTime: null,
    expected: null,
    dateUnknown: false,
    sortTime: null,
    collapsed: true
  };
  rest.splice(Math.min(first, rest.length), 0, summary);
  return rest;
};

module.exports = {
  parseEventDate,
  formatEventTime,
  formatDescription,
  formatErrorMessage,
  buildExpected,
  buildDeliveries,
  normaliseConfig,
  normaliseCarrierMap,
  isPlausibleCarrierMap,
  carrierName,
  MIN_CARRIERS,
  CONFIG_DEFAULTS,
  MIN_UPDATE_INTERVAL,
  MS_MINUTE,
  MS_HOUR,
  MS_DAY
};
