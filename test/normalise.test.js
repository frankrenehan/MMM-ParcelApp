"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { secretsIn } = require("./fixture.js");
const {
  buildDeliveries,
  normaliseConfig,
  normaliseCarrierMap,
  CONFIG_DEFAULTS,
  MIN_UPDATE_INTERVAL,
  MS_HOUR
} = require("../parcel-data.js");

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const NOW = at(2026, 8, 24, 20, 0);       // Monday, matching the fixture

const CARRIERS = { amzlus: "Amazon US", ups: "UPS", dp: "Deutsche Post" };

const build = (data, overrides = {}) => buildDeliveries(data, {
  now: overrides.now || NOW,
  config: normaliseConfig({ ...CONFIG_DEFAULTS, ...(overrides.config || {}) }),
  carriers: CARRIERS,
  firstSeen: overrides.firstSeen || new Map(),
  logger: overrides.logger || { warn: () => {}, error: () => {}, info: () => {} }
});

/* An event date that parses to exactly `hoursAgo` before NOW, in the ISO-like
 * shape so the test does not depend on the year-less inference. */
const eventAgo = (hoursAgo, now = NOW) => {
  const d = new Date(now.getTime() - hoursAgo * MS_HOUR);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const delivery = (over = {}) => ({
  carrier_code: "ups",
  description: "A parcel",
  status_code: 2,
  tracking_number: "TRACK1",
  events: [{ event: "Arrived at Facility", date: eventAgo(1) }],
  ...over
});

/* ---------------------------------------------------------------------- */

test("deliveries: null hides everything without throwing", () => {
  // Documented as always present; observed as null on an empty account, which
  // is this module's most common steady state.
  const result = build({ success: true, deliveries: null });
  assert.deepEqual(result.items, []);
  assert.equal(result.total, 0);
});

test("missing, empty and malformed payloads are survivable", () => {
  for (const payload of [undefined, null, {}, { success: true },
    { success: true, deliveries: [] }, { success: true, deliveries: "nope" },
    { success: true, deliveries: [null, 42, "x"] }])
    assert.deepEqual(build(payload).items, [], JSON.stringify(payload));
});

test("status 1 (frozen) never appears", () => {
  const result = build({ deliveries: [
    delivery({ status_code: 1, tracking_number: "FROZEN" }),
    delivery({ status_code: 2, tracking_number: "LIVE" })
  ] });
  assert.deepEqual(result.items.map((i) => i.key), ["LIVE"]);
});

test("a delivered parcel is shown at 47 hours and gone at 49", () => {
  const shown = build({ deliveries: [delivery({
    status_code: 0,
    events: [{ event: "Delivered", date: eventAgo(47) }]
  })] });
  assert.equal(shown.items.length, 1);
  assert.equal(shown.items[0].statusLabel, "Delivered");

  const gone = build({ deliveries: [delivery({
    status_code: 0,
    events: [{ event: "Delivered", date: eventAgo(49) }]
  })] });
  assert.deepEqual(gone.items, []);
});

test("a delivered parcel with an unreadable date stays visible, marked", () => {
  // Its 48 hour window can never be evaluated — there is no delivered-at field
  // beyond events[0].date — but a parcel that vanishes in silence is the worse
  // failure on an unattended display. It says what it does not know instead.
  const warnings = [];
  const result = build({ deliveries: [delivery({
    status_code: 0,
    events: [{ event: "Delivered", date: "sometime last Tuesday" }]
  })] }, { logger: { warn: (m) => warnings.push(m), error: () => {}, info: () => {} } });

  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.statusLabel, "Delivered", "it did arrive");
  assert.equal(item.eventTime, "Date unknown");
  assert.equal(item.dateUnknown, true);
  assert.ok(warnings.some((w) => w.includes("unrecognised event date format")));
  assert.ok(warnings.some((w) => w.includes("date marked unknown")));
  // And the log never carries the delivery object itself.
  assert.ok(!warnings.some((w) => w.includes("extra_information")));
});

test("a delivered parcel with no events at all is treated the same way", () => {
  const result = build({ deliveries: [delivery({ status_code: 0, events: [] })] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].eventTime, "Date unknown");
  assert.equal(result.items[0].dateUnknown, true);
  assert.equal(result.items[0].statusLabel, "Delivered");
});

test("an unreadable delivered date never becomes a fabricated time", () => {
  for (const date of ["sometime last Tuesday", "--//--", "", "2026-08-13 06:99",
    "11.08.2026 10:07 junk", "32.13.2026 10:00"]) {
    const label = JSON.stringify(date);
    const result = build({ deliveries: [delivery({
      status_code: 0, events: [{ event: "Delivered", date }]
    })] });
    assert.equal(result.items.length, 1, label);
    assert.equal(result.items[0].eventTime, "Date unknown", label);
    assert.equal(result.items[0].sortTime, null, label);
    assert.ok(!/\d{1,2}:\d{2}/.test(result.items[0].eventTime), label);
  }
});

test("a marked delivered parcel is distinguishable from an ordinary one", () => {
  const result = build({ deliveries: [
    delivery({ status_code: 0, tracking_number: "GOOD", description: "Knew when",
      events: [{ event: "Delivered", date: eventAgo(3) }] }),
    delivery({ status_code: 0, tracking_number: "BAD", description: "Did not",
      events: [{ event: "Delivered", date: "sometime last Tuesday" }] })
  ] }, { config: { maxItems: 10 } });

  const byKey = Object.fromEntries(result.items.map((i) => [i.key, i]));
  assert.equal(byKey.GOOD.tone, "done");
  assert.equal(byKey.GOOD.needsAction, false);
  assert.equal(byKey.GOOD.dateUnknown, false);

  assert.equal(byKey.BAD.tone, "warn", "an abnormal tone, not the completed one");
  assert.equal(byKey.BAD.needsAction, true);
  assert.notEqual(byKey.BAD.tone, byKey.GOOD.tone);

  // And it sorts with the things worth noticing, so maxItems cannot quietly
  // truncate it away behind a pile of routine rows.
  assert.deepEqual(result.items.map((i) => i.key), ["BAD", "GOOD"]);
});

test("a marked delivery leaves after three days on screen", () => {
  // It has no date to age out on, so it ages out on when it was first seen.
  const after = (hours) => {
    const firstSeen = new Map([["TRACK1", NOW.getTime() - hours * MS_HOUR]]);
    return build({ deliveries: [delivery({
      status_code: 0, events: [{ event: "Delivered", date: "sometime last Tuesday" }]
    })] }, { firstSeen });
  };

  assert.equal(after(0).items.length, 1, "just seen");
  assert.equal(after(71).items.length, 1, "still inside three days");
  assert.equal(after(73).items.length, 0, "and gone after them");

  // The same bound applies when there are no events at all.
  const stale = new Map([["TRACK1", NOW.getTime() - 100 * MS_HOUR]]);
  assert.equal(build({ deliveries: [delivery({ status_code: 0, events: [] })] },
    { firstSeen: stale }).items.length, 0);

  // Nothing derived from that clock is ever displayed as a time.
  assert.equal(after(50).items[0].eventTime, "Date unknown");
  assert.equal(after(50).items[0].sortTime, null);
});

test("a readable delivered date still obeys the 48 hour window exactly", () => {
  // The relaxation must not leak into deliveries whose dates can be evaluated.
  const at = (hours) => build({ deliveries: [delivery({
    status_code: 0, events: [{ event: "Delivered", date: eventAgo(hours) }]
  })] });
  assert.equal(at(47).items.length, 1);
  assert.equal(at(49).items.length, 0);
  assert.equal(at(200).items.length, 0);
});

test("an in-flight parcel with an unparseable date is shown without a time", () => {
  // Fail visible: never drop a parcel because its date was odd.
  const result = build({ deliveries: [delivery({
    events: [{ event: "In transit", date: "--//--" }]
  })] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].eventTime, null);
  assert.equal(result.items[0].event, "In transit");
});

test("multiple status 8 items collapse into one summary row", () => {
  const deliveries = [];
  for (let i = 0; i < 5; i += 1)
    deliveries.push(delivery({
      status_code: 8, tracking_number: `AMZ${i}`, carrier_code: "amzlus",
      events: [{ event: "Preparing for shipment", date: "--//--" }]
    }));
  deliveries.push(delivery({ status_code: 2, tracking_number: "REAL" }));

  const result = build({ deliveries });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].key, "REAL");
  assert.equal(result.items[1].description, "5 preparing for shipment");
  assert.equal(result.items[1].collapsed, true);
  assert.equal(result.items[1].tone, "dim");
  assert.equal(result.items[1].statusLabel, null);
});

test("a single status 8 item is rendered normally", () => {
  const result = build({ deliveries: [delivery({
    status_code: 8, events: [{ event: "Preparing for shipment", date: "--//--" }]
  })] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].collapsed, false);
  assert.equal(result.items[0].statusLabel, "Label created");
});

test("the collapsed row counts against maxItems as a single row", () => {
  const deliveries = [];
  for (let i = 0; i < 4; i += 1)
    deliveries.push(delivery({ status_code: 2, tracking_number: `T${i}`,
      events: [{ event: "In transit", date: eventAgo(i + 1) }] }));
  for (let i = 0; i < 6; i += 1)
    deliveries.push(delivery({ status_code: 8, tracking_number: `A${i}`,
      events: [{ event: "Preparing for shipment", date: "--//--" }] }));

  const result = build({ deliveries }, { config: { maxItems: 5 } });
  assert.equal(result.items.length, 5);
  assert.equal(result.items[4].description, "6 preparing for shipment");
  assert.equal(result.total, 5);
});

test("status 5 is dim inside the grace period and promoted after it", () => {
  const fresh = build({ deliveries: [delivery({
    status_code: 5, events: [{ event: "No information", date: eventAgo(3) }]
  })] });
  assert.equal(fresh.items[0].tone, "dim");
  assert.equal(fresh.items[0].needsAction, false);

  const stale = build({ deliveries: [delivery({
    status_code: 5, events: [{ event: "No information", date: eventAgo(25) }]
  })] });
  assert.equal(stale.items[0].tone, "warn");
  assert.equal(stale.items[0].needsAction, true);
  assert.equal(stale.items[0].statusLabel, "Not found");
});

test("status 5 with no events ages from when it was first seen", () => {
  const firstSeen = new Map([["TRACK1", NOW.getTime() - 30 * MS_HOUR]]);
  const result = build({ deliveries: [delivery({ status_code: 5, events: [] })] },
    { firstSeen });
  assert.equal(result.items[0].needsAction, true);

  const justAdded = build({ deliveries: [delivery({ status_code: 5, events: [] })] });
  assert.equal(justAdded.items[0].needsAction, false);
});

test("needs-action states sort above the informational ones", () => {
  const codes = [0, 8, 2, 4, 3, 6, 7];
  const result = build({ deliveries: codes.map((code) => delivery({
    status_code: code,
    tracking_number: `S${code}`,
    events: [{ event: "Event", date: eventAgo(1) }]
  })) }, { config: { maxItems: 20 } });

  assert.deepEqual(result.items.map((i) => i.statusCode), [7, 6, 3, 4, 2, 8, 0]);
  assert.deepEqual(result.items.map((i) => i.needsAction),
    [true, true, true, false, false, false, false]);
});

test("a promoted status 5 sorts into the needs-action group", () => {
  const result = build({ deliveries: [
    delivery({ status_code: 2, tracking_number: "TRANSIT" }),
    delivery({ status_code: 5, tracking_number: "TYPO",
      events: [{ event: "No information", date: eventAgo(48) }] }),
    delivery({ status_code: 3, tracking_number: "PICKUP" })
  ] });
  assert.deepEqual(result.items.map((i) => i.key), ["PICKUP", "TYPO", "TRANSIT"]);
});

test("an unknown status code is shown rather than dropped", () => {
  const result = build({ deliveries: [delivery({ status_code: 99 })] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].statusLabel, "Status 99");
});

test("extra_information never reaches the rendered output", () => {
  const secret = "AA1 1AA someone@example.com";
  const result = build({ deliveries: [
    delivery({ extra_information: secret }),
    delivery({ tracking_number: "T2", status_code: 8, extra_information: secret }),
    delivery({ tracking_number: "T3", status_code: 8, extra_information: secret })
  ] });
  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(secret));
  assert.ok(!serialised.includes("extra_information"));
});

test("descriptions are truncated without doubling the ellipsis", () => {
  // Already cut by Amazon at 50 characters, trailing U+2026 included.
  const preTruncated = "Stainless Steel Water Bottle with Straw Lid, 32 o…";
  const result = build({ deliveries: [
    delivery({ description: preTruncated }),
    delivery({ tracking_number: "T2",
      description: "A very long description indeed that keeps on going well past the limit" }),
    delivery({ tracking_number: "T3", description: "   " })
  ] }, { config: { maxItems: 10 } });

  const descriptions = result.items.map((i) => i.description);
  for (const text of descriptions) {
    assert.ok(!text.includes("……"), `doubled ellipsis in ${text}`);
    assert.ok(text.length <= 60, `too long: ${text}`);
  }
  assert.equal(descriptions.includes("(no description)"), true);
  // A source-truncated title is passed through, not re-cut.
  assert.ok(descriptions.includes(preTruncated));
});

test("carrier codes resolve to names and fall back to the raw code", () => {
  const result = build({ deliveries: [
    delivery({ carrier_code: "dp", tracking_number: "T1" }),
    delivery({ carrier_code: "neverheardofit", tracking_number: "T2" })
  ] });
  const byKey = Object.fromEntries(result.items.map((i) => [i.key, i.carrier]));
  assert.equal(byKey.T1, "Deutsche Post");
  assert.equal(byKey.T2, "neverheardofit");
});

test("showCarrier and showExpectedDate switch fields off", () => {
  const result = build({ deliveries: [delivery({
    date_expected: "2026-08-26 13:15:00"
  })] }, { config: { showCarrier: false, showExpectedDate: false } });
  assert.equal(result.items[0].carrier, null);
  assert.equal(result.items[0].expected, null);
});

test("expected delivery: windows, date-only and epoch precedence", () => {
  const result = build({ deliveries: [
    delivery({ tracking_number: "WINDOW", date_expected: "2026-08-26 13:15:00",
      date_expected_end: "2026-08-26 16:15:00" }),
    delivery({ tracking_number: "DATEONLY", date_expected: "2026-08-25 00:00:00" }),
    delivery({ tracking_number: "NONE" })
  ] }, { config: { maxItems: 10 } });

  const byKey = Object.fromEntries(result.items.map((i) => [i.key, i.expected]));
  assert.equal(byKey.WINDOW, "Wed 13:15–16:15");
  assert.equal(byKey.DATEONLY, "Tuesday");     // never "Tuesday 12:00am"
  assert.equal(byKey.NONE, null);

  // timestamp_expected is epoch UTC and wins over the zone-less local string.
  const epoch = Math.floor(at(2026, 8, 26, 9, 30).getTime() / 1000);
  const preferred = build({ deliveries: [delivery({
    timestamp_expected: epoch, date_expected: "2026-08-26 05:30:00"
  })] });
  assert.equal(preferred.items[0].expected, "Wed 09:30");
});

test("expected delivery is suppressed once the parcel has arrived", () => {
  const result = build({ deliveries: [delivery({
    status_code: 0, date_expected: "2026-08-26 13:15:00",
    events: [{ event: "Delivered", date: eventAgo(2) }]
  })] });
  assert.equal(result.items[0].expected, null);
});

test("event times are absolute, so they cannot rot between polls", () => {
  const result = build({ deliveries: [
    delivery({ tracking_number: "TODAY",
      events: [{ event: "Scan", date: "2026-08-24 18:44" }] }),
    delivery({ tracking_number: "YESTERDAY",
      events: [{ event: "Scan", date: "2026-08-23 09:05" }] }),
    delivery({ tracking_number: "OLD",
      events: [{ event: "Scan", date: "2026-07-02 09:05" }] })
  ] }, { config: { maxItems: 10 } });

  const byKey = Object.fromEntries(result.items.map((i) => [i.key, i.eventTime]));
  assert.equal(byKey.TODAY, "18:44");
  assert.equal(byKey.YESTERDAY, "Sun 09:05");
  assert.equal(byKey.OLD, "2 Jul");
});

test("a date with no time never renders an invented clock time", () => {
  const result = build({ deliveries: [
    { carrier_code: "amzlus", description: "No time", status_code: 2,
      tracking_number: "NOTIME",
      events: [{ event: "Left the shipper facility", date: "Monday, August 24 " }] },
    { carrier_code: "ups", description: "Real midnight", status_code: 2,
      tracking_number: "MIDNIGHT",
      events: [{ event: "Scan", date: "2026-08-24 00:00" }] },
    { carrier_code: "dp", description: "Date only, old", status_code: 2,
      tracking_number: "OLD",
      events: [{ event: "Scan", date: "02.07.2026" }] }
  ] }, { config: { maxItems: 10 } });

  const byKey = Object.fromEntries(result.items.map((i) => [i.key, i.eventTime]));
  assert.equal(byKey.NOTIME, "Mon", "a weekday, not a fabricated midnight");
  assert.equal(byKey.MIDNIGHT, "00:00", "a real midnight scan still shows one");
  assert.equal(byKey.OLD, "2 Jul");

  // The two must stay distinguishable — that is the whole point.
  assert.notEqual(byKey.NOTIME, byKey.MIDNIGHT);
});

test("no date format invents a clock time when the source had none", () => {
  // One case per shape matchEventDate recognises. Each is dated the day before
  // NOW on purpose: a date more than a week out formats identically whether or
  // not it carried a time, so only a recent one can tell the two apart.
  const shapes = [
    { key: "DOTTED", bare: "23.08.2026", timed: "23.08.2026 14:05" },
    { key: "ISO", bare: "2026-08-23", timed: "2026-08-23 14:05" },
    { key: "USLONG", bare: "August 23, 2026", timed: "August 23, 2026 14:05" },
    { key: "AMAZON", bare: "Sunday, August 23 ", timed: "Sunday, August 23 2:05 PM" }
  ];

  const render = (pick) => {
    const result = build({ deliveries: shapes.map((shape) => delivery({
      tracking_number: shape.key,
      events: [{ event: "Scan", date: shape[pick] }]
    })) }, { config: { maxItems: 10 } });
    return Object.fromEntries(result.items.map((i) => [i.key, i.eventTime]));
  };

  const bare = render("bare");
  for (const shape of shapes)
    assert.equal(bare[shape.key], "Sun",
      `${shape.key} (${shape.bare}) invented a clock time`);

  // And the same shapes with a time still show it, so this is not just
  // throwing the time away everywhere.
  const timed = render("timed");
  for (const shape of shapes)
    assert.equal(timed[shape.key], "Sun 14:05",
      `${shape.key} (${shape.timed}) lost its time`);
});

test("a date-only expectation stays date-only even alongside an epoch", () => {
  // date_expected of 00:00:00 means the delivery is date-only. That is a
  // property of the delivery, not of which field happens to be present.
  const epoch = Math.floor(Date.UTC(2026, 7, 25, 0, 0) / 1000);
  const result = build({ deliveries: [
    { carrier_code: "amzlus", description: "Both fields", status_code: 2,
      tracking_number: "BOTH", date_expected: "2026-08-25 00:00:00",
      timestamp_expected: epoch, events: [] },
    { carrier_code: "amzlus", description: "String epoch", status_code: 2,
      tracking_number: "STR", date_expected: "2026-08-25 00:00:00",
      timestamp_expected: String(epoch), events: [] }
  ] }, { config: { maxItems: 10 } });

  for (const item of result.items)
    assert.equal(item.expected, "Tuesday", `${item.key} should not invent a time`);
});

test("a missing status code is shown, not silently taken for Delivered", () => {
  // Number(null) is 0, which is "Delivered" — the 48 hour window would then
  // swallow the parcel with no row and no warning.
  for (const status_code of [null, "", undefined, "nonsense", {}]) {
    const result = build({ deliveries: [delivery({
      status_code, tracking_number: "MYSTERY",
      events: [{ event: "Scan", date: eventAgo(107) }]
    })] });
    assert.equal(result.items.length, 1, `dropped for status_code ${JSON.stringify(status_code)}`);
    assert.equal(result.items[0].statusLabel, "Unknown");
    assert.equal(result.items[0].statusCode, null);
    // Informational, not an alarm: it sorts with the in-transit parcels and
    // does not claim the user has to do something about it.
    assert.equal(result.items[0].tone, "normal");
    assert.equal(result.items[0].rank, 5);
    assert.equal(result.items[0].needsAction, false);
  }

  // A numeric string is still a status code.
  const stringly = build({ deliveries: [delivery({ status_code: "7" })] });
  assert.equal(stringly.items[0].statusLabel, "Exception");
  assert.equal(stringly.items[0].needsAction, true);

  // And a string "1" is still frozen, so still hidden.
  assert.deepEqual(build({ deliveries: [delivery({ status_code: "1" })] }).items, []);
});

test("duplicate tracking numbers do not collide", () => {
  const result = build({ deliveries: [
    delivery({ tracking_number: "SAME" }),
    delivery({ tracking_number: "SAME" })
  ] });
  assert.equal(result.items.length, 2);
  assert.notEqual(result.items[0].key, result.items[1].key);
});

/* ---------------------------------------------------------------------- */

test("the sample response renders as expected", () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, "fixtures", "deliveries.json"), "utf8"));
  const result = build(fixture);

  assert.equal(result.items.length, 5, "three in transit, one summary, one delivered");
  assert.deepEqual(result.items.map((i) => i.description), [
    "Concert tickets",
    "Stainless Steel Water Bottle with Straw Lid, 32 o…",
    "Adjustable Laptop Stand for Desk – Ergonomic Alum…",
    "5 preparing for shipment",
    "Silicone Dish Drying Mat for Kitchen Counter, Lar…"
  ]);
  assert.deepEqual(result.items.map((i) => i.statusLabel),
    ["In transit", "In transit", "In transit", null, "Delivered"]);
  // "Monday, August 24 " carries no time, so no clock time is invented for it.
  assert.deepEqual(result.items.map((i) => i.eventTime),
    ["18:44", "Mon", "Mon", null, "17:00"]);
  assert.deepEqual(result.items.map((i) => i.expected),
    ["Wed 13:15–16:15", "Tuesday", "Tuesday", null, null]);
  assert.deepEqual(result.items.map((i) => i.carrier),
    ["UPS", "Amazon US", "Amazon US", null, "Amazon US"]);
  assert.equal(result.items.every((i) => i.needsAction === false), true);

  const serialised = JSON.stringify(result);
  for (const token of secretsIn(fixture).concat("extra_information"))
    assert.ok(!serialised.includes(token), `leaked ${token}`);
});

/* ---------------------------------------------------------------------- */

test("updateInterval is clamped rather than allowed to breach the rate limit", () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m), error: () => {}, info: () => {} };

  assert.equal(normaliseConfig({ updateInterval: 1000 }, logger).updateInterval,
    MIN_UPDATE_INTERVAL);
  assert.equal(normaliseConfig({ updateInterval: "nonsense" }, logger).updateInterval,
    CONFIG_DEFAULTS.updateInterval);
  assert.equal(normaliseConfig({ updateInterval: 30 * 60 * 1000 }).updateInterval,
    30 * 60 * 1000);
  assert.ok(warnings.length >= 2);
});

test("the rest of the config is validated too", () => {
  const config = normaliseConfig({
    maxItems: 0, fadePoint: 5, deliveredWindowHours: -3, apiKeyEnvVar: "  MY_KEY  ",
    hideWhenEmpty: "yes"
  });
  assert.equal(config.maxItems, 1);
  assert.equal(config.fadePoint, 1);
  assert.equal(config.deliveredWindowHours, 0);
  assert.equal(config.apiKeyEnvVar, "MY_KEY");
  assert.equal(config.hideWhenEmpty, true);

  assert.deepEqual(normaliseConfig(), CONFIG_DEFAULTS);
  assert.deepEqual(normaliseConfig(null), CONFIG_DEFAULTS);
});

test("boolean options accept only real booleans", () => {
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m), error: () => {}, info: () => {} };

  // Real booleans pass straight through, and say nothing.
  assert.equal(normaliseConfig({ showCarrier: false }, logger).showCarrier, false);
  assert.equal(normaliseConfig({ showCarrier: true }, logger).showCarrier, true);
  assert.equal(normaliseConfig({ hideWhenEmpty: false }, logger).hideWhenEmpty, false);
  assert.equal(normaliseConfig({ showExpectedDate: false }, logger).showExpectedDate, false);
  assert.equal(warnings.length, 0, "valid config is quiet");

  // Anything else is invalid: warn, and restore the documented default. All
  // three options default to true, so "restored to the default" and "coerced
  // to true" look alike for most inputs — 0 and "" are the ones that tell them
  // apart, since Boolean(0) and Boolean("") would both have been false.
  for (const value of ["false", "true", "yes", "", 0, 1, null, undefined, NaN, {}, []]) {
    warnings.length = 0;
    const config = normaliseConfig({ showCarrier: value }, logger);
    const label = `showCarrier: ${typeof value} ${JSON.stringify(value)}`;
    assert.equal(config.showCarrier, CONFIG_DEFAULTS.showCarrier, label);
    assert.equal(warnings.length, 1, `no warning for ${label}`);
    assert.ok(warnings[0].includes("showCarrier"), warnings[0]);
    assert.ok(warnings[0].includes("must be true or false"), warnings[0]);
  }

  // A quoted boolean is never read as the boolean it looks like.
  assert.equal(normaliseConfig({ showCarrier: "false" }, logger).showCarrier,
    CONFIG_DEFAULTS.showCarrier);
  assert.equal(normaliseConfig({ showCarrier: "true" }, logger).showCarrier,
    CONFIG_DEFAULTS.showCarrier);

  // Each option is judged on its own; one bad value does not taint the others.
  warnings.length = 0;
  const mixed = normaliseConfig(
    { showCarrier: "false", showExpectedDate: false, hideWhenEmpty: true }, logger);
  assert.equal(mixed.showCarrier, true);
  assert.equal(mixed.showExpectedDate, false);
  assert.equal(mixed.hideWhenEmpty, true);
  assert.equal(warnings.length, 1);

  // The warning names the offending value, so it can be found in config.js.
  assert.ok(warnings[0].includes('the string "false"'), warnings[0]);
});

test("the carrier map is read in whatever shape it arrives", () => {
  // Live shape, as of the last check.
  assert.deepEqual(normaliseCarrierMap({ ups: { name: "UPS" }, dp: { name: "Deutsche Post" } }),
    { ups: "UPS", dp: "Deutsche Post" });
  assert.deepEqual(normaliseCarrierMap({ ups: "UPS" }), { ups: "UPS" });
  assert.deepEqual(normaliseCarrierMap([{ code: "ups", name: "UPS" }]), { ups: "UPS" });
  assert.deepEqual(normaliseCarrierMap({ carriers: { ups: { name: "UPS" } } }), { ups: "UPS" });
  for (const junk of [null, undefined, "", 42, []])
    assert.deepEqual(normaliseCarrierMap(junk), {});
});
