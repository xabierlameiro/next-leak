// Standalone-layout fixture app: "/" is healthy, "/leaky" retains ~8 KB per
// request in a module-level array — the exact phase-0 user-code leak pattern —
// and "/cached" is a bounded store filling up, which grows every cycle but by
// less each time.
import http from "node:http";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "127.0.0.1";

const requestCache = [];

/**
 * A cache approaching its ceiling, the shape a `use cache` route produces when
 * the load drives it with keys it has never served: growth every cycle, each
 * smaller than the last. Measured on Next 16.3.3 as +603 MB/1000 requests that
 * was entirely the store filling up.
 *
 * Entries arrive on an exponential approach to CAPACITY, so each 300-request
 * cycle adds 40% of what the one before it added. That is the deceleration a
 * leak never shows.
 */
const CAPACITY = 512;
const ENTRY_BYTES = 16 * 1024;
const CYCLE_REQUESTS = 300;
const REMAINING_PER_CYCLE = 0.4;
const store = new Map();
let served = 0;

function fillCacheTowardsCapacity() {
  served += 1;
  const filled = 1 - Math.pow(REMAINING_PER_CYCLE, served / CYCLE_REQUESTS);
  const target = Math.round(CAPACITY * filled);
  while (store.size < target) {
    store.set(store.size, Buffer.alloc(ENTRY_BYTES, store.size & 0xff).toString("latin1"));
  }
  return store.size;
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fixture.local");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/leaky") {
      // Buffer.toString materializes a real 8 KB sequential string. A
      // "z".repeat(8192) would NOT leak 8 KB: V8 represents repeat() as a
      // shared-structure cons rope of ~400 bytes.
      requestCache.push(Buffer.alloc(8192, requestCache.length & 0xff).toString("latin1"));
      res.end(JSON.stringify({ retained: requestCache.length }));
      return;
    }
    if (url.pathname === "/cached") {
      res.end(JSON.stringify({ entries: fillCacheTowardsCapacity() }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  })
  .listen(port, hostname);
