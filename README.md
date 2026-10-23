# 🐱 Watchcat

[中文说明](README-CN.md)

A local Agent session monitor accessible from your LAN.

Supported sources include Claude Code, Codex, DeepSeek Harness, Cetus, OpenClaw, and Hermes. Cetus sessions are discovered from `~/Library/Application Support/dev.cetus.app/sessions`.

## Run

Requires Node.js 18 or later.

```sh
npm install
npm start
```

Watchcat prints the local and LAN URLs at startup. It uses port `3789` by default; set a different port with `PORT=8080 npm start`.

Remote sessions are cached in `~/.watchcat/remote`. During scans, unchanged caches older than 24 hours with no open process handles are compressed to `.jsonl.gz`. History reads decompress them on demand; updated or reopened remote sessions return to JSONL for incremental syncing. Both formats remain readable after restarts.

## Security

Watchcat listens on `0.0.0.0`, and session logs may contain sensitive information. Use it only on a trusted network.
