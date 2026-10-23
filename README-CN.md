# 🐱 Watchcat

[English](README.md)

一个可通过局域网访问的本机 Agent 会话监控面板。

支持 Claude Code、Codex、DeepSeek Harness、Cetus、OpenClaw 和 Hermes。Cetus 会话会从 `~/Library/Application Support/dev.cetus.app/sessions` 自动发现。

## 运行

需要 Node.js 18 或更高版本。

```sh
npm install
npm start
```

Watchcat 启动时会打印本机和局域网访问地址。默认端口为 `3789`，可通过 `PORT=8080 npm start` 修改。

远端会话缓存保存在 `~/.watchcat/remote`。扫描时，连续 24 小时未更新且未被进程打开的缓存会自动压缩为 `.jsonl.gz`；查看历史记录时直接解压读取，远端日志再次更新或被打开时恢复为 JSONL，以便追加同步。已有 JSONL 和 gzip 缓存均可在重启后继续读取。

## 安全说明

Watchcat 监听 `0.0.0.0`，会话日志可能包含敏感信息，请仅在可信网络中使用。
