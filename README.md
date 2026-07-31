# 🐱 Watchcat

[中文说明](README-CN.md)

A local Agent session monitor accessible from your LAN.

## Run

Requires Node.js 18 or later.

```sh
npm install
npm start
```

Watchcat prints the local and LAN URLs at startup. It uses port `3789` by default; set a different port with `PORT=8080 npm start`.

## Security

Watchcat listens on `0.0.0.0`, and session logs may contain sensitive information. Use it only on a trusted network.
