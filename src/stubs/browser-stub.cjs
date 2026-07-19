// Build-time stand-in for puppeteer/puppeteer-core/xvfb. next-leak parses
// heap snapshots; it must never touch browser tooling. memlab loads these
// packages eagerly at module init, so they need to *exist* — but any actual
// use is a bug we want loud.
"use strict";

function refuse(property) {
  throw new Error(
    `browser tooling is not available in next-leak (attempted to use "${String(property)}"). ` +
      "Heap-snapshot parsing must never reach puppeteer/xvfb — this is a bug, please report it."
  );
}

module.exports = new Proxy(function stub() {}, {
  get(target, property) {
    if (property === "default") {
      return module.exports;
    }
    if (property === "__esModule") {
      return true;
    }
    // Data-only lookups memlab performs at module init — harmless to satisfy.
    if (property === "KnownDevices" || property === "devices") {
      return {};
    }
    return refuse(property);
  },
  apply() {
    return refuse("call");
  },
  construct() {
    return refuse("new");
  },
});
