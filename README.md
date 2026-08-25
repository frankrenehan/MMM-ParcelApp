# MMM-ParcelApp

A [MagicMirror²](https://magicmirror.builders) module that shows parcels that
are on their way, plus anything delivered in the last 48 hours, using the
[Parcel app](https://parcelapp.net)'s external API.

Read-only by design. The Parcel app owns every write; this module only ever
performs `GET` requests.

```
● Replacement filter for the boiler          Exception
  09:12 · Deutsche Post · Customs clearance required
● Passport renewal documents           Ready to collect
  16:02 · FedEx · Awaiting collection         Due Tue 09:00
  Standing desk motor                   Out for delivery
  07:41 · UPS · Out for delivery              Due Mon 18:00
  5 preparing for shipment
  Cat litter, 12kg                             Delivered
  11:14 · Amazon US · Delivered to the porch
```

The three states that mean *you have to do something* — exception, failed
delivery attempt, and ready to collect — are sorted to the top, marked, and
coloured. Everything else is informational and fades down the list.

This is not a fork of MMM-Parcel, which talks to Tracktry and AfterShip. It
shares no code with it.

## Requirements

- MagicMirror² with Node 20 or newer (uses Node's global `fetch`).
- A Parcel app **Premium** subscription, which is what the external API needs.
- An API key from the Parcel app: **Settings → Parcel Premium → API access**.

No runtime dependencies. There is nothing to `npm install`.

## Install

```bash
cd ~/MagicMirror/modules
git clone <this repo> MMM-ParcelApp
```

## The API key

The key is read from an environment variable. The config names the variable; it
never holds the value, so nothing secret ends up in `config.js` or in git.

Under pm2, put it in the ecosystem file rather than in your shell profile —
pm2 does not inherit a login shell's environment:

```js
// ~/ecosystem.config.js
module.exports = {
  apps: [{
    name: "MagicMirror",
    script: "npm",
    args: "run start",
    cwd: "/home/pi/MagicMirror",
    env: { PARCEL_API_KEY: "your-key-here" }
  }]
};
```

Then re-read the ecosystem file — **pass the file, not the app name**:

```bash
pm2 restart ~/ecosystem.config.js --update-env
```

`pm2 restart MagicMirror --update-env` looks like it should work and does not.
Restarting by name refreshes the environment from the *current shell*, which
does not have your new variable in it, so the module comes back up still
reporting the key as unset. If it will not take at all, the blunt version always
works:

```bash
pm2 delete MagicMirror && pm2 start ~/ecosystem.config.js
```

To confirm pm2 actually has the variable, without printing the key itself:

```bash
pm2 env 0 | grep -c PARCEL_API_KEY
```

`1` means it is there, `0` means it is not (use the id from `pm2 list` if
MagicMirror is not process 0). The module says which it found in the log:

```bash
pm2 logs MagicMirror --lines 100 --nostream | grep ParcelApp
```

`polling every 20 min` on startup means the key was read. `environment variable
PARCEL_API_KEY is not set` means it was not.

Keep that file out of git. If the variable is unset the module logs an error at
startup and shows `Parcel: API key not configured` rather than failing quietly.

## Configuration

```js
{
  module: "MMM-ParcelApp",
  position: "top_right",
  header: "Deliveries",             // optional, handled by MagicMirror itself
  config: {
    apiKeyEnvVar: "PARCEL_API_KEY", // name of the env var, not the key
    updateInterval: 20 * 60 * 1000, // 20 min
    maxItems: 6,
    deliveredWindowHours: 48,
    notFoundGraceHours: 24,
    showCarrier: true,
    showExpectedDate: true,
    hideWhenEmpty: true,
    fadePoint: 0.4
  }
}
```

| Option | Default | Notes |
|---|---|---|
| `apiKeyEnvVar` | `"PARCEL_API_KEY"` | Name of the environment variable holding the key. |
| `updateInterval` | `1200000` (20 min) | Clamped to a **5 minute floor**. See below. |
| `maxItems` | `6` | Rows to display. The collapsed summary row counts as one. |
| `deliveredWindowHours` | `48` | How long a delivered parcel stays on screen. |
| `notFoundGraceHours` | `24` | How long a "not found" stays dim before being promoted. |
| `showCarrier` | `true` | Show the carrier name in the second line. |
| `showExpectedDate` | `true` | Show the expected delivery date or window. |
| `hideWhenEmpty` | `true` | Hide the module entirely when there is nothing to show. |
| `fadePoint` | `0.4` | Fraction of the list before rows start to fade. `0` disables. |

Every value is validated at startup. Numbers are clamped into range rather than
rejected, so a typo degrades the display instead of breaking it.

The three boolean options — `showCarrier`, `showExpectedDate` and
`hideWhenEmpty` — accept `true` and `false` only. Anything else is reported in
the log and replaced with the option's default. There is deliberately no
truthy/falsy coercion: `showCarrier: "false"` is a quoted string, and
`Boolean("false")` is `true`, so coercing it would mean the exact opposite of
what the line reads like. It is treated as invalid instead.

### Why the interval is clamped

The API allows **20 requests per hour** and its responses are cached
server-side, so polling faster does not make the data fresher — it only spends
the budget. Twenty minutes is three requests an hour, which leaves headroom for
a restart or two. Anything below five minutes is clamped.

The Parcel backend itself lags the carrier by roughly 45 minutes, and up to 90
in the worst case. Treat what you see as recent, not live.

## What gets displayed

Sorted top to bottom:

| Status | Shown as | Colour |
|---|---|---|
| 7 Exception | Exception | red, marked |
| 6 Failed delivery attempt | Failed attempt | red, marked |
| 3 Awaiting pickup | Ready to collect | amber, marked |
| 5 Not found, older than the grace period | Not found | amber, marked |
| 4 Out for delivery | Out for delivery | green |
| 2 In transit | In transit | white |
| 8 Carrier notified | Label created | dim |
| 5 Not found, within the grace period | Not found | dim |
| 0 Delivered | Delivered | grey, for 48 hours |
| 0 Delivered, date unreadable | Delivered · `Date unknown` | amber, marked, 3 days |
| 1 Frozen | — | never shown |

Within a group the freshest carrier scan comes first.

**Frozen parcels are hidden.** Status 1 is what the Parcel app sets when it has
given up on a tracking number, which makes it a better staleness signal than
anything this module could compute for itself.

**"Not found" gets a grace period.** It is the normal state for the first hours
after adding a parcel, before the carrier's first scan. A *persistent* one
usually means a typo'd tracking number, so after `notFoundGraceHours` it is
promoted into the needs-attention group where you will actually notice it. The
clock runs from the latest event, or from when the module first saw the parcel
if it has no events. That first-seen clock is in memory only, so restarting
MagicMirror restarts it.

**Amazon "preparing for shipment" rows are collapsed.** The Parcel app's Amazon
integration adds every order, and a handful of identical status-8 rows would
push everything that matters off a six-item display. Two or more collapse into
one dim `5 preparing for shipment` line, which counts as a single row.

**`extra_information` is never rendered or logged.** The API documents that it
may contain a postcode or an email address, and this is a display in a shared
room. The field is dropped on receipt.

Descriptions are handled in exactly one place (`formatDescription` in
`parcel-data.js`), so a per-parcel privacy filter can be added there later
without restructuring anything.

### Amazon descriptions look truncated because they are

Amazon titles arrive from the API already cut to 50 characters with an ellipsis
baked in, and the full text is not recoverable. If you want readable titles,
turn on **Apple Intelligence order summaries** under Amazon Integration in the
Parcel app — it generates short titles instead of raw listing names.

### Carrier names

`carrier_code` is an internal code (`dp`, `amzlus`, `anpost`). The module fetches
the [published carrier map](https://api.parcel.app/external/supported_carriers.json)
at startup, refreshes it weekly, and caches it to `.cache/carriers.json`. An
unknown code falls back to the raw code, and a failed fetch is cosmetic only.

A response is only accepted if it actually looks like a carrier map — the
published file carries 300+ entries, so a handful of keys, or anything shaped
like an API error envelope, is rejected rather than cached. Otherwise a single
error page served as JSON with HTTP 200 would leave the mirror showing raw codes
for a week. The same check runs when the cache is read back off disk.

Because it is only cosmetic, the refresh is never waited on: it runs alongside
the delivery fetch rather than in front of it, so a supported-carriers endpoint
that hangs cannot delay parcel state. The cache is read from disk synchronously,
so a mirror that has run before has names straight away.

Note that `carrier_code` is the **origin** carrier, not the final-mile one. A
parcel coded `dp` may well be handed to An Post and delivered by them. That is
the API's behaviour, not a bug in this module.

## When things go wrong

The mirror runs unattended, so every failure has a defined visible state.

| Condition | What you see |
|---|---|
| Environment variable unset | `Parcel: API key not configured`, and an error in the log |
| 401 / 403 | `Parcel: authentication failed`, and polling stops — it will not retry-loop |
| `success: false` | The API's own `error_message`, truncated to one line; parcels stay up for 2 hours, then go |
| Network error | The last good data stays up; after 2 hours it is labelled `Not updating` |
| 429 rate limited | Exponential backoff, capped at one hour |
| Nothing to show | With `hideWhenEmpty`, the module hides — and stays hidden |

Hidden means hidden. Nothing here un-hides the module on a timer; only the
arrival of something worth showing does.

### Why `success: false` behaves the way it does

A `success: false` response carries an `error_message` and nothing else — no
error code, no category, no retryable flag. A passing server-side fault and an
expired subscription arrive in exactly the same shape, and sniffing the message
text for words like "expired" would be a guess dressed up as a policy.

So the module does not try to classify them. It bounds the problem by time
instead: the error line goes up immediately, the parcels stay underneath it, and
once that data passes the same two-hour threshold that marks anything else
stale, it is dropped and the error is left on screen alone. A brief upstream
fault costs nothing; a permanent one cannot leave week-old parcels on the wall.

Authentication failure is the exception, and is cleared at once. It is permanent
and actionable, and polling stops — so no later update would ever arrive to age
those parcels or mark them stale. They would sit there looking current forever.

### Changing the configuration

Configuration is read once, at startup, and the API key comes from the
environment of the process. **Changing any option, or the key, needs a
MagicMirror restart.** The module does not hot-reload: when the frontend
re-announces itself — which it does whenever its DOM is rebuilt — the helper
treats that purely as re-registration and replies with the current data. It does
not reconfigure a running instance, and it will not revive one that has stopped
after an authentication failure.

## Development

```bash
npm test                 # no dependencies, nothing to install
node tools/preview.js    # writes preview.html — the real DOM, the real CSS
```

`preview.html` renders the sample response and the states it does not cover
(needs-action, stale, empty, missing key) so layout changes can be checked in a
browser instead of on the Pi.

The tests need nothing installed — Node's own test runner, no mocks beyond a
stub for MagicMirror's `node_helper` and a forty-line DOM.

| Test file | Covers |
|---|---|
| `test/parse-dates.test.js` | Every date format, garbage input, the January rollover. |
| `test/normalise.test.js` | Filtering, sorting, collapsing, windows, config clamping. |
| `test/render.test.js` | The frontend's DOM, visibility, and fade. |
| `test/helper.test.js` | Polling, backoff, auth failure, offline behaviour, the cache. |
| `test/acceptance.test.js` | The build brief's nine acceptance criteria, end to end. |

`test/acceptance.test.js` is the one to read first: each test is one criterion
from the brief, driven through the whole stack — a canned API response into
`node_helper`, the socket payload it emits into the real frontend, and the
assertions made against the DOM that comes out.

### Layout

| File | Role |
|---|---|
| `MMM-ParcelApp.js` | Frontend. Builds DOM and decides visibility. Nothing else. |
| `node_helper.js` | All network I/O, polling, backoff, and the carrier cache. |
| `parcel-data.js` | Pure functions: parsing, filtering, sorting, formatting. |
| `MMM-ParcelApp.css` | Styling. See the custom properties below. |
| `tools/preview.js` | Renders the module to a standalone HTML page. |
| `test/dom-stub.js`, `test/node-helper-stub.js` | Stand-ins for MagicMirror, so the tests need no mirror. |

`parcel-data.js` exists so the normalisation logic can be unit tested without
MagicMirror installed, and so the helper and the tests share one implementation.
The frontend never holds the API key and never makes a cross-origin request.

### Restyling

Four custom properties are declared on `:root`, so redefining any of them in
`css/custom.css` wins — MagicMirror loads that file after the module's own:

```css
:root {
  --parcel-width: 260px;   /* column width; default 360px */
  --parcel-alert: #ff6b6b; /* exception, failed attempt */
  --parcel-warn:  #ffb454; /* ready to collect, aged "not found" */
  --parcel-good:  #7ddc8c; /* out for delivery */
}
```

### Dates are the hard part

Event dates arrive in at least five carrier-specific formats, and they are
detected by shape rather than by carrier, because carriers outside the sample
will turn up:

```
11.08.2026 10:07              Deutsche Post, An Post
August 12, 2026 22:47         FedEx
2026-08-16 19:00:59.208       FedEx, with milliseconds
2026-08-13 06:22              UPS
Monday, August 24 5:00 PM     Amazon Logistics
Monday, August 24             Amazon Logistics
--//--                        Amazon Logistics, meaning "no date"
```

All six have been checked against a live account: 143 of 143 real event dates
across four carriers parse to the right instant.

Two traps are worth knowing about if you touch `parseEventDate`:

- `new Date("11.08.2026")` reads that as **8 November**. A parcel delivered two
  days ago would get a timestamp three months in the future and would never
  leave the display.
- The Amazon formats carry **no year**. Assuming the current one is right for
  eleven months and catastrophically wrong every January, when a late-December
  event reads as eleven months ahead. Anything more than a week in the future
  rolls back a year.

Two of those formats carry a date but no time, and neither does a `date_expected`
of `00:00:00`. Nothing invents a clock time to fill the gap: the event line shows
the weekday (`Mon · Amazon US · Package left the shipper facility`) and the
expected line shows `Due Tuesday`, never `00:00` or `Tuesday 12:00am`. A real
midnight scan still renders as `00:00`, so the two stay distinguishable.

Nothing is dropped for having an unreadable date. An in-flight parcel is shown
**without** a timestamp. A *delivered* parcel keeps its `Delivered` label but is
marked: it takes the amber needs-attention treatment and reads `Date unknown`
where the time would be. Both log a warning with the unrecognised string so a new
format can be added.

A marked delivery has no date to age out on — there is no delivered-at field
beyond `events[0].date` — so it ages out on when the module first saw it
instead, after three days. That clock starts when the parcel appeared here
rather than when it actually arrived, which is why it is longer than the
48-hour window. It is a retention bound only: no value derived from it is ever
displayed or sorted on. Deliveries whose dates *can* be read still obey the
48-hour window exactly.

Because that clock lives in memory, restarting MagicMirror restarts it — the
same caveat as the "not found" grace period.

Clock components are validated as written rather than by constructing a `Date`
and seeing what comes back: `10:99` rolls silently into the next hour, so
rollover cannot be used to detect it. Minutes must be 00–59, 24-hour hours 00–23,
12-hour hours 1–12. Every pattern is anchored at both ends, so a date trailed by
something unrecognised — a timezone suffix, say — is rejected and logged rather
than half-understood. Times are treated as local throughout; a string carrying an
explicit zone would need its own handling, and guessing would move the instant.

Validation is on the input's ranges, never on whether the constructed date came
back with the hour asked for. A real event logged during a spring-forward
transition names a local time that does not exist; it is normalised, not
rejected.

`test/parse-dates.test.js` covers every format above, out-of-range clocks in each
of them, trailing garbage, a clock-change transition, and a December date
evaluated in January.

## Known limitations

- **How far back `filter_mode=recent` reaches is not documented, and has not
  been confirmed against a live account.** The 48-hour filter is applied here
  regardless, so this only affects how much data crosses the wire.
- Event times are rendered as absolute clock times rather than "2h ago", so
  they cannot go stale between polls. The day boundary can therefore be up to
  one poll interval late in relabelling yesterday's times.
- Times are 24-hour. There is no `timeFormat` option.
- A status code the API does not document is displayed as `Status <n>`, and a
  missing one as `Unknown`, rather than being dropped. Better a row you have to
  ask about than a parcel that silently vanished.
- The first-seen clock is in memory, so it resets when MagicMirror restarts.
  This affects the "not found" grace period and the three-day bound on a
  delivery with an unreadable date: a mirror that restarts daily would keep
  restarting both clocks.
- On a brand new install, with no carrier cache on disk yet, the first poll may
  show raw carrier codes (`amzlus` rather than `Amazon US`). They resolve on the
  next poll and every one after that. This is the price of never letting the
  carrier lookup delay the delivery fetch.

## Not included, deliberately

Adding or editing deliveries (the app owns writes), full event history, maps,
carrier logos, any local database, and push notifications — the phone already
does that last one better.

## Licence

MIT
