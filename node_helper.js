/* MMM-ParcelApp — node_helper.
 *
 * All network I/O lives here. The frontend runs in Electron's renderer and
 * must never hold the API key or make cross-origin requests, so this polls the
 * API, normalises everything, and pushes a ready-to-render array over the
 * socket. Node's global fetch only — no runtime dependencies.
 */
"use strict";

const NodeHelper = require("node_helper");
const fs = require("fs");
const path = require("path");

const {
  buildDeliveries,
  formatErrorMessage,
  formatEventTime,
  normaliseConfig,
  normaliseCarrierMap,
  isPlausibleCarrierMap,
  MS_HOUR,
  MS_MINUTE,
  MS_DAY
} = require("./parcel-data.js");

const DELIVERIES_URL = "https://api.parcel.app/external/deliveries/?filter_mode=recent";
const CARRIERS_URL = "https://api.parcel.app/external/supported_carriers.json";

const CACHE_DIR = path.join(__dirname, ".cache");
const CARRIER_CACHE = path.join(CACHE_DIR, "carriers.json");
const CARRIER_MAX_AGE = 7 * MS_DAY;      // "at most weekly"

const REQUEST_TIMEOUT = 20 * 1000;
const STALE_AFTER = 2 * MS_HOUR;         // mark last-good data stale after this
const MAX_BACKOFF = MS_HOUR;             // cap the 429 backoff at one hour

const LOG = "[MMM-ParcelApp]";

module.exports = NodeHelper.create({
  start () {
    this.instances = new Map();          // identifier -> instance state
    this.carriers = {};
    this.carriersFetchedAt = 0;
    this.carrierLoad = null;
    this.carrierCacheRead = false;
  },

  stop () {
    for (const instance of this.instances.values())
      if (instance.timer) clearTimeout(instance.timer);
    this.instances.clear();
  },

  socketNotificationReceived (notification, payload) {
    if (notification !== "PARCEL_CONFIG") return;
    if (!payload || typeof payload.identifier !== "string") return;
    this.registerInstance(payload.identifier, payload.config);
  },

  registerInstance (identifier, rawConfig) {
    const config = normaliseConfig(rawConfig, console);
    const existing = this.instances.get(identifier);

    if (existing) {
      // Re-registration, not reconfiguration. MagicMirror restarts when
      // config.js changes, and the API key is read from the environment at
      // startup, so a repeat announcement only ever means the frontend rebuilt
      // its DOM and wants the current payload again. The running instance —
      // its config, its key, its poll timer, its stopped state — is left
      // exactly as it is. Changing any option requires a restart; that is the
      // whole contract, and it is documented in the README.
      this.emit(existing);
      return;
    }

    const instance = {
      identifier,
      config,
      apiKey: null,
      timer: null,
      stopped: false,
      backoff: 0,
      firstSeen: new Map(),
      lastGood: null,                    // { items, total, at }
      state: { status: "OK", message: null }
    };
    this.instances.set(identifier, instance);

    // The key must not sit in config.js in a form that ends up in git, so the
    // config names an environment variable rather than holding the value.
    const key = process.env[config.apiKeyEnvVar];
    if (typeof key !== "string" || !key.trim()) {
      console.error(`${LOG} environment variable ${config.apiKeyEnvVar} is not set. ` +
        `Set it in the environment MagicMirror runs in (for pm2: add it to the ecosystem file and restart with --update-env).`);
      instance.stopped = true;
      instance.state = { status: "ERROR", message: "Parcel: API key not configured" };
      this.emit(instance);
      return;
    }
    instance.apiKey = key.trim();

    console.log(`${LOG} polling every ${Math.round(config.updateInterval / MS_MINUTE)} min`);
    this.runPoll(instance);
  },

  /* ---------------------------------------------------------------------
   * Poll loop. A setTimeout chain rather than setInterval, so a slow request
   * can never overlap the next one and the 429 backoff has somewhere to live.
   * ------------------------------------------------------------------ */
  schedule (instance, delay) {
    if (instance.stopped) return;
    if (instance.timer) clearTimeout(instance.timer);
    instance.timer = setTimeout(() => this.runPoll(instance), delay);
  },

  /* Nothing below should ever reject, but a poll loop that stops rescheduling
   * stops updating the mirror silently and forever, which is the one failure
   * mode with no visible state. Belt and braces. */
  runPoll (instance) {
    this.poll(instance).catch((error) => {
      console.error(`${LOG} unexpected polling error: ${error && error.message}`);
      this.schedule(instance, instance.config.updateInterval);
    });
  },

  async poll (instance) {
    if (instance.stopped) return;

    let nextDelay = instance.config.updateInterval;
    try {
      // Deliberately not awaited. Carrier names are cosmetic, and a stalled
      // supported-carriers request must never hold up parcel state.
      this.refreshCarriers();
      const data = await this.fetchDeliveries(instance);
      instance.backoff = 0;

      if (data && data.success === false) {
        // Show the API's own message verbatim, truncated to one line.
        instance.state = {
          status: "ERROR",
          message: formatErrorMessage(data.error_message)
        };
        // The response carries no error code and no retryable flag, so a
        // passing server-side glitch cannot be told apart from an expired
        // subscription — and guessing from the message text would be worse
        // than either. Instead of choosing, bound it by time: the parcels stay
        // up (under a conspicuous error line) until they pass the same two
        // hour threshold that marks data stale, and are then dropped, leaving
        // the error alone on screen. A brief upstream fault costs nothing; a
        // permanent one cannot leave week-old parcels on the mirror.
        if (instance.lastGood
          && this.now().getTime() - instance.lastGood.at > STALE_AFTER)
          instance.lastGood = null;
        console.error(`${LOG} API reported failure: ${instance.state.message}`);
      } else {
        const result = buildDeliveries(data, {
          now: this.now(),
          config: instance.config,
          carriers: this.carriers,
          firstSeen: instance.firstSeen,
          logger: console
        });
        this.pruneFirstSeen(instance, data);
        instance.lastGood = { ...result, at: this.now().getTime() };
        instance.state = { status: "OK", message: null };
      }
    } catch (error) {
      nextDelay = this.handleFetchError(instance, error);
    }

    try {
      this.emit(instance);
    } catch (error) {
      console.error(`${LOG} could not send an update: ${error && error.message}`);
    }
    this.schedule(instance, nextDelay);
  },

  handleFetchError (instance, error) {
    if (error && error.authFailed) {
      // Do not retry-loop: the key is read from the environment at startup, so
      // fixing it means restarting MagicMirror anyway.
      console.error(`${LOG} authentication failed (HTTP ${error.status}). Polling stopped.`);
      instance.stopped = true;
      instance.state = { status: "ERROR", message: "Parcel: authentication failed" };
      // Permanent and actionable, and this is the last emit there will ever be
      // — nothing would arrive later to age the parcels or mark them stale, so
      // holding them would leave a frozen list looking current indefinitely.
      instance.lastGood = null;
      return 0;
    }

    if (error && error.rateLimited) {
      instance.backoff = instance.backoff
        ? Math.min(instance.backoff * 2, MAX_BACKOFF)
        : instance.config.updateInterval;
      const delay = Math.min(Math.max(instance.backoff, instance.config.updateInterval), MAX_BACKOFF);
      console.warn(`${LOG} rate limited, backing off for ${Math.round(delay / MS_MINUTE)} min`);
      if (!instance.lastGood)
        instance.state = { status: "ERROR", message: "Parcel: rate limited" };
      return delay;
    }

    // Network error: keep showing the last good data. emit() marks it stale
    // once it is more than two hours old.
    console.warn(`${LOG} fetch failed: ${error && error.message ? error.message : error}`);
    instance.state = instance.lastGood
      ? { status: "OK", message: null }
      : { status: "ERROR", message: "Parcel: cannot reach the Parcel API" };
    return instance.config.updateInterval;
  },

  async fetchDeliveries (instance) {
    const response = await fetch(DELIVERIES_URL, {
      headers: { "api-key": instance.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    });

    if (response.status === 401 || response.status === 403) {
      const error = new Error(`HTTP ${response.status}`);
      error.authFailed = true;
      error.status = response.status;
      throw error;
    }
    if (response.status === 429) {
      const error = new Error("HTTP 429");
      error.rateLimited = true;
      throw error;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    return response.json();
  },

  /* Drop first-seen clocks for parcels that are no longer in the response, so
   * a re-added tracking number gets a fresh grace period. */
  pruneFirstSeen (instance, data) {
    const live = new Set();
    const deliveries = data && Array.isArray(data.deliveries) ? data.deliveries : [];
    deliveries.forEach((delivery, index) => {
      if (!delivery || typeof delivery !== "object") return;
      const key = typeof delivery.tracking_number === "string" && delivery.tracking_number
        ? delivery.tracking_number
        : `index-${index}`;
      live.add(key);
      live.add(`${key}#${index}`);
    });
    for (const key of instance.firstSeen.keys())
      if (!live.has(key)) instance.firstSeen.delete(key);
  },

  /* ---------------------------------------------------------------------
   * Carrier names. carrier_code is an internal code ("dp" = Deutsche Post),
   * and the map is updated daily upstream, so never hardcode a list.
   * ------------------------------------------------------------------ */
  /* Best effort and fire-and-forget. The disk cache is read synchronously on
   * the first call, so a mirror that has run before has names immediately;
   * the network refresh happens alongside the delivery fetch, never in front
   * of it. Returns the in-flight promise (which never rejects) for tests. */
  refreshCarriers () {
    if (!this.carrierCacheRead) {
      this.carrierCacheRead = true;
      this.loadCarrierCache();
    }
    if (Date.now() - this.carriersFetchedAt < CARRIER_MAX_AGE) return this.carrierLoad;
    if (this.carrierLoad) return this.carrierLoad;      // one at a time

    // .catch() before .finally() so this can never surface as an unhandled
    // rejection, however the caller treats the return value.
    this.carrierLoad = this.fetchCarriers()
      .catch((error) => {
        // Falling back to raw carrier codes is a cosmetic loss, not an outage.
        console.warn(`${LOG} could not refresh carrier names: ${error.message}`);
        // Try again in about half an hour rather than on every poll.
        if (!Object.keys(this.carriers).length)
          this.carriersFetchedAt = Date.now() - CARRIER_MAX_AGE + 30 * MS_MINUTE;
      })
      .finally(() => { this.carrierLoad = null; });

    return this.carrierLoad;
  },

  async fetchCarriers () {
    const response = await fetch(CARRIERS_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const carriers = normaliseCarrierMap(body);
    if (!isPlausibleCarrierMap(body, carriers))
      throw new Error(`not a carrier map (${Object.keys(carriers).length} entries)`);

    this.carriers = carriers;
    this.carriersFetchedAt = Date.now();
    this.writeCarrierCache();
    console.log(`${LOG} loaded ${Object.keys(carriers).length} carrier names`);
  },

  /* Seams so the tests can pin the clock and keep off the mirror's real cache. */
  now () {
    return new Date();
  },

  carrierCachePath () {
    return CARRIER_CACHE;
  },

  loadCarrierCache () {
    try {
      const cached = JSON.parse(fs.readFileSync(this.carrierCachePath(), "utf8"));
      const stored = cached && cached.carriers;
      const carriers = normaliseCarrierMap(stored);
      // Checked on the way in as well as on the way out: a cache poisoned by
      // an earlier version, or by hand, must not be trusted for a week.
      if (isPlausibleCarrierMap(stored, carriers)) {
        this.carriers = carriers;
        this.carriersFetchedAt = Number(cached.fetchedAt) || 0;
      } else if (stored) {
        console.warn(`${LOG} ignoring an implausible carrier cache; refetching`);
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        console.warn(`${LOG} could not read the carrier cache: ${error.message}`);
    }
  },

  writeCarrierCache () {
    try {
      const target = this.carrierCachePath();
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({
        fetchedAt: this.carriersFetchedAt,
        carriers: this.carriers
      }));
    } catch (error) {
      // A read-only install is survivable: we just refetch after each restart.
      console.warn(`${LOG} could not write the carrier cache: ${error.message}`);
    }
  },

  /* ------------------------------------------------------------------ */
  emit (instance) {
    const now = this.now();
    const good = instance.lastGood;
    const stale = Boolean(good) && now.getTime() - good.at > STALE_AFTER;

    this.sendSocketNotification("PARCEL_PAYLOAD", {
      identifier: instance.identifier,
      status: instance.state.status,
      message: instance.state.message,
      items: good ? good.items : [],
      total: good ? good.total : 0,
      stale,
      lastUpdated: good ? formatEventTime(new Date(good.at), now) : null,
      config: {
        hideWhenEmpty: instance.config.hideWhenEmpty,
        fadePoint: instance.config.fadePoint
      }
    });
  }
});
