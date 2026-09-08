// A server that fails during startup and does not die: it writes the reason to
// stderr and keeps the event loop alive without ever opening the app port.
// Real apps reach this state when boot awaits something that never resolves —
// and the launcher must hand over what the process said, not just the port it
// never bound.
process.stderr.write("Error: DATABASE_URL is not set\n");
setInterval(() => {}, 1000);
