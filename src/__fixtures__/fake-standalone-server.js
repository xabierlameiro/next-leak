// Minimal stand-in for `.next/standalone/server.js`: honors the same
// PORT/HOSTNAME contract. The launcher must not care what framework runs.
import http from "node:http";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "127.0.0.1";

http
  .createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  })
  .listen(port, hostname);
