# 🐱 Watchcat

[English](README.md)

一个可通过局域网访问的本机 Agent 会话监控面板。

支持 Claude Code、Codex、Kimi Code、DeepSeek Harness、Cetus、OpenClaw 和 Hermes。Cetus 会话会从 `~/Library/Application Support/dev.cetus.app/sessions` 自动发现。

## 运行

需要 Node.js 18 或更高版本。

```sh
npm install
npm start
```

Watchcat 启动时会打印本机和局域网访问地址。默认端口为 `3789`，可通过 `PORT=8080 npm start` 修改。

远端会话缓存保存在 `~/.watchcat/remote`。扫描时，连续 24 小时未更新且未被进程打开的缓存会自动压缩为 `.jsonl.gz`；查看历史记录时直接解压读取，远端日志再次更新或被打开时恢复为 JSONL，以便追加同步。已有 JSONL 和 gzip 缓存均可在重启后继续读取。

## Kimi Code

Kimi Code 会话会从 `~/.kimi-code/sessions`（新版 Node CLI，可用 `KIMI_CODE_HOME` 覆盖）和 `~/.kimi/sessions`（旧版 Python CLI，可用 `KIMI_SHARE_DIR` 覆盖）自动发现。支持对话、思考、工具调用、token 用量及新版子代理；没有事件日志的旧会话回退到 `context.jsonl`。

Kimi 价格于 2026-10-24 根据[官方美元 API 价格表](https://platform.kimi.ai/docs/pricing/chat)核对：K3.1 Pro 每百万 token 的输入 / 缓存命中 / 输出为 $2 / $0.20 / $10，高速版为 $4 / $0.20 / $20；缓存写入区分 5 分钟与 1 小时费率。显示的是 API 等价估算，不是 Kimi Code 订阅实际扣费；缺少模型或用量信息的日志保持费用未知。

## 安全说明

Watchcat 监听 `0.0.0.0`，会话日志可能包含敏感信息，请仅在可信网络中使用。
