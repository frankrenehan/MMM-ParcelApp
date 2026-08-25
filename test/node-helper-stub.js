/* Stands in for MagicMirror's own `node_helper` module so node_helper.js can be
 * loaded and exercised outside a mirror. NodeHelper.create() just hands the
 * definition back; the caller wires up the instance itself.
 */
"use strict";

const path = require("node:path");
const Module = require("node:module");

module.exports = { create: (definition) => definition };

/* Loads node_helper.js with `require("node_helper")` pointed at this file. */
module.exports.loadDefinition = () => {
  const resolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "node_helper") return __filename;
    return resolve.call(this, request, ...rest);
  };
  try {
    const helperPath = path.join(__dirname, "..", "node_helper.js");
    delete require.cache[require.resolve(helperPath)];
    return require(helperPath);
  } finally {
    Module._resolveFilename = resolve;
  }
};
