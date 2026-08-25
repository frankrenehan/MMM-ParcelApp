/* A minimal DOM and MagicMirror stub, just enough to run the frontend's
 * getDom() outside Electron. Not a test file itself — test/render.test.js and
 * tools/preview.js both use it. Kept dependency-free like the rest.
 */
"use strict";

const path = require("node:path");

const VOID_TAGS = new Set(["br", "hr", "img", "input"]);

const escapeHtml = (text) => String(text)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const createElement = (tag) => {
  const element = {
    tagName: tag,
    className: "",
    style: {},
    textContent: "",
    children: [],
    appendChild (child) { this.children.push(child); return child; },
    classList: {
      add (...names) {
        const current = new Set(String(element.className).split(/\s+/).filter(Boolean));
        for (const name of names) current.add(name);
        element.className = [...current].join(" ");
      },
      contains (name) {
        return String(element.className).split(/\s+/).includes(name);
      }
    }
  };
  return element;
};

const serialise = (element, indent = "") => {
  if (!element) return "";
  const classAttr = element.className ? ` class="${escapeHtml(element.className)}"` : "";
  const styleEntries = Object.entries(element.style || {})
    .filter(([, value]) => value !== "" && value !== undefined);
  const styleAttr = styleEntries.length
    ? ` style="${styleEntries.map(([k, v]) => `${k}: ${v}`).join("; ")}"`
    : "";
  const open = `${indent}<${element.tagName}${classAttr}${styleAttr}>`;

  if (VOID_TAGS.has(element.tagName)) return `${open}\n`;
  if (!element.children.length)
    return `${open}${escapeHtml(element.textContent)}</${element.tagName}>\n`;

  const inner = element.children
    .map((child) => serialise(child, `${indent}  `)).join("");
  return `${open}\n${inner}${indent}</${element.tagName}>\n`;
};

/* Text content only, which is what "must not appear in the DOM" really means. */
const textOf = (element) => {
  if (!element) return "";
  if (!element.children.length) return element.textContent;
  return element.children.map(textOf).join("\n");
};

const loadDefinition = () => {
  let definition = null;
  global.Module = { register: (name, def) => { definition = def; } };
  const modulePath = path.join(__dirname, "..", "MMM-ParcelApp.js");
  delete require.cache[require.resolve(modulePath)];
  require(modulePath);
  delete global.Module;
  if (!definition) throw new Error("MMM-ParcelApp.js did not register a module");
  return definition;
};

/* Returns an instance wired up the way MagicMirror wires one, plus a record of
 * everything it tried to do to the outside world. */
const createInstance = (userConfig = {}) => {
  const definition = loadDefinition();
  const sent = [];
  const visibility = [];

  const instance = Object.create(definition);
  instance.config = { ...definition.defaults, ...userConfig };
  instance.identifier = "module_1_MMM-ParcelApp";
  instance.hidden = false;
  instance.data = { header: null };
  instance.domUpdates = 0;

  instance.sendSocketNotification = (notification, payload) =>
    sent.push({ notification, payload });
  instance.updateDom = () => { instance.domUpdates += 1; };
  instance.hide = (speed, ...rest) => {
    visibility.push({ action: "hide", options: rest[rest.length - 1] });
    instance.hidden = true;
  };
  instance.show = (speed, ...rest) => {
    visibility.push({ action: "show", options: rest[rest.length - 1] });
    instance.hidden = false;
  };

  return { instance, sent, visibility };
};

/* getDom() touches the global document, exactly as it does in the renderer. */
const render = (instance) => {
  const previous = global.document;
  global.document = { createElement };
  try {
    return instance.getDom();
  } finally {
    if (previous === undefined) delete global.document;
    else global.document = previous;
  }
};

module.exports = { createElement, createInstance, render, serialise, textOf, escapeHtml };
