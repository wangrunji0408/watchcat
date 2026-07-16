# 🐈 Watchcat

局域网可访问的本机 Agent 会话监控面板。扫描本机上 **Claude Code**、**Codex** 和 **Hermes** 的 session log，按项目分组展示，并实时显示运行状态。

## 启动

```sh
node server.js
# 或
npm start
```

启动后终端会打印本机与局域网访问地址（默认端口 3789，可用 `PORT=8080 node server.js` 修改）。局域网内任意设备打开 `http://<本机IP>:3789` 即可。

零依赖，只需 Node.js ≥ 18。

## 功能

- **数据来源**
  - Claude Code：`~/.claude/projects/*/*.jsonl`
  - Codex（CLI / Desktop）：`~/.codex/sessions/**/*.jsonl`
  - Remote SSH：自动从 Codex Desktop 的活跃 SSH 连接发现远端主机，同时读取远端 Codex `$CODEX_HOME/sessions/**/*.jsonl` 和 Claude Code `${CLAUDE_CONFIG_DIR:-~/.claude}/projects/*/*.jsonl`；也可用 `WATCHCAT_SSH_HOSTS=host1,host2` 显式配置
  - Hermes：`~/.hermes/state.db`（只读打开 SQLite，需 Node ≥ 22.5 内置 `node:sqlite`，低版本自动跳过）
- **按项目分组**：以会话记录中的 `cwd` 为项目维度；Hermes 会话无 cwd 时按来源渠道分组（如 `hermes://telegram`、`hermes://weixin`）。最近活动的项目排前，有运行中会话的项目置顶。
- **运行状态**（每 5 秒自动刷新）
  - 🟢 运行中：日志文件在最近 1 分钟内有写入，或被存活进程持有且 2 分钟内有活动；Hermes 以 gateway 进程存活 + 2 分钟内有新消息判定
  - 🟡 进程存活：进程仍持有日志文件句柄（`lsof`）但近期无输出；Hermes 为 gateway 存活且会话未标记结束
  - ⚫ 空闲：历史会话
- **日志查看**：点击会话查看完整对话（用户 / 助手消息），可选显示思考过程与工具调用；运行中的会话自动跟随最新输出滚动。

Remote SSH 使用本机现有 SSH 配置和密钥，以 `BatchMode` 只读访问远端。默认最多读取每台主机最近的 10 个会话，并限制为 4 路并发；可通过 `WATCHCAT_REMOTE_MAX_FILES` 和 `WATCHCAT_REMOTE_READ_CONCURRENCY` 调整。

## 安全说明

服务监听 `0.0.0.0`，会话日志可能包含敏感信息，请仅在可信局域网内使用。日志读取接口做了路径白名单校验，只允许访问已扫描到的本地或远端会话日志。
