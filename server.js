#!/usr/bin/env node
// Watchcat: 局域网可访问的 Claude Code / Codex 会话日志监控服务
// 零依赖,直接 `node server.js` 启动

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

function parseLines(file) {
  const out = [];
  const content = fs.readFileSync(file, 'utf8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* 忽略截断行 */ }
  }
  return out;
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
function summarizeClaude(file, stat) {
  const lines = parseLines(file);
  let cwd = null, firstUserText = null, summaryTitle = null, gitBranch = null, version = null;
  let firstTs = null, lastTs = null, userCount = 0, assistantCount = 0, lastEventText = null;
  let sessionId = path.basename(file, '.jsonl');
  let contextTokens = null;

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
      const text = extractText(l.message.content);
      if (text) { assistantCount++; lastEventText = text; }
      const u = l.message.usage;
      if (u && u.input_tokens != null) {
        contextTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
          (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
      }
    }
  }
  if (!firstUserText && !assistantCount) return null; // 空会话不展示

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
    contextTokens,
    sizeBytes: stat.size,
  };
}

// 目录名如 -Users-wangrunji-Codes-foo,尽力还原(仅作 cwd 缺失时的兜底)
function decodeClaudeDirName(name) {
  return name.replace(/-/g, '/');
}

// Codex 会话摘要
function summarizeCodex(file, stat) {
  const lines = parseLines(file);
  let cwd = null, sessionId = path.basename(file, '.jsonl'), source = null, model = null;
  let firstTs = null, lastTs = null, firstUserText = null, lastAgentText = null;
  let userCount = 0, agentCount = 0, contextTokens = null;

  for (const l of lines) {
    if (l.timestamp) { if (!firstTs) firstTs = l.timestamp; lastTs = l.timestamp; }
    const p = l.payload || {};
    if (l.type === 'session_meta') {
      cwd = p.cwd || cwd;
      sessionId = p.session_id || p.id || sessionId;
      source = p.originator || p.source || source;
    }
    if (l.type === 'turn_context' && p.model) model = p.model;
    if (l.type === 'event_msg') {
      if (p.type === 'user_message' && p.message) {
        userCount++;
        if (!firstUserText) firstUserText = p.message;
      }
      if (p.type === 'agent_message' && p.message) { agentCount++; lastAgentText = p.message; }
      if (p.type === 'token_count' && p.info && p.info.last_token_usage) {
        contextTokens = p.info.last_token_usage.total_tokens || contextTokens;
      }
    }
  }
  if (!firstUserText && !agentCount) return null;

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
    contextTokens,
    sizeBytes: stat.size,
  };
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
  const alive = hermesGatewayAlive();
  const now = Date.now();
  const sessions = [];
  for (const r of rows) {
    if (!r.first_user && !r.last_assistant) continue;
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
      // messages 表无逐条 token,用累计用量 / 调用次数估算单次请求的平均 context
      contextTokens: r.api_calls > 0 ? Math.round(Number(r.ctx_in || 0) / Number(r.api_calls)) : null,
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
            msgs.push({ role: 'tool_use', ts, text: (fn.name || '?') + ' ' + truncate(String(fn.arguments || ''), 400) });
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

function detailClaude(file) {
  const lines = parseLines(file);
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
            msgs.push({ role: 'tool_result', text: truncate(text, 600), ts: l.timestamp });
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
          msgs.push({
            role: 'tool_use', ts: l.timestamp,
            text: item.name + ' ' + truncate(JSON.stringify(item.input || {}), 400),
          });
        }
      }
    }
  }
  return msgs;
}

function detailCodex(file) {
  const lines = parseLines(file);
  const msgs = [];
  for (const l of lines) {
    const p = l.payload || {};
    if (l.type === 'event_msg') {
      if (p.type === 'user_message' && p.message) msgs.push({ role: 'user', text: p.message, ts: l.timestamp });
      else if (p.type === 'agent_message' && p.message) msgs.push({ role: 'assistant', text: p.message, ts: l.timestamp });
      else if (p.type === 'agent_reasoning' && p.text) msgs.push({ role: 'thinking', text: truncate(p.text, 600), ts: l.timestamp });
    } else if (l.type === 'response_item') {
      if (p.type === 'function_call' || p.type === 'custom_tool_call') {
        msgs.push({ role: 'tool_use', ts: l.timestamp, text: (p.name || '?') + ' ' + truncate(String(p.arguments ?? p.input ?? ''), 400) });
      } else if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
        const out = typeof p.output === 'string' ? p.output : (p.output && p.output.content) || JSON.stringify(p.output || '');
        msgs.push({ role: 'tool_result', ts: l.timestamp, text: truncate(String(out), 600) });
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

  for (const s of sessions) {
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
  return { projects, generatedAt: new Date().toISOString() };
}

function apiSessionDetail(query) {
  const file = query.get('file');
  if (!file) throw httpError(400, 'missing file');
  if (file.startsWith('hermes:')) {
    const id = file.slice('hermes:'.length);
    if (!/^[\w.-]+$/.test(id)) throw httpError(400, 'bad hermes session id');
    return { file, source: 'hermes', messages: detailHermes(id) };
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
