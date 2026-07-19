// Standalone-layout fixture app: "/" is healthy, "/leaky" retains ~8 KB per
// request in a module-level array — the exact phase-0 user-code leak pattern.
import http from "node:http";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "127.0.0.1";

const requestCache = [];

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
    res.end(JSON.stringify({ ok: true }));
  })
  .listen(port, hostname);
