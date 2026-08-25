/* Shared fixture helpers. Not a test file itself. */
"use strict";

/* Every extra_information value the sample response carries.
 *
 * Derived rather than restated. The invariant under test is that whatever sits
 * in that field never reaches the DOM or the logs — a hardcoded list of token
 * strings quietly stops testing anything the moment the fixture is rescrubbed,
 * which is exactly when you would want it to still be working. */
const secretsIn = (data) => ((data && data.deliveries) || [])
  .map((delivery) => delivery && delivery.extra_information)
  .filter((value) => typeof value === "string" && value !== "");

module.exports = { secretsIn };
