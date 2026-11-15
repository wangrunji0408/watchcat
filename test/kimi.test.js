const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { listKimiSessionFiles, detailKimi, summarizeKimi, decorateKimiSummary, kimiProjects } = require('../server');

// Entirely synthetic records; do not copy real sessions into tests.
const encode = rows => rows.map(JSON.stringify).join('\n');
const event = (type, payload = {}, timestamp = 1700000000) => ({ timestamp, message: { type, payload } });
const stat = { size: 100, mtimeMs: 1700000000000, birthtimeMs: 1699999999000 };

test('Kimi streams text, reasoning, tool arguments and results in order', () => {
  const content = encode([
    { type: 'metadata', protocol_version: '1.5' },
    event('TurnBegin', { user_input: [{ type: 'text', text: 'Read example' }] }),
    event('StepBegin', { n: 1 }),
    event('ThinkPart', { think: 'Let me ' }), event('ThinkPart', { think: 'check.' }),
    event('ToolCall', { id: 'read-1', function: { name: 'ReadFile', arguments: '{"path":' } }),
    event('ToolCallPart', { arguments_part: '"/example/file.txt"}' }),
    event('ToolResult', { tool_call_id: 'read-1', return_value: {
      is_error: false, output: [{ type: 'text', text: 'Example content' }], message: '' } }),
    event('StepBegin', { n: 2 }),
    event('TextPart', { text: 'Found ' }), event('TextPart', { text: 'it.' }),
    event('TurnEnd'),
    event('TurnBegin', { user_input: 'Continue' }),
    event('TextPart', { text: 'Done.' }),
  ]) + '\n{"timestamp":';
  const messages = detailKimi('/example/wire.jsonl', content);
  assert.deepEqual(messages.map(m => m.role), [
    'user', 'thinking', 'tool_use', 'tool_result', 'assistant', 'user', 'assistant',
  ]);
  assert.equal(messages[1].text, 'Let me check.');
  assert.equal(messages[2].arguments, '{"path":"/example/file.txt"}');
  assert.equal(messages[3].toolName, 'ReadFile');
  assert.equal(messages[3].output, 'Example content');
  assert.equal(messages[3].readContent, 'Example content');
  assert.equal(messages[4].text, 'Found it.');
  assert.equal(messages[0].ts, '2023-11-14T22:13:20.000Z');
  assert.equal(summarizeKimi('/example/id/wire.jsonl', stat, content).turns, 4);
});

test('Kimi summarizes usage and compaction without guessing a model or price', () => {
  const content = encode([
    event('TurnBegin', { user_input: 'Synthetic request' }),
    event('StatusUpdate', { context_tokens: 130, token_usage: {
      input_other: 100, input_cache_read: 20, input_cache_creation: 10, output: 30 } }),
    event('CompactionBegin'), event('CompactionEnd'),
    event('StatusUpdate', { context_tokens: 50, token_usage: { input_other: 40, output: 5 } }),
    event('TextPart', { text: 'Synthetic response' }),
  ]);
  const summary = summarizeKimi('/example/id/wire.jsonl', stat, content);
  assert.equal(summary.source, 'kimi');
  assert.equal(summary.id, 'id');
  assert.equal(summary.title, 'Synthetic request');
  assert.equal(summary.lastMessage, 'Synthetic response');
  assert.equal(summary.contextTokens, 50);
  assert.deepEqual(summary.contextPeaks, [130]);
  assert.equal(summary.usage.inputTokens, 140);
  assert.equal(summary.usage.cachedInputTokens, 20);
  assert.equal(summary.usage.outputTokens, 35);
  assert.equal(summary.usage.totalTokens, 205);
  assert.equal(summary.usage.requests, 2);
  assert.equal(summary.model, null);
  assert.equal(summary.cost.usd, null);
  assert.equal(summary.daily.length, 1);
  assert.equal(summary.activity[0].turns, 2);
});

test('Kimi context-only and legacy files ignore internal records and retain tools', () => {
  const content = encode([
    { role: '_system_prompt', content: 'Hidden policy' },
    { role: '_checkpoint', id: 0 },
    { role: 'user', content: 'Synthetic task' },
    { role: 'assistant', content: [{ type: 'think', think: 'Reason' }], tool_calls: [
      { id: 'shell-1', function: { name: 'Shell', arguments: '{"command":"pwd"}' } },
    ] },
    { role: 'tool', tool_call_id: 'shell-1', content: 'Synthetic output' },
    { role: 'assistant', content: 'Completed' },
    { role: '_usage', token_count: 88 }, null, 42,
  ]);
  const summary = summarizeKimi('/example/legacy-id.jsonl', stat, content);
  assert.equal(summary.id, 'legacy-id');
  assert.equal(summary.contextTokens, 88);
  assert.equal(summary.lastTs, '2023-11-14T22:13:20.000Z');
  assert.deepEqual(detailKimi('unused', content).map(m => m.role), ['user', 'thinking', 'tool_use', 'tool_result', 'assistant']);
  assert.equal(summarizeKimi('unused', stat, '{"role":"_checkpoint","id":0}'), null);
});

test('Kimi discovers one log per session, legacy paths and header-only fallback', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watchcat-kimi-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'sessions');
  const write = (name, rows) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encode(rows));
  };
  write('hash/modern/wire.jsonl', [event('TurnBegin', { user_input: 'Example' })]);
  write('hash/modern/context.jsonl', []);
  write('hash/modern.jsonl', []);
  write('hash/modern/subagents/child/context.jsonl', []);
  write('hash/fallback/wire.jsonl', [{ type: 'metadata', protocol_version: '1.5' }]);
  write('hash/fallback/context.jsonl', [{ role: 'user', content: 'Old example' }]);
  write('hash/legacy.jsonl', [{ role: 'user', content: 'Legacy example' }]);
  write('hash/empty/wire.jsonl', []);
  assert.deepEqual(listKimiSessionFiles(root).map(f => path.relative(root, f)).sort(), [
    'hash/fallback/context.jsonl', 'hash/legacy.jsonl', 'hash/modern/wire.jsonl',
  ]);
  assert.deepEqual(listKimiSessionFiles(path.join(home, 'missing')), []);
});

test('Kimi resolves project hashes and refreshes custom titles independently of logs', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watchcat-kimi-meta-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const project = '/synthetic/project';
  const hash = crypto.createHash('md5').update(project).digest('hex');
  fs.writeFileSync(path.join(home, 'kimi.json'), JSON.stringify({ work_dirs: [{ path: project, kaos: 'local' }] }));
  const dir = path.join(home, 'sessions', hash, 'session-id');
  fs.mkdirSync(dir, { recursive: true });
  const summary = summarizeKimi(path.join(dir, 'wire.jsonl'), stat, encode([event('TurnBegin', { user_input: 'Original' })]));
  fs.writeFileSync(path.join(dir, 'state.json'), '{"custom_title":"Renamed"}');
  const decorated = decorateKimiSummary(summary, kimiProjects(home));
  assert.equal(decorated.project, project);
  assert.equal(decorated.title, 'Renamed');
  assert.equal(summary.title, 'Original');
  assert.equal(kimiProjects(home).get('local_' + hash), project);
});

test('Kimi Code Node logs read messages once and price the recorded model usage', () => {
  const time = 1800000000000;
  const row = (type, data) => ({ type, time, ...data });
  const loop = e => row('context.append_loop_event', { event: e });
  const usage = { inputOther: 100, inputCacheRead: 20, inputCacheCreation: 10, output: 30 };
  const content = encode([
    { type: 'metadata', protocol_version: '1.5', created_at: time },
    row('profile.bind', { thinkingEffort: 'max', environmentDisclosure: { cwd: '/synthetic/project' } }),
    row('turn.prompt', { input: [{ type: 'text', text: 'Synthetic request' }] }),
    row('context.append_message', { message: { role: 'user', content: 'Synthetic request' } }),
    row('agent.message.appended', { message: { message: { role: 'user', content: 'Synthetic request' } } }),
    row('llm.request', { model: 'moonshotai/kimi-k3.1-pro', thinkingEffort: 'max' }),
    loop({ type: 'step.begin' }),
    loop({ type: 'content.part', part: { type: 'think', think: 'Check example.' } }),
    loop({ type: 'tool.call', toolCallId: 'call-1', name: 'Shell', args: { command: 'pwd' } }),
    loop({ type: 'tool.result', toolCallId: 'call-1', result: { output: 'Example output', isError: true } }),
    loop({ type: 'content.part', part: { type: 'text', text: 'All ' } }),
    loop({ type: 'content.part', part: { type: 'text', text: 'done.' } }),
    loop({ type: 'step.end', usage }),
    row('agent.message.appended', { message: { message: { role: 'assistant', content: 'All done.' }, meta: { usage } } }),
    row('usage.record', { model: 'high-five/moonshotai/kimi-k3.1-pro', usage, usageScope: 'turn' }),
    row('token_counting.measured', { tokens: 160 }),
  ]);
  const summary = summarizeKimi('/synthetic/agents/main/wire.jsonl', stat, content);
  const messages = detailKimi('unused', content);
  assert.deepEqual(messages.map(m => m.role), ['user', 'thinking', 'tool_use', 'tool_result', 'assistant']);
  assert.equal(summary.turns, 2);
  assert.equal(summary.project, '/synthetic/project');
  assert.equal(summary.thinkingEffort, 'max');
  assert.equal(summary.usage.requests, 1);
  assert.equal(summary.contextTokens, 160);
  assert.equal(summary.firstTs, new Date(time).toISOString());
  assert.equal(summary.cost.complete, true);
  assert.ok(Math.abs(summary.cost.usd - 0.000524) < 1e-10);
  assert.deepEqual(messages[2].bash, { command: 'pwd' });
  assert.equal(messages[3].isError, true);
  assert.equal(messages[4].text, 'All done.');
});

test('Kimi Code discovers and links Node subagents for usage aggregation', t => {
  const { includeSubagentCosts, attachSubagentEvents } = require('../server');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchcat-kimi-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sessionDir = path.join(dir, 'workspace', 'session_example');
  fs.mkdirSync(sessionDir, { recursive: true });
  const state = { id: 'example', cwd: '/synthetic/project', title: 'Custom title', agents: {
    main: { type: 'main' }, 'agent-0': { type: 'sub', parentAgentId: 'main' },
  } };
  fs.writeFileSync(path.join(sessionDir, 'state.json'), JSON.stringify(state));
  for (const agent of ['main', 'agent-0']) {
    const file = path.join(sessionDir, 'agents', agent, 'wire.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encode([
      { type: 'turn.prompt', time: 1800000000000, input: 'Synthetic task' },
      { type: 'usage.record', time: 1800000000000, model: 'kimi-k3.1-pro', usage: { inputOther: 100, output: 20 } },
    ]));
  }
  const files = listKimiSessionFiles(dir);
  assert.equal(files.length, 2);
  const sessions = files.map(file => decorateKimiSummary(summarizeKimi(file, fs.statSync(file)), new Map()));
  const parent = sessions.find(s => s.sessionKind === 'agent');
  const child = sessions.find(s => s.sessionKind === 'subagent');
  assert.equal(parent.id, 'example');
  assert.equal(parent.title, 'Custom title');
  assert.equal(child.parentFile, parent.file);
  assert.equal(child.agentId, 'agent-0');
  assert.equal(includeSubagentCosts(sessions).find(s => s.id === parent.id).usage.requests, 2);
  assert.equal(attachSubagentEvents([], parent.file, [child])[0].subagent.file, child.file);
});

test('Kimi current official pricing distinguishes K3.1 variants and cache write TTLs', () => {
  const { priceForModel, normalizedUsage, summarizeUsageRecords } = require('../server');
  const prices = [
    ['kimi-k3.1-pro', 2, .2, 10, 2, 4],
    ['kimi-k3.1-pro-highspeed', 4, .2, 20, 4, 8],
    ['kimi-k3', 3, .3, 15, 3, 6],
    ['kimi-k2.7-code', .95, .19, 4],
    ['kimi-k2.7-code-highspeed', 1.9, .38, 8],
    ['kimi-k2.6', .95, .16, 4],
  ];
  for (const [model, input, cached, output, cacheWrite5m, cacheWrite1h] of prices) {
    const price = priceForModel('high-five/moonshotai/' + model);
    assert.deepEqual([price.input, price.cached, price.output, price.cacheWrite5m, price.cacheWrite1h],
      [input, cached, output, cacheWrite5m, cacheWrite1h]);
  }
  assert.equal(priceForModel('kimi-k3.2-unknown'), null);
  const result = summarizeUsageRecords([{ model: 'kimi-k3.1-pro', usage: normalizedUsage({
    input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000,
    cache_creation_input_tokens: 2000000,
    cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 1000000 },
  }, 'kimi') }]);
  assert.equal(result.cost.usd, 18.2);
});

test('Kimi detail API accepts the configured Node session root and rejects outside paths', t => {
  const { execFileSync } = require('node:child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'watchcat-kimi-api-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'sessions', 'workspace', 'session_example', 'agents', 'main', 'wire.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encode([{ type: 'turn.prompt', time: 1800000000000, input: 'Synthetic API request' }]));
  const output = execFileSync(process.execPath, ['-e', `
    const { apiSessionDetail } = require('./server');
    const result = apiSessionDetail(new URLSearchParams({ file: process.env.KIMI_TEST_FILE }));
    let status;
    try { apiSessionDetail(new URLSearchParams({ file: process.env.KIMI_CODE_HOME + '/outside.jsonl' })); }
    catch (error) { status = error.statusCode; }
    console.log(JSON.stringify({ source: result.source, messages: result.messages, status }));
  `], { cwd: path.join(__dirname, '..'), env: { ...process.env, KIMI_CODE_HOME: home, KIMI_TEST_FILE: file }, encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.source, 'kimi');
  assert.equal(result.messages[0].text, 'Synthetic API request');
  assert.equal(result.status, 403);
});
