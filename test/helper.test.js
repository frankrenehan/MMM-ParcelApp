"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadDefinition } = require("./node-helper-stub.js");
const { secretsIn } = require("./fixture.js");

const ID = "module_1_MMM-ParcelApp";
const KEY_VAR = "PARCEL_TEST_KEY";

/* Pinned to the fixture's own date, exactly as test/acceptance.test.js does.
 * Left on the wall clock, every `items.length === 5` assertion in this file
 * would be true only until the fixture's delivered parcel aged out of its
 * 48 hour window, and the suite would go red on a date with no code change. */
const NOW = new Date(2026, 7, 24, 20, 0);

const fixture = () => JSON.parse(fs.readFileSync(
  path.join(__dirname, "fixtures", "deliveries.json"), "utf8"));

const jsonResponse = (body, status = 200) => ({
  status, ok: status >= 200 && status < 300, json: async () => body
});

/* A map the size of a real one — the published file carries 300+ carriers, and
 * anything much smaller is rejected as implausible. */
const carrierMap = (extra = {}) => {
  const map = { ups: { name: "UPS" }, dp: { name: "Deutsche Post" }, ...extra };
  for (let i = 0; i < 30; i += 1) map[`filler${i}`] = { name: `Carrier ${i}` };
  return map;
};

/* A helper with the network, the clock-driven scheduler and the carrier fetch
 * all under the test's control. */
const harness = ({ key = "secret-key", config = {} } = {}) => {
  const definition = loadDefinition();
  const helper = Object.create(definition);

  const sent = [];
  const logs = [];
  const scheduled = [];
  const requests = [];

  helper.sendSocketNotification = (notification, payload) =>
    sent.push({ notification, payload });
  helper.start();
  helper.now = () => NOW;
  helper.schedule = (instance, delay) => scheduled.push(delay);
  helper.refreshCarriers = () => { helper.carriers = { ups: "UPS", amzlus: "Amazon US" }; };

  const console_ = { ...console };
  const capture = (level) => (...args) => logs.push(`${level} ${args.join(" ")}`);

  const withEnv = (fn) => {
    const previous = process.env[KEY_VAR];
    if (key === null) delete process.env[KEY_VAR];
    else process.env[KEY_VAR] = key;
    console.log = capture("log");
    console.warn = capture("warn");
    console.error = capture("error");
    try {
      return fn();
    } finally {
      console.log = console_.log;
      console.warn = console_.warn;
      console.error = console_.error;
      if (previous === undefined) delete process.env[KEY_VAR];
      else process.env[KEY_VAR] = previous;
    }
  };

  const register = (override) => withEnv(() => {
    helper.runPoll = () => {};         // suppress the automatic first poll
    helper.socketNotificationReceived("PARCEL_CONFIG", {
      identifier: ID,
      config: { apiKeyEnvVar: KEY_VAR, ...config, ...(override || {}) }
    });
    delete helper.runPoll;             // back to the real implementation
  });

  const poll = async (responder) => {
    const previousFetch = global.fetch;
    global.fetch = async (url, options) => {
      requests.push({ url, options });
      return responder(url, options);
    };
    try {
      await withEnv(() => helper.poll(helper.instances.get(ID)));
    } finally {
      global.fetch = previousFetch;
    }
  };

  return {
    helper, sent, logs, scheduled, requests, register, poll,
    instance: () => helper.instances.get(ID),
    last: () => sent[sent.length - 1].payload
  };
};

/* ---------------------------------------------------------------------- */

test("a missing environment variable stops before any request is made", () => {
  const h = harness({ key: null });
  h.register();

  assert.equal(h.instance().stopped, true);
  assert.equal(h.last().status, "ERROR");
  assert.equal(h.last().message, "Parcel: API key not configured");
  assert.ok(h.logs.some((l) => l.includes(KEY_VAR)), "names the variable it wanted");
  assert.ok(h.logs.some((l) => l.includes("pm2")), "says how to fix it");
});

test("a blank environment variable is treated as missing", () => {
  const h = harness({ key: "   " });
  h.register();
  assert.equal(h.instance().stopped, true);
  assert.equal(h.last().message, "Parcel: API key not configured");
});

test("the key goes in the header, asks for recent deliveries, and never leaves the helper", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse(fixture()));

  assert.equal(h.requests.length, 1);
  assert.ok(h.requests[0].url.includes("filter_mode=recent"));
  assert.equal(h.requests[0].options.headers["api-key"], "secret-key");

  const serialised = JSON.stringify(h.sent);
  assert.ok(!serialised.includes("secret-key"));
  assert.ok(!serialised.includes("api-key"));
  assert.ok(!h.logs.some((l) => l.includes("secret-key")));
});

test("a successful poll sends a ready-to-render list", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse(fixture()));

  const payload = h.last();
  assert.equal(payload.identifier, ID);
  assert.equal(payload.status, "OK");
  assert.equal(payload.message, null);
  assert.equal(payload.items.length, 5);
  assert.equal(payload.stale, false);
  assert.equal(payload.lastUpdated, "20:00");
  assert.equal(payload.config.hideWhenEmpty, true);
  assert.equal(h.scheduled[0], 20 * 60 * 1000);
});

test("nothing in the payload or the logs carries extra_information", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse(fixture()));

  const haystack = `${JSON.stringify(h.sent)}\n${h.logs.join("\n")}`;
  for (const token of secretsIn(fixture()).concat("extra_information"))
    assert.ok(!haystack.includes(token), `leaked ${token}`);
});

test("deliveries: null is an empty list, not a crash", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse({ success: true, deliveries: null }));

  assert.equal(h.last().status, "OK");
  assert.deepEqual(h.last().items, []);
  assert.equal(h.scheduled[0], 20 * 60 * 1000, "and it keeps polling");
});

test("success: false shows the API's own message on one line", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse({
    success: false,
    error_message: "Your subscription\nhas expired.   Renew it in the app to carry on."
  }));

  assert.equal(h.last().status, "ERROR");
  assert.equal(h.last().message,
    "Your subscription has expired. Renew it in the app to carry on.");
  assert.ok(!h.last().message.includes("\n"));
});

test("401 and 403 both stop polling instead of hammering the API", async () => {
  for (const status of [401, 403]) {
    const h = harness();
    h.register();
    await h.poll(() => jsonResponse({}, status));

    assert.equal(h.last().message, "Parcel: authentication failed", `HTTP ${status}`);
    assert.equal(h.instance().stopped, true, `HTTP ${status}`);

    // schedule() is a no-op once stopped, so nothing is queued.
    const definition = Object.getPrototypeOf(h.helper);
    definition.schedule.call(h.helper, h.instance(), 1000);
    assert.equal(h.instance().timer, null, `HTTP ${status}`);

    // And a later poll would do nothing even if something called it.
    await h.poll(() => jsonResponse(fixture()));
    assert.equal(h.requests.length, 1, `HTTP ${status}: no second request`);
  }
});

test("a 429 backs off exponentially and caps at an hour", async () => {
  const h = harness();
  h.register();
  for (let i = 0; i < 5; i += 1) await h.poll(() => jsonResponse({}, 429));

  assert.deepEqual(h.scheduled,
    [20 * 60 * 1000, 40 * 60 * 1000, 60 * 60 * 1000, 60 * 60 * 1000, 60 * 60 * 1000]);

  await h.poll(() => jsonResponse(fixture()));
  assert.equal(h.instance().backoff, 0, "a success resets the backoff");
  assert.equal(h.scheduled[5], 20 * 60 * 1000);
});

test("an unplugged network cable keeps the last good data on screen", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse(fixture()));
  const good = h.last().items.length;

  for (let i = 0; i < 3; i += 1)
    await h.poll(() => { throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }); });

  assert.equal(h.last().status, "OK");
  assert.equal(h.last().items.length, good, "the display is not cleared");
  assert.equal(h.last().stale, false, "not stale yet");
  assert.equal(h.scheduled[3], 20 * 60 * 1000, "and it keeps trying");
});

test("last good data is marked stale after two hours", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse(fixture()));

  h.instance().lastGood.at -= 2 * 60 * 60 * 1000 + 1000;
  await h.poll(() => { throw new Error("offline"); });

  assert.equal(h.last().stale, true);
  assert.ok(h.last().items.length > 0);
  assert.equal(h.last().lastUpdated, "17:59", "when the last good data arrived");
});

test("a network error with nothing cached says so", async () => {
  const h = harness();
  h.register();
  await h.poll(() => { throw new Error("offline"); });

  assert.equal(h.last().status, "ERROR");
  assert.equal(h.last().message, "Parcel: cannot reach the Parcel API");
});

test("an HTTP 500 is treated as a transient failure", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse(fixture()));
  await h.poll(() => jsonResponse({}, 500));

  assert.equal(h.last().status, "OK");
  assert.ok(h.last().items.length > 0);
  assert.equal(h.instance().stopped, false);
});

test("a body that is not JSON does not take the module down", async () => {
  const h = harness();
  h.register();
  await h.poll(() => ({ status: 200, ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } }));

  assert.equal(h.last().status, "ERROR");
  assert.equal(h.instance().stopped, false);
});

test("re-registering replays the payload without starting a second loop", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse(fixture()));
  const before = h.sent.length;

  h.register();
  assert.equal(h.sent.length, before + 1, "replayed once");
  assert.equal(h.last().items.length, 5);
  assert.equal(h.helper.instances.size, 1);
});

test("an unexpected internal error still reschedules the next poll", async () => {
  // A poll loop that stops rescheduling stops updating the mirror silently and
  // forever, which is the one failure mode with no visible state.
  const h = harness();
  h.register();
  h.helper.emit = () => { throw new Error("boom"); };

  await h.poll(() => jsonResponse(fixture()));
  assert.equal(h.scheduled[0], 20 * 60 * 1000);

  // And a rejection that escapes poll() entirely is still caught.
  h.helper.poll = async () => { throw new Error("boom"); };
  h.helper.runPoll(h.instance());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.scheduled[1], 20 * 60 * 1000);
});

test("a stalled carrier refresh cannot hold up a delivery poll", async () => {
  // Carrier names are cosmetic. A supported-carriers endpoint that hangs for
  // the full request timeout must not delay parcel state by so much as a tick.
  const h = harness();
  h.register();
  delete h.helper.refreshCarriers;                  // use the real one
  h.helper.carrierCachePath = () => path.join(os.tmpdir(), "mmm-parcelapp-absent", "x.json");

  let carriersRequested = false;
  await h.poll((url) => {
    if (url.includes("supported_carriers")) {
      carriersRequested = true;
      return new Promise(() => {});                 // never settles
    }
    return jsonResponse(fixture());
  });

  assert.equal(carriersRequested, true, "it did ask for them");
  assert.equal(h.last().status, "OK");
  assert.equal(h.last().items.length, 5, "and the parcels arrived regardless");
  assert.equal(h.scheduled[0], 20 * 60 * 1000, "and the loop carried on");

  // Falling back to raw codes is the whole cost of the failure.
  assert.equal(h.last().items[0].carrier, "ups");
});

test("only one carrier refresh is ever in flight", async () => {
  const h = harness();
  h.register();
  delete h.helper.refreshCarriers;
  h.helper.carrierCachePath = () => path.join(os.tmpdir(), "mmm-parcelapp-absent", "x.json");

  const previousFetch = global.fetch;
  let requests = 0;
  global.fetch = async () => { requests += 1; return new Promise(() => {}); };
  try {
    const first = h.helper.refreshCarriers();
    const second = h.helper.refreshCarriers();
    const third = h.helper.refreshCarriers();
    assert.equal(requests, 1);
    assert.equal(first, second);
    assert.equal(second, third);
  } finally {
    global.fetch = previousFetch;
  }
});

test("a failing carrier refresh raises no unhandled rejection", async () => {
  const rejections = [];
  const onRejection = (reason) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);

  const h = harness();
  h.register();
  delete h.helper.refreshCarriers;
  h.helper.carrierCachePath = () => path.join(os.tmpdir(), "mmm-parcelapp-absent", "x.json");

  try {
    await h.poll((url) => {
      if (url.includes("supported_carriers")) throw new Error("offline");
      return jsonResponse(fixture());
    });
    await h.helper.carrierLoad;                     // whatever it was, it settled
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(rejections, []);
    assert.equal(h.last().items.length, 5);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("an application error keeps recent parcels and drops stale ones", async () => {
  // The response carries no error code, so a passing server-side fault cannot
  // be told apart from an expired subscription. Bound it by time instead.
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse(fixture()));

  await h.poll(() => jsonResponse({ success: false, error_message: "Temporary server error" }));
  assert.equal(h.last().status, "ERROR");
  assert.equal(h.last().message, "Temporary server error");
  assert.equal(h.last().items.length, 5, "a brief fault does not erase the display");

  // Past the two hour threshold the parcels go, leaving the error alone.
  h.instance().lastGood.at -= 2 * 60 * 60 * 1000 + 1000;
  await h.poll(() => jsonResponse({ success: false, error_message: "Subscription expired" }));
  assert.equal(h.last().items.length, 0);
  assert.equal(h.last().message, "Subscription expired");
  assert.equal(h.instance().lastGood, null);

  // And it recovers cleanly when the API comes back.
  await h.poll(() => jsonResponse(fixture()));
  assert.equal(h.last().status, "OK");
  assert.equal(h.last().message, null);
  assert.equal(h.last().items.length, 5);
});

test("authentication failure does not leave a frozen list on the mirror", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse(fixture()));
  assert.equal(h.last().items.length, 5);

  await h.poll(() => jsonResponse({}, 401));
  assert.equal(h.last().message, "Parcel: authentication failed");
  // Polling has stopped, so no later emit would ever age these out or mark
  // them stale — they would sit there looking current indefinitely.
  assert.equal(h.last().items.length, 0);
  assert.equal(h.instance().stopped, true);
});

test("a repeat announcement replays the payload and never reconfigures", async () => {
  // MagicMirror restarts when config.js changes, and the key is read from the
  // environment at startup. A repeat PARCEL_CONFIG only means the frontend
  // rebuilt its DOM.
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse(fixture()));
  const runningConfig = h.instance().config;
  const sentBefore = h.sent.length;

  h.register({ maxItems: 1, showCarrier: false, updateInterval: 55 * 60 * 1000 });

  assert.equal(h.sent.length, sentBefore + 1, "replayed exactly once");
  assert.equal(h.last().items.length, 5, "with the data it already had");
  assert.equal(h.helper.instances.size, 1, "and no second poll loop");
  assert.equal(h.instance().config, runningConfig, "same config object, untouched");
  assert.equal(h.instance().config.maxItems, 6);
  assert.equal(h.instance().config.showCarrier, true);
  assert.equal(h.instance().config.updateInterval, 20 * 60 * 1000);
});

test("a stopped instance stays stopped until MagicMirror restarts", async () => {
  const h = harness();
  h.register();
  await h.poll(() => jsonResponse({}, 401));
  assert.equal(h.instance().stopped, true);

  h.register();                        // the frontend rebuilding its DOM
  assert.equal(h.instance().stopped, true, "re-announcing must not revive it");
  assert.equal(h.last().message, "Parcel: authentication failed");
});

test("the update interval is clamped before the first request", () => {
  const h = harness({ config: { updateInterval: 1000 } });
  h.register();
  assert.equal(h.instance().config.updateInterval, 5 * 60 * 1000);
  assert.ok(h.logs.some((l) => l.includes("clamping")));
});

test("stop() clears the timers", () => {
  const h = harness();
  h.register();
  h.instance().timer = setTimeout(() => {}, 60_000);
  h.helper.stop();
  assert.equal(h.helper.instances.size, 0);
});

/* ---------------------------------------------------------------------- */

test("the carrier cache is read from disk and written back", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-parcelapp-"));
  const cachePath = path.join(cacheDir, "carriers.json");

  const definition = loadDefinition();
  const helper = Object.create(definition);
  helper.start();
  helper.carrierCachePath = () => cachePath;

  const previousFetch = global.fetch;
  const logs = [];
  const console_ = { ...console };
  console.log = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push(a.join(" "));

  global.fetch = async () => jsonResponse(carrierMap());

  try {
    await helper.refreshCarriers();
    assert.equal(helper.carriers.ups, "UPS");
    assert.ok(helper.carriersFetchedAt > 0);

    // Written to disk, and read back without another request.
    const fresh = Object.create(definition);
    fresh.start();
    fresh.carrierCachePath = () => cachePath;
    fresh.loadCarrierCache();
    assert.equal(fresh.carriers.dp, "Deutsche Post");

    global.fetch = async () => { throw new Error("should not be called"); };
    await fresh.refreshCarriers();
    assert.equal(fresh.carriers.dp, "Deutsche Post");
  } finally {
    global.fetch = previousFetch;
    Object.assign(console, console_);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a response that is not a carrier map is rejected, not cached", async () => {
  // The deliveries endpoint's own error envelope, or a CDN error page served
  // as JSON with HTTP 200. normaliseCarrierMap is shape-only and would take it.
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-parcelapp-"));
  const cachePath = path.join(cacheDir, "carriers.json");

  const definition = loadDefinition();
  const helper = Object.create(definition);
  helper.start();
  helper.carrierCachePath = () => cachePath;

  const previousFetch = global.fetch;
  const console_ = { ...console };
  console.warn = () => {};
  console.log = () => {};

  try {
    for (const body of [
      { success: false, error_message: "Your subscription has expired." },
      { error: "Bad gateway" },
      { ups: { name: "UPS" } },                  // far too few to be the real map
      {}
    ]) {
      helper.carriers = {};
      helper.carriersFetchedAt = 0;
      global.fetch = async () => jsonResponse(body);
      await helper.refreshCarriers();

      assert.deepEqual(helper.carriers, {}, JSON.stringify(body));
      assert.equal(fs.existsSync(cachePath), false, `cached ${JSON.stringify(body)}`);
    }

    // A real one is still accepted.
    helper.carriersFetchedAt = 0;
    global.fetch = async () => jsonResponse(carrierMap());
    await helper.refreshCarriers();
    assert.equal(helper.carriers.ups, "UPS");
    assert.equal(fs.existsSync(cachePath), true);
  } finally {
    global.fetch = previousFetch;
    Object.assign(console, console_);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a poisoned cache on disk is ignored rather than trusted for a week", async () => {
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmm-parcelapp-"));
  const cachePath = path.join(cacheDir, "carriers.json");
  fs.writeFileSync(cachePath, JSON.stringify({
    fetchedAt: Date.now(),
    carriers: { error_message: "Your subscription has expired." }
  }));

  const definition = loadDefinition();
  const helper = Object.create(definition);
  helper.start();
  helper.carrierCachePath = () => cachePath;

  const warnings = [];
  const console_ = { ...console };
  console.warn = (...a) => warnings.push(a.join(" "));
  console.log = () => {};
  const previousFetch = global.fetch;

  try {
    helper.loadCarrierCache();
    assert.deepEqual(helper.carriers, {}, "not adopted");
    assert.equal(helper.carriersFetchedAt, 0, "and not treated as fresh");
    assert.ok(warnings.some((w) => w.includes("implausible")));

    // Which means the next refresh actually refetches.
    global.fetch = async () => jsonResponse(carrierMap());
    await helper.refreshCarriers();
    assert.equal(helper.carriers.ups, "UPS");
  } finally {
    global.fetch = previousFetch;
    Object.assign(console, console_);
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("a failed carrier fetch falls back to raw codes rather than failing", async () => {
  const definition = loadDefinition();
  const helper = Object.create(definition);
  helper.start();
  helper.carrierCachePath = () => path.join(os.tmpdir(), "mmm-parcelapp-missing", "carriers.json");
  helper.loadCarrierCache = () => {};      // pretend there is no cache

  const previousFetch = global.fetch;
  const console_ = { ...console };
  console.warn = () => {};
  global.fetch = async () => { throw new Error("offline"); };

  try {
    await helper.refreshCarriers();
    assert.deepEqual(helper.carriers, {});
  } finally {
    global.fetch = previousFetch;
    Object.assign(console, console_);
  }
});
