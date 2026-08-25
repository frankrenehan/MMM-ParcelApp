/* Render the module to a standalone HTML page, so the layout can be checked
 * without deploying to the mirror.
 *
 *   node tools/preview.js [fixture.json] [output.html]
 *
 * Defaults to test/fixtures/deliveries.json and preview.html. The page is
 * static: it is the frontend's real DOM output with the real stylesheet.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { createInstance, render, serialise } = require("../test/dom-stub.js");
const { buildDeliveries, normaliseConfig } = require("../parcel-data.js");

const root = path.join(__dirname, "..");
const fixturePath = process.argv[2] || path.join(root, "test", "fixtures", "deliveries.json");
const outputPath = process.argv[3] || path.join(root, "preview.html");

const CARRIERS = { amzlus: "Amazon US", ups: "UPS", dp: "Deutsche Post",
  fedex: "FedEx", anpost: "An Post" };

/* The fixture is dated, so pin "now" to it rather than to the wall clock. */
const NOW = new Date(2026, 7, 24, 20, 0);

const panelPayload = (data, userConfig = {}, extra = {}) => {
  const config = normaliseConfig(userConfig);
  const result = buildDeliveries(data, {
    now: NOW, config, carriers: CARRIERS, firstSeen: new Map(), logger: console
  });
  return {
    identifier: "module_1_MMM-ParcelApp",
    status: "OK",
    message: null,
    items: result.items,
    total: result.total,
    stale: false,
    lastUpdated: "20:00",
    config: { hideWhenEmpty: config.hideWhenEmpty, fadePoint: config.fadePoint },
    ...extra
  };
};

const panel = (title, payload, userConfig = {}) => {
  const harness = createInstance(userConfig);
  harness.instance.start();
  harness.instance.socketNotificationReceived("PARCEL_PAYLOAD", payload);
  const body = harness.instance.hidden
    ? '<div class="hidden-note">module hidden</div>'
    : serialise(render(harness.instance));
  return `<section class="panel">
  <h2>${title}</h2>
  <div class="MMM-ParcelApp module">
${body}
  </div>
</section>`;
};

/* A scenario the sample response does not cover: the states that mean somebody
 * has to do something, plus the date formats the fixture never exercises. */
const NEEDS_ACTION = { success: true, deliveries: [
  { carrier_code: "dp", description: "Replacement filter for the boiler",
    status_code: 7, tracking_number: "DP1",
    events: [{ event: "Customs clearance required", date: "24.08.2026 09:12" }] },
  { carrier_code: "anpost", description: "Birthday present for Mum",
    status_code: 6, tracking_number: "AP1",
    events: [{ event: "Delivery attempted, nobody home", date: "24.08.2026 14:31" }] },
  { carrier_code: "fedex", description: "Passport renewal documents",
    status_code: 3, tracking_number: "FX1",
    date_expected: "2026-08-25 09:00:00",
    events: [{ event: "Awaiting collection at the local depot",
      date: "August 24, 2026 16:02" }] },
  { carrier_code: "ups", description: "Standing desk motor", status_code: 4,
    tracking_number: "UP1", timestamp_expected: Math.floor(new Date(2026, 7, 24, 18, 0) / 1000),
    events: [{ event: "Out for delivery", date: "2026-08-24 07:41" }] },
  { carrier_code: "ups", description: "Camera lens hood", status_code: 5,
    tracking_number: "TYPOD1Z", events: [{ event: "No tracking information", date: "2026-08-21 11:00" }] },
  { carrier_code: "amzlus", description: "Cat litter, 12kg", status_code: 0,
    tracking_number: "AZ1",
    events: [{ event: "Delivered to the porch", date: "Monday, August 24 11:14 AM" }] },
  { carrier_code: "dp", description: "Printer toner cartridge", status_code: 0,
    tracking_number: "DP2",
    events: [{ event: "Delivered", date: "letzten Dienstag" }] }
] };

const errorPayload = (message) => ({
  identifier: "module_1_MMM-ParcelApp", status: "ERROR", message,
  items: [], total: 0, stale: false, lastUpdated: null,
  config: { hideWhenEmpty: true, fadePoint: 0.4 }
});

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const css = fs.readFileSync(path.join(root, "MMM-ParcelApp.css"), "utf8");

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MMM-ParcelApp preview</title>
<style>
/* Approximates MagicMirror's own base styles. */
:root { --color-text: #999; --color-text-dimmed: #666; --color-text-bright: #fff; }
body { margin: 0; padding: 28px; background: #000; color: var(--color-text);
  font-family: "Roboto Condensed", Roboto, Helvetica, sans-serif; font-weight: 400; }
.grid { display: flex; flex-wrap: wrap; gap: 32px; align-items: flex-start; }
.panel { border: 1px solid #222; padding: 16px 18px 20px; border-radius: 4px; }
.panel h2 { margin: 0 0 14px; font-size: 12px; letter-spacing: .18em;
  text-transform: uppercase; color: #4a4a4a; font-weight: 400; }
.hidden-note { font-size: 13px; font-style: italic; color: #3a3a3a; width: 360px; }
${css}
</style>
</head>
<body>
<div class="grid">
${panel("Sample response", panelPayload(fixture))}
${panel("Needs action", panelPayload(NEEDS_ACTION))}
${panel("Stale", panelPayload(fixture, {}, { stale: true, lastUpdated: "Sun 09:12" }))}
${panel("Empty, hideWhenEmpty on", panelPayload({ success: true, deliveries: null }))}
${panel("Empty, hideWhenEmpty off", panelPayload({ success: true, deliveries: null },
  { hideWhenEmpty: false }), { hideWhenEmpty: false })}
${panel("API key missing", errorPayload("Parcel: API key not configured"))}
${panel("Long API error", errorPayload("Your subscription has lapsed and the tracking API is no longer available for this account; renew in the Parcel app"))}
</div>
</body>
</html>
`;

fs.writeFileSync(outputPath, html);
console.log(`wrote ${path.relative(process.cwd(), outputPath)}`);
