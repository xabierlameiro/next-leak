// Stands in for `next dev`: the process started forks a renderer that listens,
// the way Next's CLI forks start-server. Both inherit NODE_OPTIONS, so both load
// the bootstrap. The CLI ignores SIGTERM's effect on its fork on purpose: it
// never forwards it, so only stopping the whole group takes the renderer down.
import { fork } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";

if (process.env.FAKE_NEXT_RENDERER === "1") {
  const retained = [];
  http
    .createServer((req, res) => {
      retained.push(Buffer.alloc(1024));
      res.end("ok");
    })
    .listen(Number(process.env.FAKE_NEXT_PORT), process.env.FAKE_NEXT_HOST);
} else {
  const port = process.argv[process.argv.indexOf("-p") + 1];
  const host = process.argv[process.argv.indexOf("-H") + 1];
  fork(fileURLToPath(import.meta.url), [], {
    env: { ...process.env, FAKE_NEXT_RENDERER: "1", FAKE_NEXT_PORT: port, FAKE_NEXT_HOST: host },
  });
  setInterval(() => {}, 1000);
}
