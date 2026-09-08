// Listens, serves the route a run would measure, and is useless on `/`: the
// root redirects between locales forever, the way an i18n middleware does when
// it cannot pick one. A readiness probe that asks for `/` and follows
// redirects declares this app dead; it is not, and `/en/subscription` proves
// it on every request.
import http from "node:http";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "127.0.0.1";

http
  .createServer((req, res) => {
    if (req.url === "/en/subscription") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(307, { location: req.url === "/" ? "/en" : "/" });
    res.end();
  })
  .listen(port, hostname);
