"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseEventDate } = require("../parcel-data.js");

/* Local-time helper: the API's dates carry no timezone, so we parse them as
 * local time and compare against local-time expectations. */
const at = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

const assertDate = (actual, expected, message) => {
  assert.ok(actual instanceof Date, `${message}: expected a Date, got ${actual}`);
  assert.equal(actual.getTime(), expected.getTime(),
    `${message}: got ${actual.toString()}, expected ${expected.toString()}`);
};

test("DD.MM.YYYY is day-first, not month-first", () => {
  // new Date("11.08.2026") reads this as 8 November. A parcel delivered two
  // days ago would get a timestamp three months in the future.
  assertDate(parseEventDate("11.08.2026 10:07"), at(2026, 8, 11, 10, 7),
    "Deutsche Post / An Post");
});

test("US long form", () => {
  assertDate(parseEventDate("August 12, 2026 22:47"), at(2026, 8, 12, 22, 47),
    "FedEx");
});

test("ISO-like", () => {
  assertDate(parseEventDate("2026-08-13 06:22"), at(2026, 8, 13, 6, 22), "UPS");
});

test("year-less, 12-hour", () => {
  const now = at(2026, 8, 24, 20, 0);
  assertDate(parseEventDate("Monday, August 24 5:00 PM", now),
    at(2026, 8, 24, 17, 0), "Amazon Logistics with a time");
});

test("year-less, no time (note the trailing space)", () => {
  const now = at(2026, 8, 24, 20, 0);
  assertDate(parseEventDate("Monday, August 24 ", now), at(2026, 8, 24, 0, 0),
    "Amazon Logistics without a time");
});

test("the --//-- sentinel is not a date", () => {
  assert.equal(parseEventDate("--//--"), null);
  assert.equal(parseEventDate("  --//--  "), null);
});

test("garbage returns null rather than an Invalid Date", () => {
  for (const input of ["not a date at all", "??", "Frobuary 40, 2026", "12345",
    "", "   ", null, undefined, 12345, {}, []])
    assert.equal(parseEventDate(input), null, `input: ${JSON.stringify(input)}`);
});

test("a December date read in January rolls back a year", () => {
  // The year-less formats have to infer one. Assuming the current year is
  // right for eleven months and catastrophically wrong every January.
  const january = at(2027, 1, 3, 9, 0);
  assertDate(parseEventDate("Monday, December 28 11:00 PM", january),
    at(2026, 12, 28, 23, 0), "late December seen from January");

  assertDate(parseEventDate("Wednesday, December 30 ", january),
    at(2026, 12, 30, 0, 0), "late December, no time, seen from January");
});

test("a date just ahead of now keeps the current year", () => {
  // Carriers do post future-dated events; only roll back beyond a week.
  const now = at(2026, 8, 15, 12, 0);
  assertDate(parseEventDate("Thursday, August 20 10:00 AM", now),
    at(2026, 8, 20, 10, 0), "five days ahead");

  assertDate(parseEventDate("Monday, August 24 10:00 AM", now),
    at(2025, 8, 24, 10, 0), "nine days ahead rolls back");
});

test("12-hour midnight and noon", () => {
  const now = at(2026, 8, 24, 20, 0);
  assertDate(parseEventDate("Monday, August 24 12:00 AM", now),
    at(2026, 8, 24, 0, 0), "12:00 AM is midnight");
  assertDate(parseEventDate("Monday, August 24 12:30 PM", now),
    at(2026, 8, 24, 12, 30), "12:30 PM is midday");
});

test("shape detection tolerates near-miss variants", () => {
  // Detected by shape, not by carrier, because we will meet carriers that are
  // not in the sample.
  assertDate(parseEventDate("11.08.2026"), at(2026, 8, 11), "no time");
  assertDate(parseEventDate("2026-08-13"), at(2026, 8, 13), "ISO date only");
  assertDate(parseEventDate("2026-08-13T06:22"), at(2026, 8, 13, 6, 22), "T separator");
  assertDate(parseEventDate("2026-08-25 00:00:00"), at(2026, 8, 25), "trailing seconds");
  assertDate(parseEventDate("2026-08-13 6:22"), at(2026, 8, 13, 6, 22), "single-digit hour");
  assertDate(parseEventDate("August 12, 2026"), at(2026, 8, 12), "US long form, no time");

  const now = at(2026, 8, 24, 20, 0);
  assertDate(parseEventDate("Monday, August 24 17:05", now), at(2026, 8, 24, 17, 5),
    "year-less on a 24 hour clock");
});

test("out-of-range components are rejected, not rolled over", () => {
  // new Date(2026, 12, 32) is 1 February 2027, which would be a plausible
  // wrong answer rather than an obvious failure.
  assert.equal(parseEventDate("32.13.2026 10:00"), null);
  assert.equal(parseEventDate("31.02.2026 10:00"), null);
  assert.equal(parseEventDate("2026-13-01 10:00"), null);
  assert.equal(parseEventDate("2026-02-30 10:00"), null);

  // Real dates near the boundaries still work.
  assertDate(parseEventDate("29.02.2028 10:00"), at(2028, 2, 29, 10, 0), "leap day");
  assertDate(parseEventDate("31.12.2026 23:59"), at(2026, 12, 31, 23, 59), "year end");
  assert.equal(parseEventDate("29.02.2027 10:00"), null, "not a leap year");
});

test("an unknown month name in the year-less form is rejected", () => {
  assert.equal(parseEventDate("Monday, Smarch 24 5:00 PM"), null);
});

test("clock components are rejected when out of range, in every shape", () => {
  const now = at(2026, 8, 24, 20, 0);

  // JavaScript rolls 10:99 quietly into the next hour, so an out-of-range
  // clock has to be caught before a Date is ever constructed.
  const invalid = [
    "2026-08-13 06:60", "2026-08-13 24:00", "2026-08-13 06:99", "2026-08-13 99:00",
    "11.08.2026 10:60", "11.08.2026 10:99", "11.08.2026 24:00",
    "August 12, 2026 06:60", "August 12, 2026 24:00", "August 12, 2026 25:00",
    "Monday, August 24 5:60 PM", "Monday, August 24 0:30 PM",
    "Monday, August 24 13:30 PM", "Monday, August 24 24:00", "Monday, August 24 12:60 AM",
    "2026-08-13 06:22:60", "11.08.2026 10:07:99"
  ];
  for (const input of invalid)
    assert.equal(parseEventDate(input, now), null, `should be rejected: ${input}`);

  const valid = [
    ["2026-08-13 06:59", at(2026, 8, 13, 6, 59)],
    ["2026-08-13 23:59", at(2026, 8, 13, 23, 59)],
    ["2026-08-13 00:00", at(2026, 8, 13, 0, 0)],
    ["2026-08-13 06:22:59", at(2026, 8, 13, 6, 22)],
    ["11.08.2026 10:59", at(2026, 8, 11, 10, 59)],
    ["11.08.2026 23:00", at(2026, 8, 11, 23, 0)],
    ["August 12, 2026 23:59", at(2026, 8, 12, 23, 59)],
    ["August 12, 2026 11:30 PM", at(2026, 8, 12, 23, 30)]
  ];
  for (const [input, expected] of valid) assertDate(parseEventDate(input, now), expected, input);

  // The 12-hour clock has no hour 0 and no hour 13, but noon and midnight are
  // both written as 12.
  assertDate(parseEventDate("Monday, August 24 12:00 AM", now), at(2026, 8, 24, 0, 0), "midnight");
  assertDate(parseEventDate("Monday, August 24 12:00 PM", now), at(2026, 8, 24, 12, 0), "noon");
  assertDate(parseEventDate("Monday, August 24 12:59 PM", now), at(2026, 8, 24, 12, 59), "12:59 PM");
});

test("a valid date followed by anything unrecognised is rejected", () => {
  // A shape we half-understand is a shape we do not understand. Guessing at
  // the rest is worse than logging it and showing the row without a time.
  for (const input of ["11.08.2026 10:07 junk", "2026-08-13 06:22 extra",
    "2026-08-13 06:22Z", "2026-08-13T06:22+01:00", "August 12, 2026 22:47 EST",
    "2026-08-13 06:22 06:23", "11.08.2026-", "2026-08-13 06:22:11:22"])
    assert.equal(parseEventDate(input), null, `should be rejected: ${input}`);

  // While the shapes that genuinely occur still parse, seconds included.
  assertDate(parseEventDate("2026-08-25 00:00:00"), at(2026, 8, 25), "date_expected");
  assertDate(parseEventDate("2026-08-13T06:22"), at(2026, 8, 13, 6, 22), "T separator");
});

test("a local time the clock skips is normalised, not rejected", () => {
  // Validation is on the input's ranges. Checking that the constructed Date
  // came back with the hour asked for would reject a real event logged during
  // a spring-forward transition, which is a legitimate string.
  const skipped = parseEventDate("2027-03-28 01:30");
  assert.ok(skipped instanceof Date, "a skipped local time still parses");
  assert.equal(isNaN(skipped.getTime()), false);

  for (const input of ["28.03.2027 01:30", "March 28, 2027 01:30"])
    assert.ok(parseEventDate(input) instanceof Date, input);
});

test("parsing does not mutate the reference date", () => {
  const now = at(2026, 1, 5, 9, 0);
  const before = now.getTime();
  parseEventDate("Monday, December 28 11:00 PM", now);
  assert.equal(now.getTime(), before);
});
