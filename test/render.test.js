"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { createInstance, render, serialise, textOf } = require("./dom-stub.js");
const { secretsIn } = require("./fixture.js");
const { buildDeliveries, normaliseConfig } = require("../parcel-data.js");

const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);
const NOW = at(2026, 8, 24, 20, 0);
const CARRIERS = { amzlus: "Amazon US", ups: "UPS" };
const QUIET = { warn: () => {}, error: () => {}, info: () => {} };

const fixture = () => JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "deliveries.json"), "utf8"));

/* Build the payload exactly as node_helper.emit() does. */
const payloadFor = (data, userConfig = {}) => {
  const config = normaliseConfig(userConfig);
  const result = buildDeliveries(data, {
    now: NOW, config, carriers: CARRIERS, firstSeen: new Map(), logger: QUIET
  });
  return {
    identifier: "module_1_MMM-ParcelApp",
    status: "OK",
    message: null,
    items: result.items,
    total: result.total,
    stale: false,
    lastUpdated: "20:00",
    config: { hideWhenEmpty: config.hideWhenEmpty, fadePoint: config.fadePoint }
  };
};

const mount = (payload, userConfig = {}) => {
  const harness = createInstance(userConfig);
  harness.instance.start();
  if (payload) harness.instance.socketNotificationReceived("PARCEL_PAYLOAD", payload);
  harness.html = serialise(render(harness.instance));
  harness.text = textOf(render(harness.instance));
  return harness;
};

/* ---------------------------------------------------------------------- */

test("the frontend asks the helper for data and holds no key itself", () => {
  const harness = createInstance();
  harness.instance.start();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].notification, "PARCEL_CONFIG");
  assert.equal(harness.sent[0].payload.config.apiKeyEnvVar, "PARCEL_API_KEY");
});

test("payloads addressed to another instance are ignored", () => {
  const harness = createInstance();
  harness.instance.start();
  harness.instance.socketNotificationReceived("PARCEL_PAYLOAD",
    { ...payloadFor(fixture()), identifier: "module_2_MMM-ParcelApp" });
  assert.equal(harness.instance.payload, null);
  assert.equal(harness.instance.domUpdates, 0);
});

test("the sample response renders five rows", () => {
  const harness = mount(payloadFor(fixture()));
  const rows = harness.html.split("\n").filter((line) => line.includes("parcel-row"));
  assert.equal(rows.length, 5);
  assert.ok(harness.text.includes("Concert tickets"));
  assert.ok(harness.text.includes("5 preparing for shipment"));
  assert.ok(harness.text.includes("Due Wed 13:15–16:15"));
  assert.ok(harness.text.includes("18:44 · UPS · Arrived at Facility"));
});

test("nothing sensitive or internal reaches the DOM", () => {
  const harness = mount(payloadFor(fixture()));
  for (const token of secretsIn(fixture()).concat(
    "extra_information", "api-key", "PARCEL_API_KEY"))
    assert.ok(!harness.html.includes(token), `leaked ${token}`);

  // The no-date sentinel must never be rendered as literal text.
  assert.ok(!harness.html.includes("--//--"));
  // Nor may a raw event date leak through unformatted.
  assert.ok(!harness.html.includes("Monday, August 24"));
});

test("needs-action rows are marked, not just sorted to the top", () => {
  const harness = mount(payloadFor({ deliveries: [
    { carrier_code: "ups", description: "Broken", status_code: 7,
      tracking_number: "T1", events: [{ event: "Exception", date: "2026-08-24 09:00" }] },
    { carrier_code: "ups", description: "Fine", status_code: 2,
      tracking_number: "T2", events: [{ event: "In transit", date: "2026-08-24 10:00" }] }
  ] }));

  const lines = harness.html.split("\n").filter((l) => l.includes("parcel-row"));
  assert.ok(lines[0].includes("parcel-attention"));
  assert.ok(lines[0].includes("parcel-tone-alert"));
  assert.ok(!lines[1].includes("parcel-attention"));
  assert.ok(harness.text.includes("Exception"));
});

test("a delivered parcel with an unreadable date renders as visibly abnormal", () => {
  const harness = mount(payloadFor({ deliveries: [
    { carrier_code: "ups", description: "Knew when", status_code: 0,
      tracking_number: "GOOD", extra_information: "AA1 1AA someone@example.com",
      events: [{ event: "Delivered", date: "2026-08-24 11:14" }] },
    { carrier_code: "ups", description: "Did not", status_code: 0,
      tracking_number: "BAD", extra_information: "AA1 1AA someone@example.com",
      events: [{ event: "Delivered", date: "sometime last Tuesday" }] }
  ] }));

  const rows = harness.html.split("\n").filter((l) => l.includes("parcel-row"));
  assert.equal(rows.length, 2, "neither parcel disappeared");

  // The marked one leads, carries the attention marker and the warning tone.
  assert.ok(rows[0].includes("parcel-attention"));
  assert.ok(rows[0].includes("parcel-tone-warn"));
  // The ordinary one has neither, so the two cannot be confused.
  assert.ok(!rows[1].includes("parcel-attention"));
  assert.ok(rows[1].includes("parcel-tone-done"));

  // It still reads as delivered, and states what it does not know.
  assert.ok(harness.text.includes("Date unknown · UPS · Delivered"));
  assert.equal((harness.text.match(/Delivered/g) || []).length >= 2, true);

  // No clock time is invented for it: 11:14 belongs to the readable one only.
  assert.equal((harness.html.match(/\d{1,2}:\d{2}/g) || []).length, 1);

  // And the invariant holds on the abnormal path too.
  assert.ok(!harness.html.includes("AA1 1AA"));
  assert.ok(!harness.html.includes("someone@example.com"));
  assert.ok(!harness.html.includes("extra_information"));
});

test("hideWhenEmpty hides on an empty result and stays hidden", () => {
  const harness = createInstance({ hideWhenEmpty: true });
  harness.instance.start();
  harness.instance.notificationReceived("DOM_OBJECTS_CREATED");
  assert.equal(harness.instance.hidden, true, "starts hidden rather than flashing a placeholder");

  harness.instance.socketNotificationReceived("PARCEL_PAYLOAD",
    payloadFor({ success: true, deliveries: null }));
  assert.equal(harness.instance.hidden, true);

  // Nothing un-hides it on a timer; only content does.
  for (let i = 0; i < 5; i += 1)
    harness.instance.socketNotificationReceived("PARCEL_PAYLOAD",
      payloadFor({ success: true, deliveries: null }));
  assert.equal(harness.instance.hidden, true);
  assert.equal(serialise(render(harness.instance)).includes("parcel-row"), false);

  harness.instance.socketNotificationReceived("PARCEL_PAYLOAD", payloadFor(fixture()));
  assert.equal(harness.instance.hidden, false);
  assert.ok(harness.visibility.every((v) => v.options && v.options.lockString));
});

test("an empty result still takes our own lock when something else hid us", () => {
  // MMM-Pages and friends hide modules with their own lockString. Reading
  // this.hidden would make us skip our own hide, and the module would come
  // back empty the moment that other lock was released.
  const harness = createInstance({ hideWhenEmpty: true });
  harness.instance.start();
  harness.instance.hidden = true;                 // hidden by somebody else

  harness.instance.socketNotificationReceived("PARCEL_PAYLOAD",
    payloadFor({ success: true, deliveries: null }));

  const hides = harness.visibility.filter((v) => v.action === "hide");
  assert.equal(hides.length, 1, "we applied our own lock anyway");
  assert.equal(hides[0].options.lockString, harness.instance.identifier);

  // And we do not stack duplicate locks on every later poll.
  for (let i = 0; i < 3; i += 1)
    harness.instance.socketNotificationReceived("PARCEL_PAYLOAD",
      payloadFor({ success: true, deliveries: null }));
  assert.equal(harness.visibility.filter((v) => v.action === "hide").length, 1);
});

test("hideWhenEmpty off says so instead of hiding", () => {
  const harness = mount(payloadFor({ success: true, deliveries: null },
    { hideWhenEmpty: false }), { hideWhenEmpty: false });
  assert.equal(harness.instance.hidden, false);
  assert.ok(harness.text.includes("No deliveries"));
});

test("an error message is shown even when hideWhenEmpty is on", () => {
  const harness = createInstance({ hideWhenEmpty: true });
  harness.instance.start();
  harness.instance.socketNotificationReceived("PARCEL_PAYLOAD", {
    identifier: "module_1_MMM-ParcelApp", status: "ERROR",
    message: "Parcel: API key not configured", items: [], total: 0,
    stale: false, lastUpdated: null,
    config: { hideWhenEmpty: true, fadePoint: 0.4 }
  });
  assert.equal(harness.instance.hidden, false);
  const html = serialise(render(harness.instance));
  assert.ok(html.includes("parcel-message"));
  assert.ok(html.includes("Parcel: API key not configured"));
});

test("stale data is labelled rather than cleared", () => {
  const harness = mount({ ...payloadFor(fixture()), stale: true, lastUpdated: "Sun 09:12" });
  assert.ok(harness.text.includes("Not updating · last update Sun 09:12"));
  assert.ok(harness.html.includes("parcel-row"), "the last good data is still there");
});

test("rows fade towards the bottom of the list", () => {
  const deliveries = [];
  for (let i = 0; i < 5; i += 1)
    deliveries.push({ carrier_code: "ups", description: `Parcel ${i}`, status_code: 2,
      tracking_number: `T${i}`,
      events: [{ event: "In transit", date: `2026-08-24 1${i}:00` }] });

  const harness = mount(payloadFor({ deliveries }, { fadePoint: 0.4, maxPerCarrier: 0 }));
  const opacities = harness.html.split("\n")
    .filter((line) => line.includes("parcel-row"))
    .map((line) => {
      const match = line.match(/opacity: ([\d.]+)/);
      return match ? Number(match[1]) : 1;
    });

  assert.equal(opacities.length, 5);
  assert.deepEqual(opacities.slice(0, 2), [1, 1]);
  for (let i = 1; i < opacities.length; i += 1)
    assert.ok(opacities[i] <= opacities[i - 1], `row ${i} is not dimmer than row ${i - 1}`);
  assert.ok(opacities[4] > 0, "the last row is never invisible");

  const noFade = mount(payloadFor({ deliveries }, { fadePoint: 0, maxPerCarrier: 0 }));
  assert.ok(!noFade.html.includes("opacity"));
});

test("a row with no event and no expected date still renders", () => {
  const harness = mount(payloadFor({ deliveries: [
    { carrier_code: "ups", description: "Bare", status_code: 2,
      tracking_number: "T1", events: [] }
  ] }, { showCarrier: false }));
  assert.ok(harness.text.includes("Bare"));
  assert.ok(harness.text.includes("In transit"));
});

test("text is escaped, not injected", () => {
  const harness = mount(payloadFor({ deliveries: [
    { carrier_code: "ups", description: "<img onerror=alert(1)>", status_code: 2,
      tracking_number: "T1", events: [{ event: "In transit", date: "2026-08-24 10:00" }] }
  ] }));
  assert.ok(!harness.html.includes("<img"));
  assert.ok(harness.html.includes("&lt;img"));
});
