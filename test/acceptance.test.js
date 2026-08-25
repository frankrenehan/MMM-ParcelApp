"use strict";

/* The nine acceptance criteria from the build brief, each walked end to end:
 * a canned API response goes into node_helper, the socket payload it emits
 * goes into the real frontend, and the assertions are made against the DOM
 * that comes out. No unit-level seams — this is the whole stack.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadDefinition } = require("./node-helper-stub.js");
const { createInstance, render, serialise, textOf } = require("./dom-stub.js");
const { secretsIn } = require("./fixture.js");

const ID = "module_1_MMM-ParcelApp";
const KEY_VAR = "PARCEL_ACCEPTANCE_KEY";

/* Pinned to the fixture's own date so the suite does not rot. */
const NOW = new Date(2026, 7, 24, 20, 0);
const MS_HOUR = 60 * 60 * 1000;

const fixture = () => JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "deliveries.json"), "utf8"));

const jsonResponse = (body, status = 200) => ({
  status, ok: status >= 200 && status < 300, json: async () => body
});

/* Drive the whole module: helper poll -> socket payload -> rendered DOM. */
const stack = async ({ responses, config = {}, now = NOW }) => {
  const definition = loadDefinition();
  const helper = Object.create(definition);
  const logs = [];
  const payloads = [];

  helper.sendSocketNotification = (notification, payload) => {
    assert.equal(notification, "PARCEL_PAYLOAD");
    payloads.push(payload);
  };
  helper.start();
  helper.now = () => now;
  helper.schedule = () => {};                       // no live timers in tests
  helper.carrierCachePath = () => path.join(os.tmpdir(), "mmm-parcelapp-none", "x.json");
  helper.carriers = { ups: "UPS", amzlus: "Amazon US", dp: "Deutsche Post" };
  helper.carriersFetchedAt = now.getTime();
  helper.refreshCarriers = () => {};

  const console_ = { ...console };
  for (const level of ["log", "warn", "error"])
    console[level] = (...args) => logs.push(`${level} ${args.join(" ")}`);

  const previousKey = process.env[KEY_VAR];
  const previousFetch = global.fetch;
  process.env[KEY_VAR] = "acceptance-key";

  try {
    helper.runPoll = () => {};                      // poll explicitly instead
    helper.socketNotificationReceived("PARCEL_CONFIG", {
      identifier: ID, config: { apiKeyEnvVar: KEY_VAR, ...config }
    });
    delete helper.runPoll;

    for (const responder of [].concat(responses)) {
      global.fetch = async () => responder();
      await helper.poll(helper.instances.get(ID));
    }
  } finally {
    global.fetch = previousFetch;
    Object.assign(console, console_);
    if (previousKey === undefined) delete process.env[KEY_VAR];
    else process.env[KEY_VAR] = previousKey;
  }

  // Now the frontend, exactly as MagicMirror drives it.
  const harness = createInstance(config);
  harness.instance.start();
  harness.instance.notificationReceived("DOM_OBJECTS_CREATED");
  for (const payload of payloads)
    harness.instance.socketNotificationReceived("PARCEL_PAYLOAD", payload);

  const dom = render(harness.instance);
  return {
    payload: payloads[payloads.length - 1],
    payloads,
    logs,
    hidden: harness.instance.hidden,
    visibility: harness.visibility,
    html: serialise(dom),
    text: textOf(dom)
  };
};

/* An event date `hoursAgo` before the pinned now, in the UPS shape. */
const eventAgo = (hoursAgo) => {
  const d = new Date(NOW.getTime() - hoursAgo * MS_HOUR);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/* ---------------------------------------------------------------------- */

test("1. the sample response renders, every date format on the right day", async () => {
  const result = await stack({ responses: () => jsonResponse(fixture()) });

  assert.equal(result.hidden, false);
  assert.equal(result.payload.items.length, 5);

  // "2026-08-24 18:44" (UPS, ISO-like) on the pinned day.
  assert.ok(result.text.includes("18:44 · UPS · Arrived at Facility"));
  // "Monday, August 24 5:00 PM" (Amazon, year-less, 12-hour) -> 17:00, same day.
  assert.ok(result.text.includes("17:00 · Amazon US · Delivered in the mailroom"));
  // "Monday, August 24 " (Amazon, year-less, no time) -> the right day, and no
  // invented clock time.
  assert.ok(result.text.includes("Mon · Amazon US · Package left the shipper facility"));
  assert.ok(!result.text.includes("00:00"), "no fabricated midnight");
  // date_expected windows and date-only expectations.
  assert.ok(result.text.includes("Due Wed 13:15–16:15"));
  assert.ok(result.text.includes("Due Tuesday"), "date-only, never 'Tuesday 12:00am'");

  // The year-less forms resolved to 2026, not to a year in the future.
  for (const item of result.payload.items)
    assert.ok(!/20(2[5-9]|[3-9]\d)/.test(item.eventTime || ""), item.eventTime);

  // And the other two formats in the brief, which the fixture does not carry.
  const other = await stack({ responses: () => jsonResponse({ success: true, deliveries: [
    { carrier_code: "dp", description: "German parcel", status_code: 2,
      tracking_number: "DP1",
      events: [{ event: "Processed", date: "24.08.2026 10:07" }] },
    { carrier_code: "fedex", description: "US parcel", status_code: 2,
      tracking_number: "FX1",
      events: [{ event: "Scanned", date: "August 24, 2026 22:47" }] }
  ] }) });
  assert.ok(other.text.includes("10:07"), "DD.MM.YYYY is day-first, not 8 November");
  assert.ok(other.text.includes("22:47"));
});

test("2. --//-- renders as no timestamp, never as literal text", async () => {
  const result = await stack({ responses: () => jsonResponse({ success: true, deliveries: [
    { carrier_code: "amzlus", description: "Pacifier", status_code: 2,
      tracking_number: "AZ1",
      events: [{ event: "Preparing for shipment", date: "--//--" }] }
  ] }) });

  assert.ok(!result.html.includes("--//--"));
  assert.ok(!result.logs.join("\n").includes("unrecognised event date"));
  assert.equal(result.payload.items[0].eventTime, null);
  assert.ok(result.text.includes("Pacifier"), "and the row is still shown");
});

test("3. multiple status 8 items collapse to one summary row", async () => {
  const result = await stack({ responses: () => jsonResponse(fixture()) });

  const rows = result.html.split("\n").filter((l) => l.includes("parcel-row"));
  assert.equal(rows.length, 5, "nine deliveries, five rows");
  assert.ok(result.text.includes("5 preparing for shipment"));
  // Once, in the summary row — not once per collapsed parcel.
  assert.equal((result.text.match(/preparing for shipment/gi) || []).length, 1);
});

test("4. delivered at 47 hours is shown, at 49 hours it is gone", async () => {
  const delivered = (hoursAgo) => () => jsonResponse({ success: true, deliveries: [
    { carrier_code: "ups", description: "Cat litter", status_code: 0,
      tracking_number: "D1",
      events: [{ event: "Delivered", date: eventAgo(hoursAgo) }] }
  ] });

  const shown = await stack({ responses: delivered(47) });
  assert.ok(shown.text.includes("Cat litter"));
  assert.equal(shown.hidden, false);

  const gone = await stack({ responses: delivered(49) });
  assert.ok(!gone.text.includes("Cat litter"));
  assert.equal(gone.hidden, true, "and with nothing else to show, the module hides");
});

test("5. status 1 never appears", async () => {
  const result = await stack({ responses: () => jsonResponse({ success: true, deliveries: [
    { carrier_code: "ups", description: "Abandoned parcel", status_code: 1,
      tracking_number: "F1", events: [{ event: "No updates", date: eventAgo(200) }] },
    { carrier_code: "ups", description: "Live parcel", status_code: 2,
      tracking_number: "L1", events: [{ event: "In transit", date: eventAgo(1) }] }
  ] }) });

  assert.ok(!result.html.includes("Abandoned parcel"));
  assert.ok(!result.html.includes("Frozen"));
  assert.ok(result.text.includes("Live parcel"));
});

test("6. extra_information appears nowhere in the DOM or the logs", async () => {
  const result = await stack({ responses: () => jsonResponse(fixture()) });
  const haystack = `${result.html}\n${result.logs.join("\n")}\n${JSON.stringify(result.payloads)}`;

  for (const token of secretsIn(fixture()).concat("extra_information"))
    assert.ok(!haystack.includes(token), `leaked ${token}`);

  // Nor does anything else secret: the key stays inside the helper.
  assert.ok(!haystack.includes("acceptance-key"));
});

test("7. deliveries: null hides the module cleanly and does not throw", async () => {
  const result = await stack({ responses: () => jsonResponse({ success: true, deliveries: null }) });

  assert.equal(result.payload.status, "OK");
  assert.deepEqual(result.payload.items, []);
  assert.equal(result.hidden, true);
  assert.ok(!result.logs.some((l) => l.startsWith("error")), result.logs.join("\n"));
});

test("8. an empty list hides the module, and it stays hidden", async () => {
  // Twenty polls over a simulated week: nothing may un-hide it on a timer.
  const responses = Array.from({ length: 20 },
    () => () => jsonResponse({ success: true, deliveries: [] }));
  const result = await stack({ responses });

  assert.equal(result.hidden, true);
  assert.ok(!result.html.includes("parcel-row"));
  assert.equal(result.visibility.filter((v) => v.action === "show").length, 0,
    "never un-hides itself");

  // It comes back the moment there is something worth showing.
  const withData = await stack({ responses: [
    () => jsonResponse({ success: true, deliveries: [] }),
    () => jsonResponse(fixture())
  ] });
  assert.equal(withData.hidden, false);
});

test("9. an unplugged network cable changes nothing on screen", async () => {
  const offline = () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); };
  const result = await stack({ responses: [
    () => jsonResponse(fixture()), offline, offline, offline, offline
  ] });

  assert.equal(result.payload.status, "OK");
  assert.equal(result.payload.items.length, 5, "the display is not cleared");
  assert.equal(result.hidden, false);
  assert.ok(result.text.includes("Concert tickets"));
  assert.equal(result.payload.stale, false, "not stale until two hours have passed");
});

test("9b. and after two hours offline it says so, without clearing", async () => {
  const definition = loadDefinition();
  const helper = Object.create(definition);
  const payloads = [];
  helper.sendSocketNotification = (n, p) => payloads.push(p);
  helper.start();
  helper.schedule = () => {};
  helper.refreshCarriers = () => {};
  helper.carriers = { ups: "UPS", amzlus: "Amazon US" };

  const console_ = { ...console };
  for (const level of ["log", "warn", "error"]) console[level] = () => {};
  process.env[KEY_VAR] = "acceptance-key";

  const previousFetch = global.fetch;
  try {
    let clock = NOW.getTime();
    helper.now = () => new Date(clock);
    helper.runPoll = () => {};
    helper.socketNotificationReceived("PARCEL_CONFIG",
      { identifier: ID, config: { apiKeyEnvVar: KEY_VAR } });
    delete helper.runPoll;

    global.fetch = async () => jsonResponse(fixture());
    await helper.poll(helper.instances.get(ID));

    clock += 3 * MS_HOUR;                       // three hours later, still offline
    global.fetch = async () => { throw new Error("offline"); };
    await helper.poll(helper.instances.get(ID));
  } finally {
    global.fetch = previousFetch;
    Object.assign(console, console_);
    delete process.env[KEY_VAR];
  }

  const harness = createInstance();
  harness.instance.start();
  for (const payload of payloads)
    harness.instance.socketNotificationReceived("PARCEL_PAYLOAD", payload);
  const text = textOf(render(harness.instance));

  assert.equal(payloads[payloads.length - 1].stale, true);
  assert.ok(text.includes("Not updating"));
  assert.ok(text.includes("Concert tickets"), "the last good data is still on screen");
});
