/* Report what the live API is actually sending, without exposing anything
 * personal — no descriptions, no tracking numbers, no extra_information, no
 * locations. Just counts, status codes, and the *shapes* of date strings.
 *
 *   curl -s -H "api-key: $PARCEL_API_KEY" \
 *     "https://api.parcel.app/external/deliveries/?filter_mode=recent" \
 *     | node tools/date-shapes.js
 *
 * Or against a saved response:  node tools/date-shapes.js response.json
 *
 * Output is safe to paste into a bug report. Any date string the parser cannot
 * read is printed in full, because that is the one thing needed to add support
 * for a new carrier — and a date format is not personal information.
 */
"use strict";

const fs = require("node:fs");
const { parseEventDate } = require("../parcel-data.js");

/* Digits become N and words become W, so "2026-08-16 19:00:59.208" reads as
 * "N-N-N N:N:N.N" — the format, with the values stripped out. */
const shapeOf = (raw) => raw
  .replace(/\d+/g, "N")
  .replace(/[A-Za-z]+/g, (w) => (/^(AM|PM)$/i.test(w) ? "MER" : "W"));

const report = (text) => {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    console.error(`Not JSON: ${error.message}`);
    console.error(`First 200 characters: ${text.slice(0, 200)}`);
    process.exit(1);
  }

  console.log(`success: ${data.success}`);
  if (data.error_message) console.log(`error_message: ${data.error_message}`);

  const deliveries = Array.isArray(data.deliveries) ? data.deliveries : [];
  console.log(`deliveries: ${data.deliveries === null ? "null" : deliveries.length}`);
  if (!deliveries.length) return;

  const statuses = {};
  const carriers = {};
  const shapes = new Map();
  const unreadable = new Set();
  let events = 0;

  for (const delivery of deliveries) {
    statuses[delivery.status_code] = (statuses[delivery.status_code] || 0) + 1;
    carriers[delivery.carrier_code] = (carriers[delivery.carrier_code] || 0) + 1;

    const dates = [
      ...(Array.isArray(delivery.events) ? delivery.events : []).map((e) => e && e.date),
      delivery.date_expected,
      delivery.date_expected_end
    ].filter((d) => typeof d === "string" && d.trim());

    for (const date of dates) {
      events += 1;
      const readable = date.trim() === "--//--" || parseEventDate(date);
      const key = `${shapeOf(date)}${readable ? "" : "   <-- NOT READ"}`;
      shapes.set(key, (shapes.get(key) || 0) + 1);
      if (!readable) unreadable.add(date);
    }
  }

  console.log(`date strings: ${events}`);
  console.log(`\nby status code: ${JSON.stringify(statuses)}`);
  console.log(`by carrier: ${JSON.stringify(carriers)}`);

  console.log("\ndate shapes:");
  for (const [shape, n] of [...shapes].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${shape}`);

  if (!unreadable.size) {
    console.log("\nEvery date was read successfully.");
    return;
  }
  console.log(`\n${unreadable.size} date string(s) the parser could not read:`);
  for (const date of unreadable) console.log(`  ${JSON.stringify(date)}`);
  console.log("\nThose strings are what is needed to add support. They contain no\n"
    + "personal information and are safe to share.");
};

const file = process.argv[2];
if (file) {
  report(fs.readFileSync(file, "utf8"));
} else {
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => report(input));
}
