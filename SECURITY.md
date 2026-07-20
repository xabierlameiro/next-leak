# Security Policy

next-leak runs your app locally and never sends data anywhere: no telemetry,
no network calls beyond the load it generates against 127.0.0.1.

Heap snapshots can contain values from your application's memory (tokens,
user data present in the process at capture time). Treat `.next-leak/`
output directories as sensitive and do not attach raw snapshots to public
issues — `run.json` is enough.

To report a vulnerability, email xabier.lameiro@gmail.com. You will get a
response within 72 hours.
