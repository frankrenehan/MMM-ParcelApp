# About `deliveries.json`

**This is not real data, and it must not be replaced with real data.**

It began as a real API response and every identifying value was replaced:
tracking numbers, Amazon order numbers, `extra_information` tokens, product
descriptions and locations. This repository is public.

Its *structure* is faithful on purpose, and the tests depend on that:

- descriptions pre-truncated by Amazon to exactly 50 characters, trailing
  U+2026 included — one of them with a space before the ellipsis
- non-ASCII characters (`–`, `”`) in descriptions
- all the real event date formats, including the year-less Amazon ones and the
  `--//--` sentinel
- the real status-code distribution, including enough `status_code: 8` items to
  trigger the collapse rule, and one delivered item inside the 48-hour window

So: change the shape freely, but **do not refresh it from a live account**.
Re-running a real response through here would publish someone's delivery
history, and the original product descriptions revealed family circumstances.

To see what a live account is actually sending without exposing any of it, use
`tools/date-shapes.js` — it reports counts, status codes and date *shapes* with
the values stripped out.
