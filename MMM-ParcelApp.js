/* MMM-ParcelApp — frontend.
 *
 * Deliberately thin: node_helper.js does every bit of parsing, filtering,
 * sorting and formatting, and sends an array that is ready to render. The only
 * logic here is building DOM and deciding whether the module is visible.
 */
/* global Module */

Module.register("MMM-ParcelApp", {
  defaults: {
    apiKeyEnvVar: "PARCEL_API_KEY",   // name of the env var, not the key
    updateInterval: 20 * 60 * 1000,   // 20 min; the helper enforces a 5 min floor
    maxItems: 6,
    deliveredWindowHours: 48,
    notFoundGraceHours: 24,
    showCarrier: true,
    showExpectedDate: true,
    hideWhenEmpty: true,
    fadePoint: 0.4
  },

  getStyles () {
    return ["MMM-ParcelApp.css"];
  },

  start () {
    this.payload = null;
    this.selfHidden = false;
    this.announce();
  },

  announce () {
    this.sendSocketNotification("PARCEL_CONFIG", {
      identifier: this.identifier,
      config: this.config
    });
  },

  notificationReceived (notification) {
    if (notification !== "DOM_OBJECTS_CREATED") return;
    // Start hidden when we would only be showing a placeholder, so an empty
    // account never flashes "Loading…" and then collapses.
    if (this.config.hideWhenEmpty && !this.payload) this.applyVisibility(true, 0);
    this.announce();
  },

  socketNotificationReceived (notification, payload) {
    if (notification !== "PARCEL_PAYLOAD") return;
    if (!payload || payload.identifier !== this.identifier) return;

    this.payload = payload;
    this.updateVisibility();
    this.updateDom(300);
  },

  updateVisibility () {
    const payload = this.payload;
    const hideWhenEmpty = payload && payload.config
      ? payload.config.hideWhenEmpty
      : this.config.hideWhenEmpty;

    // Hidden means hidden: nothing here un-hides the module on a timer, only
    // the arrival of something worth showing.
    const nothingToShow = !payload
      || (payload.status === "OK" && !payload.message && payload.items.length === 0);

    this.applyVisibility(Boolean(hideWhenEmpty && nothingToShow), 300);
  },

  /* Tracked against our own lock rather than against this.hidden, which is
   * true whenever *anybody* has hidden us. Reading it would mean skipping our
   * own hide while something like MMM-Pages has the module off screen, and the
   * module would then reappear empty the moment that other lock is released. */
  applyVisibility (shouldHide, speed) {
    if (shouldHide === this.selfHidden) return;
    const options = { lockString: this.identifier };
    if (shouldHide) this.hide(speed, options);
    else this.show(speed, options);
    this.selfHidden = shouldHide;
  },

  getDom () {
    const wrapper = document.createElement("div");
    wrapper.className = "parcel-wrapper";

    const payload = this.payload;
    if (!payload) {
      if (!this.config.hideWhenEmpty) wrapper.appendChild(this.note("Loading…"));
      return wrapper;
    }

    if (payload.message) wrapper.appendChild(this.note(payload.message, "parcel-message"));

    if (!payload.items.length) {
      if (!payload.message && !this.config.hideWhenEmpty)
        wrapper.appendChild(this.note("No deliveries"));
      return wrapper;
    }

    const fadePoint = payload.config ? payload.config.fadePoint : this.config.fadePoint;
    const list = document.createElement("div");
    list.className = "parcel-list";
    payload.items.forEach((item, index) => {
      list.appendChild(this.row(item, index, payload.items.length, fadePoint));
    });
    wrapper.appendChild(list);

    if (payload.stale) {
      const suffix = payload.lastUpdated ? ` · last update ${payload.lastUpdated}` : "";
      wrapper.appendChild(this.note(`Not updating${suffix}`, "parcel-stale"));
    }

    return wrapper;
  },

  row (item, index, count, fadePoint) {
    const row = document.createElement("div");
    row.className = `parcel-row parcel-tone-${item.tone}`;
    if (item.needsAction) row.classList.add("parcel-attention");
    if (item.collapsed) row.classList.add("parcel-summary");

    const top = document.createElement("div");
    top.className = "parcel-line";

    const description = document.createElement("span");
    description.className = "parcel-desc";
    description.textContent = item.description;
    top.appendChild(description);

    if (item.statusLabel) {
      const status = document.createElement("span");
      status.className = "parcel-status";
      status.textContent = item.statusLabel;
      top.appendChild(status);
    }
    row.appendChild(top);

    // Time first so it survives the ellipsis when the event text is long.
    const sub = [item.eventTime, item.carrier, item.event].filter(Boolean).join(" · ");
    if (sub || item.expected) {
      const bottom = document.createElement("div");
      bottom.className = "parcel-line parcel-line-sub";

      const detail = document.createElement("span");
      detail.className = "parcel-sub";
      detail.textContent = sub;
      bottom.appendChild(detail);

      if (item.expected) {
        const due = document.createElement("span");
        due.className = "parcel-due";
        due.textContent = `Due ${item.expected}`;
        bottom.appendChild(due);
      }
      row.appendChild(bottom);
    }

    const opacity = this.fadeOpacity(index, count, fadePoint);
    if (opacity < 1) row.style.opacity = opacity;

    return row;
  },

  /* The same curve MagicMirror's own calendar and newsfeed modules use, so the
   * list fades at the same rate as everything else on the mirror. */
  fadeOpacity (index, count, fadePoint) {
    const point = typeof fadePoint === "number" && fadePoint > 0 && fadePoint < 1
      ? fadePoint
      : 0;
    if (!point) return 1;
    const start = count * point;
    const steps = count - start;
    if (index < start || steps <= 0) return 1;
    return Math.max(0.15, 1 - (index - start) / steps);
  },

  note (text, className) {
    const element = document.createElement("div");
    element.className = className ? `parcel-note ${className}` : "parcel-note";
    element.textContent = text;
    return element;
  }
});
