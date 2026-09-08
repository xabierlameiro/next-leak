// Accepts every connection and then destroys the socket without answering —
// what a rewrite proxy does when its upstream is gone. The port is open, so
// "never listened" is the one thing this app is not doing.
import http from "node:http";

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOSTNAME ?? "127.0.0.1";

http
  .createServer((req, res) => {
    res.socket?.destroy();
  })
  .listen(port, hostname);
