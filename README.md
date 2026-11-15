# 🐱 Watchcat

[中文说明](README-CN.md)

A local Agent session monitor accessible from your LAN.

Supported sources include Claude Code, Codex, Kimi Code, DeepSeek Harness, Cetus, OpenClaw, and Hermes. Cetus sessions are discovered from `~/Library/Application Support/dev.cetus.app/sessions`.

## Run

Requires Node.js 18 or later.

```sh
npm install
npm start
```

Watchcat prints the local and LAN URLs at startup. It uses port `3789` by default; set a different port with `PORT=8080 npm start`.

Remote sessions are cached in `~/.watchcat/remote`. During scans, unchanged caches older than 24 hours with no open process handles are compressed to `.jsonl.gz`. History reads decompress them on demand; updated or reopened remote sessions return to JSONL for incremental syncing. Both formats remain readable after restarts.

## Kimi Code

Kimi Code sessions are discovered from `~/.kimi-code/sessions` (Node CLI, override with `KIMI_CODE_HOME`) and `~/.kimi/sessions` (legacy Python CLI, override with `KIMI_SHARE_DIR`). Supports messages, reasoning, tools, token usage, and Node subagents; legacy `context.jsonl` files are supported when no event log is available.

Kimi prices were verified on 2026-10-24 against the [official USD API pricing table](https://platform.kimi.ai/docs/pricing/chat). K3.1 Pro costs $2 input / $0.20 cached input / $10 output per million tokens; HighSpeed costs $4 / $0.20 / $20. Cache writes use the listed 5m and 1h rates. These are API-equivalent estimates, not Kimi Code subscription charges. Logs without model or usage information retain unknown costs.

## Security

Watchcat listens on `0.0.0.0`, and session logs may contain sensitive information. Use it only on a trusted network.
