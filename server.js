#!/usr/bin/env node
// Watchcat: 局域网可访问的 Claude Code / Codex 会话日志监控服务
// 安装依赖后可直接 `node server.js` 启动

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '3789', 10);
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const HERMES_DB = path.join(HOME, '.hermes', 'state.db');
const HERMES_PID_FILE = path.join(HOME, '.hermes', 'gateway.pid');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MARKED_BROWSER_FILE = require.resolve('marked/marked.min.js');
const REMOTE_CACHE_MS = parseInt(process.env.WATCHCAT_REMOTE_CACHE_MS || '5000', 10);
const REMOTE_MAX_FILES = parseInt(process.env.WATCHCAT_REMOTE_MAX_FILES || '10', 10);
const REMOTE_READ_CONCURRENCY = parseInt(process.env.WATCHCAT_REMOTE_READ_CONCURRENCY || '4', 10);
const REMOTE_MAX_BUFFER = parseInt(process.env.WATCHCAT_REMOTE_MAX_BUFFER || String(128 * 1024 * 1024), 10);
const SSH_ARGS = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=5',
  '-o', 'ConnectionAttempts=1',
  '-o', 'ClearAllForwardings=yes',
  '-o', 'ControlMaster=auto',
  '-o', 'ControlPersist=30',
  '-o', 'ControlPath=/tmp/watchcat-ssh-%C',
];

// ---------- 工具 ----------

function safeReadDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function listFilesRecursive(dir, ext, out = []) {
  for (const ent of safeReadDir(dir)) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) listFilesRecursive(p, ext, out);
    else if (ent.isFile() && ent.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------- 模型价格与成本估算 ----------

// 单价均为 USD / 1M tokens，按 Standard API 价格估算。
// 更新于 2026-07-17：
// OpenAI: https://developers.openai.com/api/docs/pricing
// Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
const MODEL_PRICES = [
  { test: /^gpt-5\.6-sol(?:-|$)/, name: 'gpt-5.6-sol', input: 5, cached: .5, output: 30, long: [10, 1, 45] },
  { test: /^gpt-5\.6-terra(?:-|$)/, name: 'gpt-5.6-terra', input: 2.5, cached: .25, output: 15, long: [5, .5, 22.5] },
  { test: /^gpt-5\.6-luna(?:-|$)/, name: 'gpt-5.6-luna', input: 1, cached: .1, output: 6, long: [2, .2, 9] },
  { test: /^gpt-5\.5-pro(?:-|$)/, name: 'gpt-5.5-pro', input: 30, output: 180, long: [60, null, 270] },
  { test: /^gpt-5\.5(?:-|$)/, name: 'gpt-5.5', input: 5, cached: .5, output: 30, long: [10, 1, 45] },
  { test: /^gpt-5\.4-mini(?:-|$)/, name: 'gpt-5.4-mini', input: .75, cached: .075, output: 4.5 },
  { test: /^gpt-5\.4-nano(?:-|$)/, name: 'gpt-5.4-nano', input: .2, cached: .02, output: 1.25 },
  { test: /^gpt-5\.4-pro(?:-|$)/, name: 'gpt-5.4-pro', input: 30, output: 180, long: [60, null, 270] },
  { test: /^gpt-5\.4(?:-|$)/, name: 'gpt-5.4', input: 2.5, cached: .25, output: 15, long: [5, .5, 22.5] },
  { test: /^gpt-5\.3-codex(?:-|$)/, name: 'gpt-5.3-codex', input: 1.75, cached: .175, output: 14 },
  { test: /^claude-(?:fable|mythos)-5(?:-|$)/, name: 'Claude Fable/Mythos 5', input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cached: 1, output: 50 },
  { test: /^claude-opus-4[-.]([5-8])(?:-|$)/, name: 'Claude Opus 4.5+', input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cached: .5, output: 25 },
  { test: /^claude-opus-4[-.]1(?:-|$)/, name: 'Claude Opus 4.1', input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cached: 1.5, output: 75 },
  { test: /^claude-opus-4(?:-|$)/, name: 'Claude Opus 4', input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cached: 1.5, output: 75 },
  { test: /^claude-sonnet-4[-.](?:5|6)(?:-|$)/, name: 'Claude Sonnet 4.5+', input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cached: .3, output: 15 },
  { test: /^claude-sonnet-4(?:-|$)/, name: 'Claude Sonnet 4', input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cached: .3, output: 15 },
  { test: /^claude-haiku-4[-.]5(?:-|$)/, name: 'Claude Haiku 4.5', input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cached: .1, output: 5 },
  { test: /^claude-(?:haiku-3[-.]5|3[-.]5-haiku)(?:-|$)/, name: 'Claude Haiku 3.5', input: .8, cacheWrite5m: 1, cacheWrite1h: 1.6, cached: .08, output: 4 },
  // DeepSeek: https://api-docs.deepseek.com/quick_start/pricing/
  { test: /^deepseek-v4-pro(?:-|$)/, name: 'DeepSeek V4 Pro', input: .435, cached: .003625, output: .87 },
  { test: /^deepseek-v4-flash(?:-|$)/, name: 'DeepSeek V4 Flash', input: .14, cached: .0028, output: .28 },
  { test: /^deepseek-(?:chat|reasoner)(?:-|$)/, name: 'DeepSeek V4 Flash', input: .14, cached: .0028, output: .28 },
];

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase()
    .replace(/^(?:openai|anthropic)\//, '')
    .replace(/^azure-/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function priceForModel(model, usage = {}, now = new Date()) {
  const normalized = normalizeModelName(model);
  // Sonnet 5 的官方推广价截至 2026-08-31，之后自动切换标准价。
  if (/^claude-sonnet-5(?:-|$)/.test(normalized)) {
    const promotional = now < new Date('2026-09-01T00:00:00Z');
    return promotional
      ? { name: 'Claude Sonnet 5', input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cached: .2, output: 10 }
      : { name: 'Claude Sonnet 5', input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cached: .3, output: 15 };
  }
  let price = MODEL_PRICES.find(p => p.test.test(normalized));
  if (!price) return null;
  price = { ...price };

  // Claude Opus fast mode 和 US-only inference 使用官方对应倍率。
  if (usage.speed === 'fast' && /^claude-opus-4[-.]8(?:-|$)/.test(normalized)) {
    Object.assign(price, { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cached: 1 });
  } else if (usage.speed === 'fast' && /^claude-opus-4[-.]7(?:-|$)/.test(normalized)) {
    Object.assign(price, { input: 30, output: 150, cacheWrite5m: 37.5, cacheWrite1h: 60, cached: 3 });
  }
  if (usage.inferenceGeo === 'us' && /^claude-(?:fable|mythos|opus-4[-.][6-8]|sonnet-(?:4[-.]6|5))/.test(normalized)) {
    for (const key of ['input', 'cached', 'cacheWrite5m', 'cacheWrite1h', 'output']) {
      if (price[key] != null) price[key] *= 1.1;
    }
  }
  return price;
}

function normalizedUsage(raw = {}, source) {
  const cached = Number(raw.cached_input_tokens || raw.cache_read_input_tokens || 0);
  const rawInput = Number(raw.input_tokens || 0);
  const cacheCreation = raw.cache_creation || {};
  const cacheWrite1h = Number(cacheCreation.ephemeral_1h_input_tokens || raw.cache_write_1h_tokens || 0);
  let cacheWrite5m = Number(cacheCreation.ephemeral_5m_input_tokens || raw.cache_write_tokens || 0);
  const totalCacheWrite = Number(raw.cache_creation_input_tokens || 0);
  if (!cacheWrite1h && !cacheWrite5m) cacheWrite5m = totalCacheWrite;
  else if (totalCacheWrite > cacheWrite1h + cacheWrite5m) cacheWrite5m += totalCacheWrite - cacheWrite1h - cacheWrite5m;
  // OpenAI usage 的 input_tokens 已包含 cached_input_tokens；Claude/Hermes 的缓存字段独立。
  const input = source === 'codex' ? Math.max(0, rawInput - cached) : rawInput;
  const output = Number(raw.output_tokens || 0);
  const total = source === 'codex'
    ? Number(raw.total_tokens || rawInput + output)
    : input + cached + cacheWrite5m + cacheWrite1h + output;
  return {
    inputTokens: input,
    cachedInputTokens: cached,
    cacheWriteTokens: cacheWrite5m,
    cacheWrite1hTokens: cacheWrite1h,
    outputTokens: output,
    reasoningTokens: Number(raw.reasoning_output_tokens || raw.reasoning_tokens || 0),
    totalTokens: total,
    requestInputTokens: source === 'codex' ? rawInput : input + cached + cacheWrite5m + cacheWrite1h,
    requests: Number(raw.requests || 1),
    speed: raw.speed,
    inferenceGeo: raw.inference_geo,
  };
}

function summarizeUsageRecords(records) {
  if (!records.length) return { usage: null, cost: null };
  const usage = {
    inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, cacheWrite1hTokens: 0,
    outputTokens: 0, reasoningTokens: 0, totalTokens: 0, requests: 0,
  };
  let usd = 0, priced = 0, unpriced = 0;
  const unknownModels = new Set();
  for (const record of records) {
    const u = record.usage;
    for (const key of Object.keys(usage)) usage[key] += Number(u[key] || 0);
    const price = priceForModel(record.model, u);
    if (!price) {
      unpriced++;
      if (record.model) unknownModels.add(record.model);
      continue;
    }
    // OpenAI 1.05M context 模型在单次输入超过 272K 时使用长上下文单价。
    let inputRate = price.input, cachedRate = price.cached, outputRate = price.output;
    if (price.long && u.requestInputTokens / Math.max(1, u.requests || 1) > 272000) {
      [inputRate, cachedRate, outputRate] = price.long;
    }
    usd += (u.inputTokens * (inputRate || 0) +
      u.cachedInputTokens * (cachedRate == null ? inputRate : cachedRate) +
      u.cacheWriteTokens * (price.cacheWrite5m == null ? inputRate : price.cacheWrite5m) +
      u.cacheWrite1hTokens * (price.cacheWrite1h == null ? inputRate : price.cacheWrite1h) +
      u.outputTokens * (outputRate || 0)) / 1e6;
    priced++;
  }
  return {
    usage,
    cost: priced ? { usd, currency: 'USD', complete: unpriced === 0, unknownModels: [...unknownModels] }
      : { usd: null, currency: 'USD', complete: false, unknownModels: [...unknownModels] },
  };
}

// ---------- 运行状态检测 (lsof) ----------

let openFilesCache = { at: 0, files: new Set() };

function getOpenJsonlFiles() {
  return new Promise((resolve) => {
    if (Date.now() - openFilesCache.at < 3000) return resolve(openFilesCache.files);
    execFile('lsof', ['-F', 'n', '-c', 'claude', '-c', 'codex', '-c', 'node'],
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        const files = new Set();
        if (stdout) {
          for (const line of stdout.split('\n')) {
            if (line.startsWith('n') && line.endsWith('.jsonl')) files.add(line.slice(1));
          }
        }
        openFilesCache = { at: Date.now(), files };
        resolve(files);
      });
  });
}

// ---------- 会话解析(带缓存) ----------

const summaryCache = new Map(); // path -> { mtimeMs, size, summary }

function parseJsonLines(content) {
  const out = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 忽略截断行 */ }
  }
  return out;
}

function parseLines(file) {
  return parseJsonLines(fs.readFileSync(file, 'utf8'));
}

function isNoiseUserText(text) {
  return /^\s*(<system-reminder>|<local-command|<command-name|<bash-(input|stdout|stderr)|Caveat:)/.test(text);
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
  }
  return '';
}

// Claude Code 会话摘要
function summarizeClaude(file, stat, content) {
  const lines = content == null ? parseLines(file) : parseJsonLines(content);
  let cwd = null, firstUserText = null, summaryTitle = null, gitBranch = null, version = null, model = null;
  let firstTs = null, lastTs = null, userCount = 0, assistantCount = 0, lastEventText = null;
  let sessionId = path.basename(file, '.jsonl');
  let contextTokens = null;
  const models = new Set();
  const usageByMessage = new Map();

  for (const l of lines) {
    if (l.timestamp) { if (!firstTs) firstTs = l.timestamp; lastTs = l.timestamp; }
    if (l.cwd && !cwd) cwd = l.cwd;
    if (l.gitBranch) gitBranch = l.gitBranch;
    if (l.version) version = l.version;
    if (l.sessionId) sessionId = l.sessionId;
    if (l.type === 'summary' && l.summary) summaryTitle = l.summary;
    if (l.type === 'user' && l.message && !l.isSidechain && !l.isMeta) {
      const text = extractText(l.message.content);
      if (text && !isNoiseUserText(text)) {
        userCount++;
        if (!firstUserText) firstUserText = text;
      }
    }
    if (l.type === 'assistant' && l.message && !l.isSidechain) {
      if (l.message.model && l.message.model !== '<synthetic>') {
        model = l.message.model;
        models.add(model);
      }
      const text = extractText(l.message.content);
      if (text) { assistantCount++; lastEventText = text; }
      const u = l.message.usage;
      if (u && u.input_tokens != null) {
        contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        const messageKey = l.message.id || l.requestId || l.uuid;
        usageByMessage.set(messageKey || `line:${usageByMessage.size}`, {
          model: l.message.model && l.message.model !== '<synthetic>' ? l.message.model : model,
          usage: normalizedUsage(u, 'claude'),
        });
      }
    }
  }
  if (!firstUserText && !assistantCount) return null; // 空会话不展示

  const totals = summarizeUsageRecords([...usageByMessage.values()]);

  return {
    source: 'claude',
    id: sessionId,
    file,
    project: cwd || decodeClaudeDirName(path.basename(path.dirname(file))),
    title: truncate(summaryTitle || firstUserText || '(无标题)', 80),
    lastMessage: truncate(lastEventText || '', 120),
    firstTs, lastTs,
    turns: userCount + assistantCount,
    gitBranch, version,
    model,
    models: [...models],
    contextTokens,
    usage: totals.usage,
    cost: totals.cost,
    sizeBytes: stat.size,
  };
}

// 目录名如 -Users-wangrunji-Codes-foo,尽力还原(仅作 cwd 缺失时的兜底)
function decodeClaudeDirName(name) {
  return name.replace(/-/g, '/');
}

// Codex 会话摘要
function summarizeCodex(file, stat, content) {
  const lines = content == null ? parseLines(file) : parseJsonLines(content);
  let cwd = null, sessionId = path.basename(file, '.jsonl'), source = null, model = null;
  let firstTs = null, lastTs = null, firstUserText = null, lastAgentText = null;
  let userCount = 0, agentCount = 0, contextTokens = null;
  const models = new Set();
  const usageRecords = [];

  for (const l of lines) {
    if (l.timestamp) { if (!firstTs) firstTs = l.timestamp; lastTs = l.timestamp; }
    const p = l.payload || {};
    if (l.type === 'session_meta') {
      cwd = p.cwd || cwd;
      sessionId = p.session_id || p.id || sessionId;
      source = p.originator || p.source || source;
    }
    if (l.type === 'turn_context' && p.model) { model = p.model; models.add(model); }
    if (l.type === 'event_msg') {
      if (p.type === 'user_message' && p.message) {
        userCount++;
        if (!firstUserText) firstUserText = p.message;
      }
      if (p.type === 'agent_message' && p.message) { agentCount++; lastAgentText = p.message; }
      if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
        const u = p.info.last_token_usage;
        contextTokens = u.total_tokens || contextTokens;
        usageRecords.push({ model, usage: normalizedUsage(u, 'codex') });
      }
    }
  }
  if (!firstUserText && !agentCount) return null;
  const totals = summarizeUsageRecords(usageRecords);

  return {
    source: 'codex',
    id: sessionId,
    file,
    project: cwd || '(未知项目)',
    title: truncate(firstUserText || '(无标题)', 80),
    lastMessage: truncate(lastAgentText || '', 120),
    firstTs, lastTs,
    turns: userCount + agentCount,
    gitBranch: null,
    version: source,
    model,
    models: [...models],
    contextTokens,
    usage: totals.usage,
    cost: totals.cost,
    sizeBytes: stat.size,
  };
}

// ---------- Agent Remote SSH ----------

function execFileText(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10000, maxBuffer: REMOTE_MAX_BUFFER, ...options },
      (err, stdout, stderr) => {
        if (err) {
          err.stderr = stderr;
          reject(err);
        } else resolve(stdout);
      });
  });
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function sshCommand(host, script, options = {}) {
  return execFileText('ssh', [...SSH_ARGS, host, `sh -c ${shellQuote(script)}`], options);
}

let remoteHostsCache = { at: 0, hosts: [] };

async function discoverRemoteHosts() {
  if (Date.now() - remoteHostsCache.at < 5000) return remoteHostsCache.hosts;
  const hosts = new Set((process.env.WATCHCAT_SSH_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean));
  try {
    const stdout = await execFileText('ps', ['-ww', '-axo', 'command='], { maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.split('\n')) {
      if (!/(?:^|\/)ssh\s/.test(line) || !line.includes('codex app-server proxy')) continue;
      const commandStart = line.indexOf(' sh -c ');
      if (commandStart < 0) continue;
      // Codex Desktop 的连接格式为: ssh [options] <host> sh -c ...
      const prefix = line.slice(0, commandStart).trim().split(/\s+/);
      const host = prefix[prefix.length - 1];
      if (/^[\w.@:-]+$/.test(host)) hosts.add(host);
    }
  } catch { /* ps 不可用时仍使用显式配置 */ }
  remoteHostsCache = { at: Date.now(), hosts: [...hosts] };
  return remoteHostsCache.hosts;
}

const REMOTE_SCAN_SCRIPT = `
codex_root="\${CODEX_HOME:-$HOME/.codex}/sessions"
claude_root="\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects"
printf 'ROOT\\tcodex\\t%s\\n' "$codex_root"
printf 'ROOT\\tclaude\\t%s\\n' "$claude_root"
if [ -d "$codex_root" ]; then
  if stat -c '%Y' "$codex_root" >/dev/null 2>&1; then
    find "$codex_root" -type f -name '*.jsonl' -exec stat -c 'FILE\tcodex\t%Y\t%s\t%n' {} + 2>/dev/null
  else
    find "$codex_root" -type f -name '*.jsonl' -exec stat -f 'FILE\tcodex\t%m\t%z\t%N' {} + 2>/dev/null
  fi
fi
if [ -d "$claude_root" ]; then
  if stat -c '%Y' "$claude_root" >/dev/null 2>&1; then
    find "$claude_root" -type f -name '*.jsonl' ! -path '*/subagents/*' -exec stat -c 'FILE\tclaude\t%Y\t%s\t%n' {} + 2>/dev/null
  else
    find "$claude_root" -type f -name '*.jsonl' ! -path '*/subagents/*' -exec stat -f 'FILE\tclaude\t%m\t%z\t%N' {} + 2>/dev/null
  fi
fi
if command -v lsof >/dev/null 2>&1; then
  lsof -Fn -c codex -c claude 2>/dev/null | sed -n 's/^n\\(.*\\.jsonl\\)$/OPEN\\t\\1/p'
fi
if command -v pgrep >/dev/null 2>&1 && [ -d /proc ]; then
  for pid in $(pgrep -x claude 2>/dev/null); do
    cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null) || continue
    printf 'ALIVE\\tclaude\\t%s\\n' "$cwd"
  done
elif command -v lsof >/dev/null 2>&1; then
  lsof -a -c claude -d cwd -Fn 2>/dev/null | sed -n 's/^n/ALIVE\\tclaude\\t/p'
fi
`;

function parseRemoteScan(stdout) {
  const result = { roots: {}, files: [], openFiles: new Set(), aliveProjects: {} };
  for (const line of stdout.split('\n')) {
    const fields = line.split('\t');
    if (fields[0] === 'ROOT' && fields.length >= 3) result.roots[fields[1]] = fields.slice(2).join('\t');
    else if (fields[0] === 'FILE' && fields.length >= 5) {
      result.files.push({ kind: fields[1], mtimeMs: Number(fields[2]) * 1000, size: Number(fields[3]), path: fields.slice(4).join('\t') });
    } else if (fields[0] === 'OPEN') result.openFiles.add(fields.slice(1).join('\t'));
    else if (fields[0] === 'ALIVE' && fields.length >= 3) {
      if (!result.aliveProjects[fields[1]]) result.aliveProjects[fields[1]] = new Set();
      result.aliveProjects[fields[1]].add(fields.slice(2).join('\t'));
    }
  }
  result.files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  result.files = result.files.slice(0, REMOTE_MAX_FILES);
  return result;
}

function remoteFileId(kind, host, file) {
  return 'remote-' + kind + ':' + Buffer.from(host + '\0' + file).toString('base64url');
}

const remoteSummaryCache = new Map(); // host\0path -> { mtimeMs, size, content, summary }
const remoteFileIndex = new Map(); // opaque id -> cache entry
let remoteSessionsCache = { at: 0, sessions: [], hosts: [], errors: [] };

async function readRemoteFile(host, file, offset, length) {
  if (length <= 0) return '';
  const quoted = shellQuote(file);
  const script = offset > 0
    ? `tail -c +${offset + 1} ${quoted} | head -c ${length}`
    : `head -c ${length} ${quoted}`;
  return sshCommand(host, script, { timeout: 30000 });
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  const count = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: count }, worker));
  return results;
}

async function scanRemoteHost(host) {
  const scan = parseRemoteScan(await sshCommand(host, REMOTE_SCAN_SCRIPT));
  const entries = await mapLimit(scan.files, REMOTE_READ_CONCURRENCY, async (meta) => {
    try {
      const key = meta.kind + '\0' + host + '\0' + meta.path;
      let cached = remoteSummaryCache.get(key);
      if (!cached || cached.mtimeMs !== meta.mtimeMs || cached.size !== meta.size) {
        const canAppend = cached && meta.size > cached.size;
        const offset = canAppend ? cached.size : 0;
        const chunk = await readRemoteFile(host, meta.path, offset, meta.size - offset);
        const content = canAppend ? cached.content + chunk : chunk;
        const id = remoteFileId(meta.kind, host, meta.path);
        const summary = meta.kind === 'claude'
          ? summarizeClaude(id, { size: meta.size }, content)
          : summarizeCodex(id, { size: meta.size }, content);
        cached = {
          kind: meta.kind, host, path: meta.path, root: scan.roots[meta.kind],
          mtimeMs: meta.mtimeMs, size: meta.size, content, summary,
        };
        remoteSummaryCache.set(key, cached);
      }
      return { meta, cached };
    } catch (error) {
      return { meta, error };
    }
  });

  // Claude 会在每次写入后关闭日志文件；用存活进程的 cwd 关联该项目最新会话。
  const latestAliveClaude = new Map();
  const aliveClaudeProjects = scan.aliveProjects.claude || new Set();
  for (const { meta, cached } of entries) {
    if (!cached || meta.kind !== 'claude' || !cached.summary) continue;
    const project = cached.summary.project;
    if (!aliveClaudeProjects.has(project)) continue;
    const previous = latestAliveClaude.get(project);
    if (!previous || meta.mtimeMs > previous.mtimeMs) latestAliveClaude.set(project, { path: meta.path, mtimeMs: meta.mtimeMs });
  }

  const sessions = [];
  for (const { meta, cached } of entries) {
    if (!cached) continue; // 单个历史日志读取失败不影响同一主机上的其他会话
    if (!cached.summary) continue;
    const s = { ...cached.summary };
    s.remoteHost = host;
    s.remotePath = meta.path;
    s.project = host + ':' + s.project;
    s.version = [s.version, 'SSH ' + host].filter(Boolean).join(' · ');
    const now = Date.now();
    const ageMs = s.lastTs ? now - Date.parse(s.lastTs) : Infinity;
    const mtimeAge = now - meta.mtimeMs;
    const aliveClaude = meta.kind === 'claude' && latestAliveClaude.get(cached.summary.project)?.path === meta.path;
    if (mtimeAge < 60 * 1000) s.status = 'running';
    else if (scan.openFiles.has(meta.path)) s.status = ageMs < 2 * 60 * 1000 ? 'running' : 'open';
    else if (aliveClaude) s.status = 'open';
    else s.status = 'idle';
    sessions.push(s);
    remoteFileIndex.set(s.file, cached);
  }
  return { host, sessions };
}

async function remoteAgentSessions() {
  if (Date.now() - remoteSessionsCache.at < REMOTE_CACHE_MS) return remoteSessionsCache;
  const hosts = await discoverRemoteHosts();
  const results = await Promise.allSettled(hosts.map(scanRemoteHost));
  const sessions = [], errors = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') sessions.push(...result.value.sessions);
    else errors.push({ host: hosts[i], error: result.reason && result.reason.message || 'SSH failed' });
  }
  remoteSessionsCache = { at: Date.now(), sessions, hosts, errors };
  return remoteSessionsCache;
}

function getSummary(file, kind) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = summaryCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.summary;
  let summary = null;
  try {
    summary = kind === 'claude' ? summarizeClaude(file, stat) : summarizeCodex(file, stat);
  } catch (e) {
    summary = null;
  }
  summaryCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
  return summary;
}

// ---------- Hermes (state.db, 需 node:sqlite) ----------

let hermesDb;
function getHermesDb() {
  if (hermesDb !== undefined) return hermesDb;
  try {
    const { DatabaseSync } = require('node:sqlite');
    hermesDb = fs.existsSync(HERMES_DB) ? new DatabaseSync(HERMES_DB, { readOnly: true }) : null;
  } catch {
    hermesDb = null; // node < 22.5 无内置 sqlite,静默跳过 hermes
  }
  return hermesDb;
}

function hermesGatewayAlive() {
  try {
    const { pid } = JSON.parse(fs.readFileSync(HERMES_PID_FILE, 'utf8'));
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

let hermesCache = { at: 0, sessions: [] };

function hermesSessions() {
  const db = getHermesDb();
  if (!db) return [];
  if (Date.now() - hermesCache.at < 3000) return hermesCache.sessions;
  const rows = db.prepare(`
    SELECT s.id, s.source, s.title, s.cwd, s.git_branch, s.started_at, s.ended_at, s.message_count,
      (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'user'
         AND m.content IS NOT NULL AND m.content NOT LIKE '[IMPORTANT:%' ORDER BY m.timestamp LIMIT 1) AS first_user,
      (SELECT m.content FROM messages m WHERE m.session_id = s.id AND m.role = 'assistant'
         AND m.content != '' ORDER BY m.timestamp DESC LIMIT 1) AS last_assistant,
      (SELECT MAX(m.timestamp) FROM messages m WHERE m.session_id = s.id) AS last_msg_ts,
      (SELECT SUM(u.input_tokens + u.cache_read_tokens) FROM session_model_usage u WHERE u.session_id = s.id) AS ctx_in,
      (SELECT SUM(u.api_call_count) FROM session_model_usage u WHERE u.session_id = s.id) AS api_calls
    FROM sessions s WHERE s.archived = 0
  `).all();
  const usageBySession = new Map();
  const usageRows = db.prepare(`
    SELECT session_id, model, api_call_count, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, reasoning_tokens, last_seen
    FROM session_model_usage
  `).all();
  for (const u of usageRows) {
    if (!usageBySession.has(u.session_id)) usageBySession.set(u.session_id, []);
    usageBySession.get(u.session_id).push(u);
  }
  const alive = hermesGatewayAlive();
  const now = Date.now();
  const sessions = [];
  for (const r of rows) {
    if (!r.first_user && !r.last_assistant) continue;
    const modelRows = usageBySession.get(r.id) || [];
    modelRows.sort((a, b) => Number(a.last_seen || 0) - Number(b.last_seen || 0));
    const usageRecords = modelRows.map(u => ({
      model: u.model,
      usage: normalizedUsage({
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_input_tokens: u.cache_read_tokens,
        cache_write_tokens: u.cache_write_tokens,
        reasoning_tokens: u.reasoning_tokens,
        requests: u.api_call_count,
      }, 'hermes'),
    }));
    const totals = summarizeUsageRecords(usageRecords);
    const lastSec = r.last_msg_ts || r.ended_at || r.started_at;
    const lastTs = lastSec ? new Date(lastSec * 1000).toISOString() : null;
    const s = {
      source: 'hermes',
      id: r.id,
      file: 'hermes:' + r.id,
      project: r.cwd || 'hermes://' + (r.source || 'unknown'),
      title: truncate(r.title || r.first_user || '(无标题)', 80),
      lastMessage: truncate(r.last_assistant || '', 120),
      firstTs: r.started_at ? new Date(r.started_at * 1000).toISOString() : null,
      lastTs,
      turns: r.message_count || 0,
      gitBranch: r.git_branch || null,
      version: r.source,
      model: modelRows.length ? modelRows[modelRows.length - 1].model : null,
      models: [...new Set(modelRows.map(u => u.model).filter(Boolean))],
      // messages 表无逐条 token,用累计用量 / 调用次数估算单次请求的平均 context
      contextTokens: r.api_calls > 0 ? Math.round(Number(r.ctx_in || 0) / Number(r.api_calls)) : null,
      usage: totals.usage,
      cost: totals.cost,
      sizeBytes: 0,
    };
    const ageMs = lastSec ? now - lastSec * 1000 : Infinity;
    if (alive && ageMs < 2 * 60 * 1000) s.status = 'running';
    else if (alive && r.ended_at == null) s.status = 'open';
    else s.status = 'idle';
    sessions.push(s);
  }
  hermesCache = { at: Date.now(), sessions };
  return sessions;
}

function detailHermes(sessionId) {
  const db = getHermesDb();
  if (!db) throw httpError(404, 'hermes db unavailable');
  const rows = db.prepare(`
    SELECT role, content, tool_name, tool_calls, reasoning, timestamp
    FROM messages WHERE session_id = ? ORDER BY timestamp, id
  `).all(sessionId);
  const msgs = [];
  for (const r of rows) {
    const ts = r.timestamp ? new Date(r.timestamp * 1000).toISOString() : null;
    if (r.role === 'user' && r.content) {
      msgs.push({ role: 'user', text: r.content, ts });
    } else if (r.role === 'assistant') {
      if (r.reasoning) msgs.push({ role: 'thinking', text: truncate(r.reasoning, 600), ts });
      if (r.content) msgs.push({ role: 'assistant', text: r.content, ts });
      if (r.tool_calls) {
        try {
          for (const tc of JSON.parse(r.tool_calls)) {
            const fn = tc.function || tc;
            const input = truncate(String(fn.arguments || ''), 400);
            msgs.push({ role: 'tool_use', ts, toolName: fn.name || '?', callId: tc.id || null,
              input, text: (fn.name || '?') + ' ' + input });
          }
        } catch {}
      }
    } else if (r.role === 'tool' && r.content) {
      msgs.push({ role: 'tool_result', ts, text: (r.tool_name ? r.tool_name + ': ' : '') + truncate(r.content, 600) });
    }
  }
  return msgs;
}

// ---------- 会话详情 ----------

function detailClaude(file, content) {
  const lines = content == null ? parseLines(file) : parseJsonLines(content);
  const msgs = [];
  for (const l of lines) {
    if (l.isSidechain) continue;
    if (l.type === 'summary' && l.summary) {
      msgs.push({ role: 'divider', text: '摘要: ' + l.summary, ts: null });
    } else if (l.type === 'user' && l.message && !l.isMeta) {
      const c = l.message.content;
      if (typeof c === 'string') {
        if (!isNoiseUserText(c)) msgs.push({ role: 'user', text: c, ts: l.timestamp });
      } else if (Array.isArray(c)) {
        for (const item of c) {
          if (item.type === 'text' && item.text && !isNoiseUserText(item.text)) {
            msgs.push({ role: 'user', text: item.text, ts: l.timestamp });
          } else if (item.type === 'tool_result') {
            const text = extractText(item.content) || (typeof item.content === 'string' ? item.content : '');
            const output = truncate(text, 600);
            msgs.push({ role: 'tool_result', output, text: output, callId: item.tool_use_id || null, ts: l.timestamp });
          }
        }
      }
    } else if (l.type === 'assistant' && l.message && Array.isArray(l.message.content)) {
      for (const item of l.message.content) {
        if (item.type === 'text' && item.text) {
          msgs.push({ role: 'assistant', text: item.text, ts: l.timestamp });
        } else if (item.type === 'thinking' && item.thinking) {
          msgs.push({ role: 'thinking', text: truncate(item.thinking, 600), ts: l.timestamp });
        } else if (item.type === 'tool_use') {
          const input = truncate(JSON.stringify(item.input || {}), 400);
          msgs.push({
            role: 'tool_use', ts: l.timestamp, toolName: item.name, callId: item.id || null, input,
            text: item.name + ' ' + input,
          });
        }
      }
    }
  }
  return msgs;
}

function detailCodex(file, content) {
  const lines = content == null ? parseLines(file) : parseJsonLines(content);
  const msgs = [];
  for (const l of lines) {
    const p = l.payload || {};
    if (l.type === 'event_msg') {
      if (p.type === 'user_message' && p.message) msgs.push({ role: 'user', text: p.message, ts: l.timestamp });
      else if (p.type === 'agent_message' && p.message) msgs.push({ role: 'assistant', text: p.message, ts: l.timestamp });
      else if (p.type === 'agent_reasoning' && p.text) msgs.push({ role: 'thinking', text: truncate(p.text, 600), ts: l.timestamp });
    } else if (l.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        const input = truncate(String(p.arguments ?? p.input ?? ''), 400);
        msgs.push({ role: 'tool_use', ts: l.timestamp, toolName: p.name || '?', callId: p.call_id || null,
          input, text: (p.name || '?') + ' ' + input });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const out = typeof p.output === 'string' ? p.output : (p.output && p.output.content) || JSON.stringify(p.output || '');
        const output = truncate(String(out), 600);
        msgs.push({ role: 'tool_result', ts: l.timestamp, callId: p.call_id || null, output, text: output });
      }
    }
  }
  return msgs;
}

// ---------- API ----------

async function apiSessions() {
  const claudeFiles = [];
  for (const ent of safeReadDir(CLAUDE_DIR)) {
    if (!ent.isDirectory()) continue;
    for (const f of safeReadDir(path.join(CLAUDE_DIR, ent.name))) {
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        claudeFiles.push(path.join(CLAUDE_DIR, ent.name, f.name));
      }
    }
  }
  const codexFiles = listFilesRecursive(CODEX_DIR, '.jsonl');
  const openFiles = await getOpenJsonlFiles();
  const now = Date.now();

  const sessions = [];
  for (const f of claudeFiles) {
    const s = getSummary(f, 'claude');
    if (s) sessions.push(s);
  }
  for (const f of codexFiles) {
    const s = getSummary(f, 'codex');
    if (s) sessions.push(s);
  }

  const remote = await remoteAgentSessions();
  sessions.push(...remote.sessions);

  for (const s of sessions) {
    if (s.remoteHost) continue; // 远端状态已在对应主机上判定
    const ageMs = s.lastTs ? now - Date.parse(s.lastTs) : Infinity;
    let mtimeAge = Infinity;
    try { mtimeAge = now - fs.statSync(s.file).mtimeMs; } catch {}
    // Claude Code 写完即关句柄,lsof 抓不到,用 mtime 新鲜度兜底
    if (mtimeAge < 60 * 1000) s.status = 'running';
    else if (openFiles.has(s.file)) s.status = ageMs < 2 * 60 * 1000 ? 'running' : 'open';
    else s.status = 'idle';
  }

  sessions.push(...hermesSessions()); // hermes 的状态在读取时已确定

  // 按项目 (cwd) 分组
  const groups = new Map();
  for (const s of sessions) {
    if (!groups.has(s.project)) groups.set(s.project, []);
    groups.get(s.project).push(s);
  }
  const projects = [...groups.entries()].map(([project, list]) => {
    list.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
    return {
      project,
      name: project.startsWith(HOME) ? '~' + project.slice(HOME.length) : project,
      lastTs: list[0].lastTs,
      running: list.filter(s => s.status === 'running').length,
      open: list.filter(s => s.status === 'open').length,
      sessions: list,
    };
  });
  // 有运行中的排最前,其余按最近活动排序
  projects.sort((a, b) => (b.running - a.running) || (b.lastTs || '').localeCompare(a.lastTs || ''));
  return {
    projects,
    generatedAt: new Date().toISOString(),
    remoteHosts: remote.hosts,
    remoteErrors: remote.errors,
  };
}

function apiSessionDetail(query) {
  const file = query.get('file');
  if (!file) throw httpError(400, 'missing file');
  if (file.startsWith('hermes:')) {
    const id = file.slice('hermes:'.length);
    if (!/^[\w.-]+$/.test(id)) throw httpError(400, 'bad hermes session id');
    return { file, source: 'hermes', messages: detailHermes(id) };
  }
  if (file.startsWith('remote-codex:') || file.startsWith('remote-claude:')) {
    const remote = remoteFileIndex.get(file);
    if (!remote) throw httpError(404, 'remote session not found; refresh sessions first');
    const messages = remote.kind === 'claude'
      ? detailClaude(file, remote.content)
      : detailCodex(file, remote.content);
    return { file, source: remote.kind, remoteHost: remote.host, messages };
  }
  const resolved = path.resolve(file);
  const inClaude = resolved.startsWith(CLAUDE_DIR + path.sep);
  const inCodex = resolved.startsWith(CODEX_DIR + path.sep);
  if ((!inClaude && !inCodex) || !resolved.endsWith('.jsonl')) throw httpError(403, 'forbidden path');
  if (!fs.existsSync(resolved)) throw httpError(404, 'not found');
  const messages = inClaude ? detailClaude(resolved) : detailCodex(resolved);
  return { file: resolved, source: inClaude ? 'claude' : 'codex', messages };
}

function httpError(code, msg) { const e = new Error(msg); e.statusCode = code; return e; }

// ---------- HTTP server ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/sessions') {
      const data = await apiSessions();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname === '/api/session') {
      const data = apiSessionDetail(url.searchParams);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
      return;
    }
    if (url.pathname === '/vendor/marked.min.js') {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'public, max-age=86400' });
      res.end(fs.readFileSync(MARKED_BROWSER_FILE));
      return;
    }
    // 静态文件
    let rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  } catch (e) {
    res.writeHead(e.statusCode || 500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Watchcat 已启动:`);
    console.log(`  本机:   http://localhost:${PORT}`);
    for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
      for (const a of addrs || []) {
        if (a.family === 'IPv4' && !a.internal) {
          console.log(`  局域网: http://${a.address}:${PORT}  (${name})`);
        }
      }
    }
  });
}

module.exports = {
  apiSessions,
  apiSessionDetail,
  discoverRemoteHosts,
  normalizeModelName,
  normalizedUsage,
  parseRemoteScan,
  priceForModel,
  remoteAgentSessions,
  summarizeClaude,
  summarizeCodex,
  summarizeUsageRecords,
};
