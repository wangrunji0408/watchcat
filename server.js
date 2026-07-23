#!/usr/bin/env node
// Watchcat: 局域网可访问的 Claude Code / Codex / OpenClaw 会话日志监控服务
// 安装依赖后可直接 `node server.js` 启动

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.PORT || '3789', 10);
const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_DIR = path.join(HOME, '.codex', 'sessions');
const OPENCLAW_DIR = path.resolve(process.env.OPENCLAW_STATE_DIR || path.join(HOME, '.openclaw'));
const OPENCLAW_AGENTS_DIR = path.join(OPENCLAW_DIR, 'agents');
const HERMES_DB = path.join(HOME, '.hermes', 'state.db');
const HERMES_PID_FILE = path.join(HOME, '.hermes', 'gateway.pid');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MARKED_BROWSER_FILE = require.resolve('marked/marked.min.js');
const REMOTE_CACHE_MS = parseInt(process.env.WATCHCAT_REMOTE_CACHE_MS || '5000', 10);
const REMOTE_MAX_FILES = parseInt(process.env.WATCHCAT_REMOTE_MAX_FILES || '10', 10);
const REMOTE_READ_CONCURRENCY = parseInt(process.env.WATCHCAT_REMOTE_READ_CONCURRENCY || '4', 10);
const REMOTE_MAX_BUFFER = parseInt(process.env.WATCHCAT_REMOTE_MAX_BUFFER || String(128 * 1024 * 1024), 10);
const REMOTE_HISTORY_DIR = path.resolve(process.env.WATCHCAT_REMOTE_HISTORY_DIR || path.join(HOME, '.watchcat', 'remote'));
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
// 更新于 2026-07-18：
// OpenAI: https://developers.openai.com/api/docs/pricing
// Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
// Kimi: https://platform.kimi.com/docs/pricing
const MODEL_PRICES = [
  { test: /gpt[-.]5[-.]6[-.]sol(?:\b|$)/, name: 'GPT 5.6 Sol', input: 5, cached: .5, output: 30, long: [10, 1, 45] },
  { test: /gpt[-.]5[-.]6[-.]terra(?:\b|$)/, name: 'GPT 5.6 Terra', input: 2.5, cached: .25, output: 15, long: [5, .5, 22.5] },
  { test: /gpt[-.]5[-.]6[-.]luna(?:\b|$)/, name: 'GPT 5.6 Luna', input: 1, cached: .1, output: 6, long: [2, .2, 9] },
  { test: /gpt[-.]5[-.]5[-.]pro(?:\b|$)/, name: 'GPT 5.5 Pro', input: 30, output: 180, long: [60, null, 270] },
  { test: /gpt[-.]5[-.]5(?:\b|$)/, name: 'GPT 5.5', input: 5, cached: .5, output: 30, long: [10, 1, 45] },
  { test: /gpt[-.]5[-.]4[-.]mini(?:\b|$)/, name: 'GPT 5.4 Mini', input: .75, cached: .075, output: 4.5 },
  { test: /gpt[-.]5[-.]4[-.]nano(?:\b|$)/, name: 'GPT 5.4 Nano', input: .2, cached: .02, output: 1.25 },
  { test: /gpt[-.]5[-.]4[-.]pro(?:\b|$)/, name: 'GPT 5.4 Pro', input: 30, output: 180, long: [60, null, 270] },
  { test: /gpt[-.]5[-.]4(?:\b|$)/, name: 'GPT 5.4', input: 2.5, cached: .25, output: 15, long: [5, .5, 22.5] },
  { test: /gpt[-.]5[-.]3[-.]codex(?:\b|$)/, name: 'GPT 5.3 Codex', input: 1.75, cached: .175, output: 14 },
  { test: /(?:fable|mythos)[-.]5(?:\b|$)/, name: 'Claude Fable/Mythos 5', input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cached: 1, output: 50 },
  { test: /opus[-.]4[-.]([5-8])(?:\b|$)/, name: 'Claude Opus 4.5+', input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cached: .5, output: 25 },
  { test: /opus[-.]4[-.]1(?:\b|$)/, name: 'Claude Opus 4.1', input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cached: 1.5, output: 75 },
  { test: /opus[-.]4(?:\b|$)/, name: 'Claude Opus 4', input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cached: 1.5, output: 75 },
  { test: /sonnet[-.]4[-.](?:5|6)(?:\b|$)/, name: 'Claude Sonnet 4.5+', input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cached: .3, output: 15 },
  { test: /sonnet[-.]4(?:\b|$)/, name: 'Claude Sonnet 4', input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cached: .3, output: 15 },
  { test: /haiku[-.]4[-.]5(?:\b|$)/, name: 'Claude Haiku 4.5', input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cached: .1, output: 5 },
  { test: /(?:haiku[-.]3[-.]5|3[-.]5[-.]haiku)(?:\b|$)/, name: 'Claude Haiku 3.5', input: .8, cacheWrite5m: 1, cacheWrite1h: 1.6, cached: .08, output: 4 },
  // DeepSeek: https://api-docs.deepseek.com/quick_start/pricing/
  { test: /deepseek[-.]v4[-.]pro(?:\b|$)/, name: 'DeepSeek V4 Pro', input: .435, cached: .003625, output: .87 },
  { test: /deepseek[-.]v4[-.]flash(?:\b|$)/, name: 'DeepSeek V4 Flash', input: .14, cached: .0028, output: .28 },
  { test: /deepseek[-.](?:chat|reasoner)(?:\b|$)/, name: 'DeepSeek V4 Flash', input: .14, cached: .0028, output: .28 },
  // Kimi: https://platform.kimi.com/docs/pricing
  { test: /kimi[-.]k3(?:\b|$)/, name: 'Kimi K3', input: 3, cached: .3, output: 15 },
  { test: /kimi[-.]k2[-.]7[-.]code[-.]highspeed(?:\b|$)/, name: 'Kimi K2.7 Code HighSpeed', input: 1.9, cached: .38, output: 8 },
  { test: /kimi[-.]k2[-.]7[-.]code(?:\b|$)/, name: 'Kimi K2.7 Code', input: .95, cached: .19, output: 4 },
  { test: /kimi[-.]k2[-.]7(?:\b|$)/, name: 'Kimi K2.7', input: .95, cached: .19, output: 4 },
  { test: /kimi[-.]k2[-.]6(?:\b|$)/, name: 'Kimi K2.6', input: .95, cached: .16, output: 4 },
  { test: /kimi[-.]k2[-.]5(?:\b|$)/, name: 'Kimi K2.5', input: .6, cached: .1, output: 3 },
  { test: /kimi[-.]k2[-.]thinking[-.]turbo(?:\b|$)/, name: 'Kimi K2 Thinking Turbo', input: 1.15, cached: .15, output: 8 },
  { test: /kimi[-.]k2[-.]turbo[-.]preview(?:\b|$)/, name: 'Kimi K2 Turbo Preview', input: 1.15, cached: .15, output: 8 },
  { test: /kimi[-.]k2[-.]thinking(?:\b|$)/, name: 'Kimi K2 Thinking', input: .6, cached: .15, output: 2.5 },
  { test: /kimi[-.]k2[-.]\d{4}[-.]preview(?:\b|$)/, name: 'Kimi K2 Preview', input: .6, cached: .15, output: 2.5 },
  { test: /kimi[-.]k2(?:\b|$)/, name: 'Kimi K2', input: .6, cached: .15, output: 2.5 },
  // Moonshot V1（无上下文缓存，预计 2026-08-31 下线）
  { test: /moonshot[-.]v1[-.]128k(?:\b|$)/, name: 'Moonshot V1 128K', input: 2, output: 5 },
  { test: /moonshot[-.]v1[-.]32k(?:\b|$)/, name: 'Moonshot V1 32K', input: 1, output: 3 },
  { test: /moonshot[-.]v1[-.]8k(?:\b|$)/, name: 'Moonshot V1 8K', input: .2, output: 2 },
  { test: /moonshot[-.]v1(?:\b|$)/, name: 'Moonshot V1', input: 1, output: 3 },
  // GLM: https://z.ai/models/glm-5.2
  { test: /glm[-.]5[-.]2(?:\b|$)/, name: 'GLM 5.2', input: 1.4, cached: .26, output: 4.4 },
];

function normalizeModelName(model) {
  return String(model || '').trim().toLowerCase()
    .replace(/^(?:openai|anthropic|moonshot)\//, '')
    .replace(/^azure-/, '')
    .replace(/_/g, '-')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '');
}

function priceForModel(model, usage = {}, now = new Date()) {
  const normalized = normalizeModelName(model);
  // Sonnet 5 的官方推广价截至 2026-08-31，之后自动切换标准价。
  if (/sonnet[-.]5(?:\b|$)/.test(normalized)) {
    const promotional = now < new Date('2026-09-01T00:00:00Z');
    return promotional
      ? { name: 'Claude Sonnet 5', input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cached: .2, output: 10 }
      : { name: 'Claude Sonnet 5', input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cached: .3, output: 15 };
  }
  let price = MODEL_PRICES.find(p => p.test.test(normalized));
  if (!price) return null;
  price = { ...price };

  // Claude Opus fast mode 和 US-only inference 使用官方对应倍率。
  if (usage.speed === 'fast' && /opus[-.]4[-.]8(?:\b|$)/.test(normalized)) {
    Object.assign(price, { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cached: 1 });
  } else if (usage.speed === 'fast' && /opus[-.]4[-.]7(?:\b|$)/.test(normalized)) {
    Object.assign(price, { input: 30, output: 150, cacheWrite5m: 37.5, cacheWrite1h: 60, cached: 3 });
  }
  if (usage.inferenceGeo === 'us' && /(?:fable|mythos)[-.]5|opus[-.]4[-.][6-8]|sonnet[-.](?:4[-.]6|5)/.test(normalized)) {
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

function localDateKey(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return null;
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// 把带时间戳的用量记录聚合为「日期 × 模型」的成本明细，供统计页使用。
function summarizeDailyRecords(records) {
  const groups = new Map();
  for (const r of records) {
    const date = r.ts && localDateKey(r.ts);
    if (!date) continue;
    const key = date + '\0' + (r.model || '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const daily = [];
  for (const [key, recs] of groups) {
    const [date, model] = key.split('\0');
    const { usage, cost } = summarizeUsageRecords(recs);
    daily.push({
      date,
      model: model || null,
      usd: cost ? cost.usd : null,
      totalTokens: usage ? usage.totalTokens : 0,
      requests: usage ? usage.requests : 0,
    });
  }
  return daily.sort((a, b) => a.date.localeCompare(b.date));
}

function bumpDate(map, ts) {
  const date = ts && localDateKey(ts);
  if (date) map.set(date, (map.get(date) || 0) + 1);
}

function activityFromMap(map) {
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, turns]) => ({ date, turns }));
}

// ---------- 运行状态检测 (lsof) ----------

let openFilesCache = { at: 0, files: new Set() };

function getOpenJsonlFiles() {
  return new Promise((resolve) => {
    if (Date.now() - openFilesCache.at < 3000) return resolve(openFilesCache.files);
    execFile('lsof', ['-F', 'n', '-c', 'claude', '-c', 'codex', '-c', 'openclaw', '-c', 'node'],
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

function parseClaudeTaskNotification(text) {
  if (typeof text !== 'string' || !text.includes('<task-notification>')) return null;
  const tag = (name) => {
    const match = text.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`));
    return match ? match[1].trim() : null;
  };
  const summary = tag('summary');
  if (!summary || !/^Agent\s+/i.test(summary)) return null; // 排除后台 shell command 通知
  const titleMatch = summary.match(/^Agent\s+["“]([\s\S]*?)["”]\s+(?:finished|failed|stopped)/i);
  const status = tag('status') || 'completed';
  return {
    role: 'subagent',
    event: status === 'completed' ? 'completed' : status,
    agentId: tag('task-id'),
    title: titleMatch ? titleMatch[1] : summary.replace(/^Agent\s+/i, '').replace(/\s+finished$/i, ''),
    text: summary,
  };
}

// Claude Code 会话摘要
function summarizeClaude(file, stat, content) {
  const lines = content == null ? parseLines(file) : parseJsonLines(content);
  const isSubagent = path.basename(path.dirname(file)) === 'subagents';
  let cwd = null, firstUserText = null, summaryTitle = null, gitBranch = null, version = null, model = null;
  let firstTs = null, lastTs = null, userCount = 0, assistantCount = 0, lastEventText = null;
  let sessionId = path.basename(file, '.jsonl');
  let agentId = isSubagent ? path.basename(file, '.jsonl').replace(/^agent-/, '') : null;
  let parentSessionId = null, subagentType = null;
  let contextTokens = null;
  const models = new Set();
  const usageByMessage = new Map();
  const activityByDay = new Map();

  for (const l of lines) {
    if (l.timestamp) { if (!firstTs) firstTs = l.timestamp; lastTs = l.timestamp; }
    if (l.cwd && !cwd) cwd = l.cwd;
    if (l.gitBranch) gitBranch = l.gitBranch;
    if (l.version) version = l.version;
    if (isSubagent) {
      agentId = l.agentId || agentId;
      parentSessionId = l.sessionId || parentSessionId;
      subagentType = l.attributionAgent || subagentType;
    } else if (l.sessionId) sessionId = l.sessionId;
    if (l.type === 'summary' && l.summary) summaryTitle = l.summary;
    if (l.type === 'user' && l.message && (!l.isSidechain || isSubagent) && !l.isMeta) {
      const text = extractText(l.message.content);
      if (text && !isNoiseUserText(text) && !parseClaudeTaskNotification(text)) {
        userCount++;
        if (!firstUserText) firstUserText = text;
        bumpDate(activityByDay, l.timestamp);
      }
    }
    if (l.type === 'assistant' && l.message && (!l.isSidechain || isSubagent)) {
      if (l.message.model && l.message.model !== '<synthetic>') {
        model = l.message.model;
        models.add(model);
      }
      const text = extractText(l.message.content);
      if (text) { assistantCount++; lastEventText = text; bumpDate(activityByDay, l.timestamp); }
      const u = l.message.usage;
      if (u && u.input_tokens != null) {
        contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
        const messageKey = l.message.id || l.requestId || l.uuid;
        usageByMessage.set(messageKey || `line:${usageByMessage.size}`, {
          model: l.message.model && l.message.model !== '<synthetic>' ? l.message.model : model,
          usage: normalizedUsage(u, 'claude'),
          ts: l.timestamp || null,
        });
      }
    }
  }
  if (!firstUserText && !assistantCount) return null; // 空会话不展示

  const usageRecords = [...usageByMessage.values()];
  const totals = summarizeUsageRecords(usageRecords);

  return {
    source: 'claude',
    daily: summarizeDailyRecords(usageRecords),
    activity: activityFromMap(activityByDay),
    id: isSubagent ? agentId : sessionId,
    file,
    project: cwd || decodeClaudeDirName(path.basename(isSubagent
      ? path.dirname(path.dirname(path.dirname(file)))
      : path.dirname(file))),
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
    sessionKind: isSubagent ? 'subagent' : 'agent',
    agentId,
    parentSessionId,
    parentFile: isSubagent && parentSessionId
      ? path.join(path.dirname(path.dirname(path.dirname(file))), parentSessionId + '.jsonl')
      : null,
    subagentType,
  };
}

// 目录名如 -Users-wangrunji-Codes-foo,尽力还原(仅作 cwd 缺失时的兜底)
function decodeClaudeDirName(name) {
  return name.replace(/-/g, '/');
}

function listClaudeSessionFiles() {
  const files = [];
  for (const project of safeReadDir(CLAUDE_DIR)) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(CLAUDE_DIR, project.name);
    for (const entry of safeReadDir(projectDir)) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(path.join(projectDir, entry.name));
      } else if (entry.isDirectory()) {
        const subagentsDir = path.join(projectDir, entry.name, 'subagents');
        for (const subagent of safeReadDir(subagentsDir)) {
          if (subagent.isFile() && /^agent-[\w-]+\.jsonl$/.test(subagent.name)) {
            files.push(path.join(subagentsDir, subagent.name));
          }
        }
      }
    }
  }
  return files;
}

const claudeSubagentMetaCache = new Map();

function claudeSubagentMetadata(parentFile, agentId) {
  let stat;
  try { stat = fs.statSync(parentFile); } catch { return null; }
  let cached = claudeSubagentMetaCache.get(parentFile);
  if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
    const calls = new Map();
    const agents = new Map();
    for (const l of parseLines(parentFile)) {
      const content = l.message && Array.isArray(l.message.content) ? l.message.content : [];
      if (l.type === 'assistant') {
        for (const item of content) {
          if (item.type === 'tool_use' && (item.name === 'Agent' || item.name === 'Task')) {
            calls.set(item.id, item.input || {});
          }
        }
      } else if (l.type === 'user') {
        for (const item of content) {
          if (item.type !== 'tool_result') continue;
          const text = typeof item.content === 'string' ? item.content : extractText(item.content);
          const input = calls.get(item.tool_use_id) || {};
          for (const match of text.matchAll(/\bagentId:\s*([\w-]+)/g)) {
            agents.set(match[1], {
              label: input.description || null,
              prompt: input.prompt || null,
              subagentType: input.subagent_type || null,
            });
          }
        }
      }
    }
    cached = { mtimeMs: stat.mtimeMs, size: stat.size, agents };
    claudeSubagentMetaCache.set(parentFile, cached);
  }
  return cached.agents.get(agentId) || null;
}

function decorateClaudeSubagentSummary(summary) {
  if (summary.sessionKind !== 'subagent') return summary;
  const metadata = summary.parentFile && claudeSubagentMetadata(summary.parentFile, summary.agentId);
  return {
    ...summary,
    title: truncate(metadata && (metadata.label || metadata.prompt) || summary.title, 80),
    subagentType: metadata && metadata.subagentType || summary.subagentType,
  };
}

// Codex 会话摘要
function summarizeCodex(file, stat, content) {
  const lines = content == null ? parseLines(file) : parseJsonLines(content);
  let cwd = null, sessionId = path.basename(file, '.jsonl'), source = null, model = null;
  let firstTs = null, lastTs = null, firstUserText = null, lastAgentText = null;
  let userCount = 0, agentCount = 0, contextTokens = null;
  const models = new Set();
  const usageRecords = [];
  const activityByDay = new Map();

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
        bumpDate(activityByDay, l.timestamp);
      }
      if (p.type === 'agent_message' && p.message) {
        agentCount++;
        lastAgentText = p.message;
        bumpDate(activityByDay, l.timestamp);
      }
      if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
        const u = p.info.last_token_usage;
        contextTokens = u.total_tokens || contextTokens;
        usageRecords.push({ model, usage: normalizedUsage(u, 'codex'), ts: l.timestamp || null });
      }
    }
  }
  if (!firstUserText && !agentCount) return null;
  const totals = summarizeUsageRecords(usageRecords);

  return {
    source: 'codex',
    daily: summarizeDailyRecords(usageRecords),
    activity: activityFromMap(activityByDay),
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

// OpenClaw 会话摘要（~/.openclaw/agents/<agent>/sessions/<uuid>.jsonl）
function summarizeOpenClaw(file, stat, content) {
  const lines = content == null ? parseLines(file) : parseJsonLines(content);
  let cwd = null, sessionId = path.basename(file, '.jsonl'), provider = null, model = null;
  let firstTs = null, lastTs = null, firstUserText = null, lastAgentText = null;
  let userCount = 0, agentCount = 0, contextTokens = null;
  const models = new Set();
  const usageRecords = [];
  const activityByDay = new Map();

  for (const l of lines) {
    if (l.timestamp) { if (!firstTs) firstTs = l.timestamp; lastTs = l.timestamp; }
    if (l.type === 'session') {
      cwd = l.cwd || cwd;
      sessionId = l.id || sessionId;
    }
    if (l.type === 'model_change') {
      provider = l.provider || provider;
      if (l.modelId) { model = l.modelId; models.add(model); }
    }
    if (l.type !== 'message' || !l.message) continue;
    const m = l.message;
    const ts = l.timestamp || (m.timestamp ? new Date(m.timestamp).toISOString() : null);
    const text = extractText(m.content);
    if (m.role === 'user' && text && !isNoiseUserText(text)) {
      userCount++;
      if (!firstUserText) firstUserText = text;
      bumpDate(activityByDay, ts);
    } else if (m.role === 'assistant') {
      provider = m.provider || provider;
      if (m.model && m.model !== '<synthetic>') {
        model = m.model;
        models.add(model);
      }
      if (text) { agentCount++; lastAgentText = text; bumpDate(activityByDay, ts); }
      else if (Array.isArray(m.content) && m.content.length) agentCount++;
      if (m.usage) {
        contextTokens = Number(m.usage.totalTokens ?? m.usage.total_tokens) || contextTokens;
        usageRecords.push({
          model,
          usage: normalizedUsage({
            input_tokens: m.usage.input ?? m.usage.input_tokens,
            output_tokens: m.usage.output ?? m.usage.output_tokens,
            cache_read_input_tokens: m.usage.cacheRead ?? m.usage.cache_read_input_tokens,
            cache_write_tokens: m.usage.cacheWrite ?? m.usage.cache_write_tokens,
            reasoning_tokens: m.usage.reasoning ?? m.usage.reasoning_tokens,
          }, 'openclaw'),
          ts,
        });
      }
    }
  }
  if (!firstUserText && !agentCount) return null;
  const totals = summarizeUsageRecords(usageRecords);
  const relative = path.relative(OPENCLAW_AGENTS_DIR, file).split(path.sep);
  const agentId = relative.length >= 3 ? relative[0] : null;

  return {
    source: 'openclaw',
    daily: summarizeDailyRecords(usageRecords),
    activity: activityFromMap(activityByDay),
    id: sessionId,
    file,
    project: cwd || (agentId ? `openclaw://${agentId}` : 'openclaw://unknown'),
    title: truncate(firstUserText || '(无标题)', 80),
    lastMessage: truncate(lastAgentText || '', 120),
    firstTs, lastTs,
    turns: userCount + agentCount,
    gitBranch: null,
    version: agentId || provider,
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

// 与本地会话一样，远端正文只保存在磁盘上的 jsonl 中；内存仅缓存元数据和摘要。
const remoteSummaryCache = new Map(); // host\0path -> { mtimeMs, size, cacheFile, summary }
const remoteFileIndex = new Map(); // opaque id -> metadata entry
const remoteProjectPathCache = new Map(); // host\0cwd -> canonical cwd
let remoteSessionsCache = { at: 0, sessions: [], hosts: [], errors: [] };

function remoteCacheKey(kind, host, file) {
  return kind + '\0' + host + '\0' + file;
}

function summarizeRemoteCacheEntry(entry) {
  const id = remoteFileId(entry.kind, entry.host, entry.path);
  const summary = getSummary(entry.cacheFile, entry.kind);
  return summary ? { ...summary, file: id, sizeBytes: entry.size } : null;
}

function remoteHistoryDigest(entry) {
  return crypto.createHash('sha256')
    .update(remoteCacheKey(entry.kind, entry.host, entry.path)).digest('hex');
}

function remoteHistoryFile(entry) {
  return path.join(REMOTE_HISTORY_DIR, remoteHistoryDigest(entry) + '.json');
}

function remoteContentFile(entry) {
  return path.join(REMOTE_HISTORY_DIR, remoteHistoryDigest(entry) + '.jsonl');
}

function ensureRemoteHistoryDir() {
  fs.mkdirSync(REMOTE_HISTORY_DIR, { recursive: true, mode: 0o700 });
}

function writeRemoteContent(entry, content, append) {
  ensureRemoteHistoryDir();
  const file = remoteContentFile(entry);
  if (append) {
    fs.appendFileSync(file, content, { mode: 0o600 });
  } else {
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  return file;
}

function persistRemoteHistory(entry) {
  try {
    ensureRemoteHistoryDir();
    const file = remoteHistoryFile(entry);
    const temp = file + '.' + process.pid + '.tmp';
    const record = {
      version: 2,
      kind: entry.kind, host: entry.host, path: entry.path, root: entry.root,
      mtimeMs: entry.mtimeMs, size: entry.size, canonicalProject: entry.canonicalProject,
    };
    fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch (error) {
    console.error('无法保存远端会话缓存:', error.message);
  }
}

function loadRemoteHistory() {
  for (const item of safeReadDir(REMOTE_HISTORY_DIR)) {
    if (!item.isFile() || !item.name.endsWith('.json')) continue;
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(REMOTE_HISTORY_DIR, item.name), 'utf8'));
      if (!['claude', 'codex'].includes(entry.kind) || typeof entry.host !== 'string' ||
          typeof entry.path !== 'string') continue;
      const legacyContent = typeof entry.content === 'string' ? entry.content : null;
      entry.size = Number(entry.size) || (legacyContent == null ? 0 : Buffer.byteLength(legacyContent));
      entry.mtimeMs = Number(entry.mtimeMs) || 0;
      entry.cacheFile = remoteContentFile(entry);
      if (!fs.existsSync(entry.cacheFile)) {
        if (legacyContent == null) continue;
        writeRemoteContent(entry, legacyContent, false);
      }
      // 正文和元数据分两次原子写；若上次在两者之间退出，以正文实际大小恢复。
      entry.size = fs.statSync(entry.cacheFile).size;
      delete entry.content;
      entry.summary = summarizeRemoteCacheEntry(entry);
      remoteSummaryCache.set(remoteCacheKey(entry.kind, entry.host, entry.path), entry);
      if (entry.canonicalProject && entry.summary?.project) {
        remoteProjectPathCache.set(entry.host + '\0' + entry.summary.project, entry.canonicalProject);
      }
      if (legacyContent != null || entry.version !== 2) persistRemoteHistory(entry);
    } catch { /* 单个损坏的缓存文件不影响其他历史会话 */ }
  }
}

loadRemoteHistory();

async function resolveRemoteProjectPaths(host, projects) {
  const paths = [...new Set(projects.filter(project => project && project.startsWith('/')))];
  const unresolved = paths.filter(project => !remoteProjectPathCache.has(host + '\0' + project));
  if (unresolved.length) {
    const script = `set -- ${unresolved.map(shellQuote).join(' ')}
for project do
  if command -v realpath >/dev/null 2>&1; then
    realpath -- "$project" 2>/dev/null || printf '%s\\n' "$project"
  elif command -v readlink >/dev/null 2>&1; then
    readlink -f -- "$project" 2>/dev/null || printf '%s\\n' "$project"
  else
    (cd "$project" 2>/dev/null && pwd -P) || printf '%s\\n' "$project"
  fi
done`;
    const resolved = (await sshCommand(host, script)).replace(/\n$/, '').split('\n');
    for (let i = 0; i < unresolved.length; i++) {
      remoteProjectPathCache.set(host + '\0' + unresolved[i], resolved[i] || unresolved[i]);
    }
  }
  return new Map(paths.map(project => [project, remoteProjectPathCache.get(host + '\0' + project) || project]));
}

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
    const key = remoteCacheKey(meta.kind, host, meta.path);
    const previous = remoteSummaryCache.get(key);
    try {
      let cached = previous;
      let dirty = false;
      if (!cached || cached.mtimeMs !== meta.mtimeMs || cached.size !== meta.size) {
        let cachedFileSize = -1;
        try { cachedFileSize = fs.statSync(cached.cacheFile).size; } catch {}
        const canAppend = cached && meta.size > cached.size && cachedFileSize === cached.size;
        const offset = canAppend ? cached.size : 0;
        const chunk = await readRemoteFile(host, meta.path, offset, meta.size - offset);
        if (Buffer.byteLength(chunk) !== meta.size - offset) {
          throw new Error(`remote session changed while reading: ${meta.path}`);
        }
        cached = {
          kind: meta.kind, host, path: meta.path, root: scan.roots[meta.kind],
          mtimeMs: meta.mtimeMs, size: meta.size,
        };
        cached.cacheFile = writeRemoteContent(cached, chunk, canAppend);
        cached.summary = summarizeRemoteCacheEntry(cached);
        remoteSummaryCache.set(key, cached);
        dirty = true;
      }
      return { meta, cached, dirty };
    } catch (error) {
      return { meta, cached: previous, error };
    }
  });

  const currentKeys = new Set(scan.files.map(meta => remoteCacheKey(meta.kind, host, meta.path)));
  for (const [key, cached] of remoteSummaryCache) {
    if (cached.host !== host || currentKeys.has(key)) continue;
    entries.push({
      meta: { kind: cached.kind, path: cached.path, mtimeMs: cached.mtimeMs, size: cached.size },
      cached,
      historical: true,
    });
  }

  // Codex 和 Claude 可能分别记录软链接路径与真实路径；统一 cwd，避免同一项目被拆组。
  const projectPaths = await resolveRemoteProjectPaths(host, [
    ...entries.map(entry => entry.cached?.summary?.project),
    ...Object.values(scan.aliveProjects).flatMap(projects => [...projects]),
  ]);
  for (const entry of entries) {
    if (!entry.cached?.summary) continue;
    const canonicalProject = projectPaths.get(entry.cached.summary.project) || entry.cached.summary.project;
    const canonicalChanged = entry.cached.canonicalProject !== canonicalProject;
    entry.cached.canonicalProject = canonicalProject;
    if (entry.dirty || canonicalChanged) persistRemoteHistory(entry.cached);
  }

  // Claude 会在每次写入后关闭日志文件；用存活进程的 cwd 关联该项目最新会话。
  const latestAliveClaude = new Map();
  const aliveClaudeProjects = new Set([...(scan.aliveProjects.claude || [])]
    .map(project => projectPaths.get(project) || project));
  for (const { meta, cached, historical } of entries) {
    if (!cached || meta.kind !== 'claude' || !cached.summary) continue;
    const project = projectPaths.get(cached.summary.project) || cached.summary.project;
    if (!aliveClaudeProjects.has(project)) continue;
    const previous = latestAliveClaude.get(project);
    if (!previous || meta.mtimeMs > previous.mtimeMs) latestAliveClaude.set(project, { path: meta.path, mtimeMs: meta.mtimeMs });
  }

  const sessions = [];
  for (const { meta, cached, historical } of entries) {
    if (!cached) continue; // 单个历史日志读取失败不影响同一主机上的其他会话
    if (!cached.summary) continue;
    const s = { ...cached.summary };
    s.remoteHost = host;
    s.remotePath = meta.path;
    const canonicalProject = cached.canonicalProject || projectPaths.get(s.project) || s.project;
    s.project = host + ':' + canonicalProject;
    s.version = [s.version, 'SSH ' + host].filter(Boolean).join(' · ');
    const now = Date.now();
    const ageMs = s.lastTs ? now - Date.parse(s.lastTs) : Infinity;
    const mtimeAge = now - meta.mtimeMs;
    const aliveClaude = meta.kind === 'claude' && latestAliveClaude.get(canonicalProject)?.path === meta.path;
    if (historical) s.status = 'idle';
    else if (mtimeAge < 60 * 1000) s.status = 'running';
    else if (scan.openFiles.has(meta.path)) s.status = ageMs < 2 * 60 * 1000 ? 'running' : 'open';
    else if (aliveClaude) s.status = 'open';
    else s.status = 'idle';
    sessions.push(s);
    remoteFileIndex.set(s.file, cached);
  }
  return { host, sessions };
}

function cachedRemoteHostSessions(host) {
  const sessions = [];
  for (const cached of remoteSummaryCache.values()) {
    if (cached.host !== host || !cached.summary) continue;
    const s = { ...cached.summary };
    s.remoteHost = host;
    s.remotePath = cached.path;
    s.project = host + ':' + (cached.canonicalProject || s.project);
    s.version = [s.version, 'SSH ' + host, '本地缓存'].filter(Boolean).join(' · ');
    s.status = 'idle';
    sessions.push(s);
    remoteFileIndex.set(s.file, cached);
  }
  return sessions;
}

async function remoteAgentSessions() {
  if (Date.now() - remoteSessionsCache.at < REMOTE_CACHE_MS) return remoteSessionsCache;
  const activeHosts = await discoverRemoteHosts();
  const cachedHosts = new Set([...remoteSummaryCache.values()].map(entry => entry.host));
  const hosts = [...new Set([...activeHosts, ...cachedHosts])];
  const results = await Promise.allSettled(activeHosts.map(scanRemoteHost));
  const sessions = [], errors = [];
  for (let i = 0; i < activeHosts.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') sessions.push(...result.value.sessions);
    else {
      sessions.push(...cachedRemoteHostSessions(activeHosts[i]));
      errors.push({ host: activeHosts[i], error: result.reason && result.reason.message || 'SSH failed' });
    }
  }
  for (const host of cachedHosts) {
    if (!activeHosts.includes(host)) sessions.push(...cachedRemoteHostSessions(host));
  }
  remoteSessionsCache = { at: Date.now(), sessions, hosts, errors };
  return remoteSessionsCache;
}

function listOpenClawSessionEntries() {
  const entriesByFile = new Map();
  const keyToSessionId = new Map();
  const keyToFile = new Map();
  const indexed = [];
  for (const agent of safeReadDir(OPENCLAW_AGENTS_DIR)) {
    if (!agent.isDirectory()) continue;
    const sessionsDir = path.join(OPENCLAW_AGENTS_DIR, agent.name, 'sessions');

    // sessions.json 是当前会话索引；优先采用其中的显式路径。
    try {
      const index = JSON.parse(fs.readFileSync(path.join(sessionsDir, 'sessions.json'), 'utf8'));
      const entries = Array.isArray(index) ? index.map((entry, i) => [String(i), entry]) : Object.entries(index || {});
      for (const [sessionKey, entry] of entries) {
        if (!entry || typeof entry.sessionFile !== 'string') continue;
        const file = path.resolve(sessionsDir, entry.sessionFile);
        if (file.startsWith(OPENCLAW_AGENTS_DIR + path.sep) && file.endsWith('.jsonl') && fs.existsSync(file)) {
          keyToSessionId.set(sessionKey, entry.sessionId || path.basename(file, '.jsonl'));
          keyToFile.set(sessionKey, file);
          indexed.push({ file, metadata: { ...entry, sessionKey, agentId: agent.name } });
        }
      }
    } catch { /* 索引缺失或正在写入时仍扫描标准 UUID 文件 */ }

    // 同时保留已从索引移除但仍存在的历史会话；排除 trajectory/checkpoint/reset 等旁路日志。
    for (const entry of safeReadDir(sessionsDir)) {
      if (entry.isFile() && /^[0-9a-f]{8}-[0-9a-f-]{27,}\.jsonl$/i.test(entry.name)) {
        const file = path.join(sessionsDir, entry.name);
        if (!entriesByFile.has(file)) entriesByFile.set(file, { file, metadata: { agentId: agent.name } });
      }
    }
  }

  let runsByChild = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(OPENCLAW_DIR, 'subagents', 'runs.json'), 'utf8'));
    runsByChild = new Map(Object.values(data.runs || {}).filter(Boolean).map(run => [run.childSessionKey, run]));
  } catch { /* subagent 运行索引是可选的 */ }

  for (const entry of indexed) {
    const run = runsByChild.get(entry.metadata.sessionKey);
    const metadata = {
      ...entry.metadata,
      task: run && run.task,
      parentSessionKey: entry.metadata.spawnedBy || (run && (run.requesterSessionKey || run.controllerSessionKey)) || null,
    };
    metadata.parentSessionId = keyToSessionId.get(metadata.parentSessionKey) || null;
    metadata.parentFile = keyToFile.get(metadata.parentSessionKey) || null;
    const previous = entriesByFile.get(entry.file);
    // 同一 transcript 存在多个别名时，保留包含 subagent 语义的会话键。
    if (!previous || metadata.sessionKey.includes(':subagent:') || !previous.metadata.sessionKey) {
      entriesByFile.set(entry.file, { file: entry.file, metadata });
    }
  }
  return [...entriesByFile.values()];
}

function decorateOpenClawSummary(summary, metadata = {}) {
  const sessionKey = metadata.sessionKey || '';
  let sessionKind = 'agent';
  if (sessionKey.includes(':subagent:')) sessionKind = 'subagent';
  else if (sessionKey.includes(':acp:')) sessionKind = 'acp';
  else if (sessionKey.includes(':cron:')) sessionKind = 'cron';
  const title = sessionKind === 'subagent'
    ? truncate(metadata.label || metadata.task || summary.title, 80)
    : summary.title;
  return {
    ...summary,
    title,
    model: summary.model || metadata.model || null,
    models: summary.models.length ? summary.models : (metadata.model ? [metadata.model] : []),
    version: metadata.agentId || summary.version,
    agentId: metadata.agentId || null,
    sessionKey: metadata.sessionKey || null,
    sessionKind,
    parentSessionKey: metadata.parentSessionKey || null,
    parentSessionId: metadata.parentSessionId || null,
    parentFile: metadata.parentFile || null,
    channel: metadata.channel || metadata.lastChannel || null,
    openClawStatus: metadata.status || null,
    startedTs: metadata.startedAt || metadata.sessionStartedAt
      ? new Date(metadata.startedAt || metadata.sessionStartedAt).toISOString()
      : summary.firstTs,
    endedTs: metadata.endedAt ? new Date(metadata.endedAt).toISOString() : null,
  };
}

function getSummary(file, kind) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = summaryCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.summary;
  let summary = null;
  try {
    if (kind === 'claude') summary = summarizeClaude(file, stat);
    else if (kind === 'openclaw') summary = summarizeOpenClaw(file, stat);
    else summary = summarizeCodex(file, stat);
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
  const activityBySession = new Map();
  try {
    const activityRows = db.prepare(`
      SELECT session_id, date(timestamp, 'unixepoch', 'localtime') AS day, COUNT(*) AS turns
      FROM messages WHERE role IN ('user', 'assistant') GROUP BY session_id, day
    `).all();
    for (const row of activityRows) {
      if (!row.day) continue;
      if (!activityBySession.has(row.session_id)) activityBySession.set(row.session_id, []);
      activityBySession.get(row.session_id).push({ date: row.day, turns: Number(row.turns) || 0 });
    }
  } catch { /* 旧库缺 messages 表时跳过活跃度统计 */ }
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
      // 用量表只有累计值,按最后活跃日归档(hermes 会话通常单日完成)
      ts: u.last_seen ? new Date(Number(u.last_seen) * 1000).toISOString() : null,
    }));
    const totals = summarizeUsageRecords(usageRecords);
    const lastSec = r.last_msg_ts || r.ended_at || r.started_at;
    const lastTs = lastSec ? new Date(lastSec * 1000).toISOString() : null;
    const s = {
      source: 'hermes',
      daily: summarizeDailyRecords(usageRecords),
      activity: activityBySession.get(r.id) || [],
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
  const isSubagent = path.basename(path.dirname(file)) === 'subagents';
  const msgs = [];
  for (const l of lines) {
    if (l.isSidechain && !isSubagent) continue;
    if (l.type === 'system' && l.subtype === 'compact_boundary') {
      const metadata = l.compactMetadata || {};
      msgs.push({
        role: 'compaction', ts: l.timestamp,
        trigger: metadata.trigger || null,
        beforeTokens: metadata.preTokens ?? null,
        afterTokens: metadata.postTokens ?? null,
        durationMs: metadata.durationMs ?? null,
      });
      continue;
    }
    if (!isSubagent && l.type === 'user' && l.toolUseResult && l.toolUseResult.agentId &&
        (l.toolUseResult.isAsync || l.toolUseResult.status === 'async_launched')) {
      msgs.push({
        role: 'subagent', event: 'started', agentId: l.toolUseResult.agentId,
        title: l.toolUseResult.description || l.toolUseResult.agentId,
        text: 'Agent 已创建', ts: l.timestamp,
      });
      continue;
    }
    if (l.type === 'summary' && l.summary) {
      msgs.push({ role: 'divider', text: '摘要: ' + l.summary, ts: null });
    } else if (l.type === 'user' && l.message && !l.isMeta) {
      const c = l.message.content;
      if (typeof c === 'string') {
        const notification = !isSubagent && parseClaudeTaskNotification(c);
        if (notification) msgs.push({ ...notification, ts: l.timestamp });
        else if (!isNoiseUserText(c)) msgs.push({ role: 'user', text: c, ts: l.timestamp });
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
    if (l.type === 'compacted' || l.type === 'compaction' ||
        (l.type === 'event_msg' && (p.type === 'compacted' || p.type === 'compaction'))) {
      const details = p.info || p;
      msgs.push({
        role: 'compaction', ts: l.timestamp,
        trigger: details.trigger || null,
        beforeTokens: details.pre_tokens ?? details.preTokens ?? details.tokens_before ?? null,
        afterTokens: details.post_tokens ?? details.postTokens ?? details.tokens_after ?? null,
        durationMs: details.duration_ms ?? details.durationMs ?? null,
      });
    } else if (l.type === 'event_msg') {
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

function detailOpenClaw(file, content) {
  const lines = content == null ? parseLines(file) : parseJsonLines(content);
  const msgs = [];
  for (const l of lines) {
    if (l.type === 'compaction') {
      msgs.push({
        role: 'compaction', ts: l.timestamp,
        trigger: l.fromHook ? 'auto' : null,
        beforeTokens: l.tokensBefore ?? null,
        afterTokens: l.tokensAfter ?? null,
        durationMs: l.durationMs ?? null,
      });
      continue;
    }
    if (l.type !== 'message' || !l.message) continue;
    const m = l.message;
    const ts = l.timestamp || (m.timestamp ? new Date(m.timestamp).toISOString() : null);
    if (m.role === 'user') {
      const text = extractText(m.content);
      if (text && !isNoiseUserText(text)) msgs.push({ role: 'user', text, ts });
    } else if (m.role === 'assistant') {
      if (typeof m.content === 'string' && m.content) {
        msgs.push({ role: 'assistant', text: m.content, ts });
        continue;
      }
      for (const item of Array.isArray(m.content) ? m.content : []) {
        if (item.type === 'text' && item.text) {
          msgs.push({ role: 'assistant', text: item.text, ts });
        } else if (item.type === 'thinking' && item.thinking) {
          msgs.push({ role: 'thinking', text: truncate(item.thinking, 600), ts });
        } else if (item.type === 'toolCall') {
          const raw = item.arguments ?? item.input ?? {};
          const input = truncate(typeof raw === 'string' ? raw : JSON.stringify(raw), 400);
          msgs.push({ role: 'tool_use', ts, toolName: item.name || '?', callId: item.id || null,
            input, text: (item.name || '?') + ' ' + input });
        }
      }
    } else if (m.role === 'toolResult') {
      const output = truncate(extractText(m.content), 600);
      msgs.push({ role: 'tool_result', ts, toolName: m.toolName || '?', callId: m.toolCallId || null,
        output, text: output });
    }
  }
  return msgs;
}

let subagentSessionsByParentFile = new Map();

function subagentLink(summary) {
  return {
    source: summary.source,
    id: summary.id,
    file: summary.file,
    project: summary.project,
    title: summary.title,
    firstTs: summary.firstTs,
    lastTs: summary.lastTs,
    turns: summary.turns,
    model: summary.model,
    models: summary.models,
    contextTokens: summary.contextTokens,
    usage: summary.usage,
    cost: summary.cost,
    status: summary.status,
    sessionKind: 'subagent',
    subagentType: summary.subagentType || null,
  };
}

function subagentEventId(summary) {
  if (summary.source === 'openclaw') return summary.sessionKey && summary.sessionKey.split(':').pop() || summary.id;
  return summary.agentId || summary.id;
}

function attachSubagentEvents(messages, parentFile) {
  const children = subagentSessionsByParentFile.get(parentFile) || [];
  if (!children.length) return messages;
  const byId = new Map();
  for (const child of children) {
    for (const id of [subagentEventId(child), child.id]) {
      if (id) byId.set(id, child);
    }
  }

  const events = messages.map(message => {
    if (message.role !== 'subagent') return message;
    const child = byId.get(message.agentId);
    return child ? { ...message, title: message.title || child.title, subagent: subagentLink(child) } : message;
  });
  const seen = new Set(events.filter(m => m.role === 'subagent').map(m => `${m.agentId}:${m.event}`));

  for (const child of children) {
    const agentId = subagentEventId(child);
    if (!seen.has(`${agentId}:started`)) {
      events.push({
        role: 'subagent', event: 'started', agentId, title: child.title,
        text: 'Agent 已创建', ts: child.startedTs || child.firstTs,
        subagent: subagentLink(child),
      });
    }
    const finished = ['done', 'failed', 'timeout', 'cancelled', 'aborted'].includes(child.openClawStatus);
    if (child.source === 'openclaw' && finished && !seen.has(`${agentId}:completed`)) {
      events.push({
        role: 'subagent', event: child.openClawStatus === 'done' ? 'completed' : child.openClawStatus,
        agentId, title: child.title, text: 'Agent 已完成', ts: child.endedTs || child.lastTs,
        subagent: subagentLink(child),
      });
    }
  }

  return events.map((message, index) => ({ message, index })).sort((a, b) => {
    if (!a.message.ts || !b.message.ts) return a.index - b.index;
    return Date.parse(a.message.ts) - Date.parse(b.message.ts) || a.index - b.index;
  }).map(item => item.message);
}

// ---------- API ----------

async function collectSessions() {
  const claudeFiles = listClaudeSessionFiles();
  const codexFiles = listFilesRecursive(CODEX_DIR, '.jsonl');
  const openClawEntries = listOpenClawSessionEntries();
  const openFiles = await getOpenJsonlFiles();
  const now = Date.now();

  const sessions = [];
  for (const f of claudeFiles) {
    const s = getSummary(f, 'claude');
    if (s) sessions.push(decorateClaudeSubagentSummary(s));
  }
  for (const f of codexFiles) {
    const s = getSummary(f, 'codex');
    if (s) sessions.push(s);
  }
  for (const { file, metadata } of openClawEntries) {
    const s = getSummary(file, 'openclaw');
    if (s) sessions.push(decorateOpenClawSummary(s, metadata));
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
  return { sessions, remote };
}

async function apiSessions() {
  const { sessions, remote } = await collectSessions();

  const nextSubagentIndex = new Map();
  for (const s of sessions) {
    if (s.sessionKind !== 'subagent' || !s.parentFile) continue;
    if (!nextSubagentIndex.has(s.parentFile)) nextSubagentIndex.set(s.parentFile, []);
    nextSubagentIndex.get(s.parentFile).push(s);
  }
  subagentSessionsByParentFile = nextSubagentIndex;
  const listedSessions = sessions.filter(s => s.sessionKind !== 'subagent');

  // 按项目 (cwd) 分组
  const groups = new Map();
  for (const s of listedSessions) {
    if (!groups.has(s.project)) groups.set(s.project, []);
    groups.get(s.project).push(s);
  }
  const projects = [...groups.entries()].map(([project, list]) => {
    list.sort((a, b) => (b.lastTs || '').localeCompare(a.lastTs || ''));
    let totalUsd = 0, incompleteCosts = 0;
    for (const s of list) {
      if (s.cost && s.cost.usd != null) {
        totalUsd += s.cost.usd;
        if (!s.cost.complete) incompleteCosts++;
      } else if (s.usage) incompleteCosts++;
    }
    return {
      project,
      name: project.startsWith(HOME) ? '~' + project.slice(HOME.length) : project,
      lastTs: list[0].lastTs,
      running: list.filter(s => s.status === 'running').length,
      open: list.filter(s => s.status === 'open').length,
      totalCost: totalUsd > 0 || incompleteCosts > 0 ? { usd: totalUsd, complete: incompleteCosts === 0 } : null,
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

// 统计页聚合:按天 × 模型成本、模型总成本、每日活跃度、按天 × 项目成本。
// 全部维度都按天输出,前端的时间范围筛选对四张图同时生效且数字一致。
async function apiStats() {
  const { sessions } = await collectSessions();

  const dailyByModel = new Map(); // date\0modelName -> { usd, totalTokens, requests }
  const byModel = new Map(); // modelName -> { usd, totalTokens, requests }
  const activityByDay = new Map(); // date -> { turns, sessions }
  const projectByDay = new Map(); // date\0project -> usd
  const unknownModels = new Set();

  for (const s of sessions) {
    const project = s.project || '(未知项目)';
    for (const d of s.daily || []) {
      const price = d.model && priceForModel(d.model);
      const name = price ? price.name : (d.model || '未知模型');
      if (!price && d.model) unknownModels.add(d.model);
      const usd = d.usd || 0;
      const key = d.date + '\0' + name;
      const day = dailyByModel.get(key) || { date: d.date, model: name, usd: 0, totalTokens: 0, requests: 0 };
      day.usd += usd;
      day.totalTokens += d.totalTokens || 0;
      day.requests += d.requests || 0;
      dailyByModel.set(key, day);
      const m = byModel.get(name) || { model: name, usd: 0, totalTokens: 0, requests: 0, priced: !!price };
      m.usd += usd;
      m.totalTokens += d.totalTokens || 0;
      m.requests += d.requests || 0;
      byModel.set(name, m);
      const pk = d.date + '\0' + project;
      projectByDay.set(pk, (projectByDay.get(pk) || 0) + usd);
    }
    for (const a of s.activity || []) {
      const day = activityByDay.get(a.date) || { date: a.date, turns: 0, sessions: 0 };
      day.turns += a.turns || 0;
      day.sessions += 1;
      activityByDay.set(a.date, day);
    }
  }

  const daily = [...dailyByModel.values()].sort((a, b) =>
    a.date.localeCompare(b.date) || b.usd - a.usd);
  const models = [...byModel.values()].sort((a, b) => b.usd - a.usd);
  const activity = [...activityByDay.values()].sort((a, b) => a.date.localeCompare(b.date));
  const projectDaily = [...projectByDay.entries()].map(([key, usd]) => {
    const [date, project] = key.split('\0');
    return {
      date, project, usd,
      name: project.startsWith(HOME) ? '~' + project.slice(HOME.length) : project,
    };
  }).sort((a, b) => a.date.localeCompare(b.date));

  return {
    daily,
    models,
    activity,
    projectDaily,
    unknownModels: [...unknownModels],
    generatedAt: new Date().toISOString(),
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
    if (!fs.existsSync(remote.cacheFile)) throw httpError(404, 'remote session cache not found');
    const messages = remote.kind === 'claude'
      ? detailClaude(remote.cacheFile)
      : detailCodex(remote.cacheFile);
    return { file, source: remote.kind, remoteHost: remote.host, messages };
  }
  const resolved = path.resolve(file);
  const inClaude = resolved.startsWith(CLAUDE_DIR + path.sep);
  const inCodex = resolved.startsWith(CODEX_DIR + path.sep);
  const inOpenClaw = resolved.startsWith(OPENCLAW_AGENTS_DIR + path.sep);
  if ((!inClaude && !inCodex && !inOpenClaw) || !resolved.endsWith('.jsonl')) throw httpError(403, 'forbidden path');
  if (!fs.existsSync(resolved)) throw httpError(404, 'not found');
  const source = inClaude ? 'claude' : inCodex ? 'codex' : 'openclaw';
  let messages = inClaude ? detailClaude(resolved) : inCodex ? detailCodex(resolved) : detailOpenClaw(resolved);
  messages = attachSubagentEvents(messages, resolved);
  return { file: resolved, source, messages };
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
    if (url.pathname === '/api/stats') {
      const data = await apiStats();
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
  apiStats,
  summarizeDailyRecords,
  detailClaude,
  detailCodex,
  detailOpenClaw,
  discoverRemoteHosts,
  normalizeModelName,
  normalizedUsage,
  parseRemoteScan,
  priceForModel,
  remoteAgentSessions,
  summarizeClaude,
  summarizeCodex,
  summarizeOpenClaw,
  decorateOpenClawSummary,
  summarizeUsageRecords,
};
