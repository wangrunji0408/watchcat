const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const {
  decorateOpenClawSummary,
  detailClaude,
  detailCodex,
  detailDsh,
  detailHermesRows,
  detailOpenClaw,
  extractThinkingEffort,
  includeSubagentCosts,
  normalizeModelName,
  normalizedUsage,
  priceForModel,
  summarizeClaude,
  summarizeCodex,
  summarizeDsh,
  summarizeOpenClaw,
  summarizeUsageRecords,
} = require('../server');

test('recursively includes subagent usage and cost in parent sessions', () => {
  const usage = (inputTokens) => ({ inputTokens, cachedInputTokens: 0, cacheWriteTokens: 0,
    cacheWrite1hTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: inputTokens, requests: 1 });
  const sessions = [
    { file: '/parent', sessionKind: 'agent', models: ['parent-model'], usage: usage(100),
      cost: { usd: 1, complete: true, unknownModels: [] } },
    { file: '/child', parentFile: '/parent', sessionKind: 'subagent', models: ['child-model'], usage: usage(20),
      cost: { usd: .2, complete: true, unknownModels: [] } },
    { file: '/grandchild', parentFile: '/child', sessionKind: 'subagent', models: ['unknown-model'], usage: usage(3),
      cost: { usd: null, complete: false, unknownModels: ['unknown-model'] } },
  ];

  const [parent, child] = includeSubagentCosts(sessions);
  assert.equal(parent.usage.inputTokens, 123);
  assert.equal(parent.cost.usd, 1.2);
  assert.equal(parent.cost.complete, false);
  assert.deepEqual(parent.cost.unknownModels, ['unknown-model']);
  assert.equal(parent.subagentCount, 2);
  assert.equal(parent.subagentCost.usd, .2);
  assert.deepEqual(parent.models, ['parent-model', 'child-model', 'unknown-model']);
  assert.equal(child.usage.inputTokens, 23);
  assert.equal(sessions[0].usage.inputTokens, 100);
});

test('renders Hermes file and terminal tool calls with paired results', () => {
  const rows = [
    { role: 'assistant', content: '', reasoning: null, timestamp: 1, tool_calls: JSON.stringify([
      { id: 'write-1', function: { name: 'write_file', arguments: JSON.stringify({ path: '/tmp/a.js', content: 'ok();' }) } },
      { id: 'term-1', function: { name: 'terminal', arguments: JSON.stringify({ command: 'npm test' }) } },
    ]) },
    { role: 'tool', content: JSON.stringify({ bytes_written: 5 }), tool_name: 'write_file',
      tool_call_id: 'write-1', timestamp: 2 },
    { role: 'tool', content: JSON.stringify({ output: 'tests passed\n', exit_code: 0 }), tool_name: 'terminal',
      tool_call_id: 'term-1', timestamp: 3 },
  ];

  const detail = detailHermesRows(rows);
  assert.deepEqual(detail[0].write, { path: '/tmp/a.js', content: 'ok();' });
  assert.deepEqual(detail[1].bash, { command: 'npm test' });
  assert.equal(detail[2].callId, 'write-1');
  assert.equal(detail[3].callId, 'term-1');
  assert.equal(detail[3].output, 'tests passed\n');
});

test('renders Hermes read_file and patch calls using structured views', () => {
  const rows = [
    { role: 'assistant', content: '', reasoning: null, timestamp: 1, tool_calls: JSON.stringify([
      { call_id: 'read-1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
      { id: 'patch-1', function: { name: 'patch', arguments: JSON.stringify({
        path: 'README.md', old_string: 'old', new_string: 'new', mode: 'replace',
      }) } },
    ]) },
    { role: 'tool', content: JSON.stringify({ content: '# title\n' }), tool_name: 'read_file',
      tool_call_id: 'read-1', timestamp: 2 },
  ];

  const detail = detailHermesRows(rows);
  assert.deepEqual(detail[0].read, { path: 'README.md', offset: null, limit: null, pages: null });
  assert.deepEqual(detail[1].edit, { path: 'README.md', oldText: 'old', newText: 'new', replaceAll: false });
  assert.equal(detail[2].callId, 'read-1');
  assert.equal(detail[2].readContent, '# title\n');
});

test('parses DeepSeek Harness summaries and message details', () => {
  const rows = [
    { type: 'session', id: 'session-1', createdAt: 1785515761653, cwd: '/tmp/dsh-project' },
    { type: 'request/header', time: 1785515762000,
      data: { header: { config: { model: 'deepseek-v4-pro', reasoningEffort: 'max' } } } },
    { type: 'user/message', time: 1785515763000,
      data: { content: [{ type: 'text', text: 'build it' }] } },
    { type: 'session/title', time: 1785515763100, data: { title: 'Build the project' } },
    { type: 'assistant/message', time: 1785515764000, data: {
      message: { source: { model: 'deepseek-v4-pro' }, content: [
        { type: 'reasoning', text: 'inspect first' }, { type: 'text', text: 'working' },
      ] },
      usage: { inputTokens: 100, cacheReadTokens: 200, outputTokens: 50, reasoningTokens: 20 },
    } },
    { type: 'tool/call', time: 1785515765000,
      data: { callId: 'call-1', name: 'bash', arguments: '{"command":"npm test"}' } },
    { type: 'tool/result', time: 1785515766000, data: { message: {
      source: { kind: 'tool', callId: 'call-1' }, content: [{
      type: 'tool-result', content: [{ type: 'text', text: 'tests passed' }],
    }] } } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const file = '/tmp/project/session-1/session.jsonl.zstd';
  const summary = summarizeDsh(file, { size: content.length }, content);

  assert.equal(summary.source, 'dsh');
  assert.equal(summary.id, 'session-1');
  assert.equal(summary.project, '/tmp/dsh-project');
  assert.equal(summary.title, 'Build the project');
  assert.equal(summary.model, 'deepseek-v4-pro');
  assert.equal(summary.thinkingEffort, 'max');
  assert.equal(summary.turns, 2);
  assert.equal(summary.contextTokens, 300);
  assert.equal(summary.usage.cachedInputTokens, 200);

  const detail = detailDsh(file, content);
  assert.deepEqual(detail.map(m => m.role), ['user', 'thinking', 'assistant', 'tool_use', 'tool_result']);
  assert.deepEqual(detail[3].bash, { command: 'npm test' });
  assert.equal(detail[4].callId, 'call-1');
  assert.equal(detail[4].output, 'tests passed');
});

test('extracts Codex thinking effort from turn context', () => {
  const rows = [
    { type: 'session_meta', timestamp: '2026-07-17T00:00:00Z',
      payload: { id: 'codex-1', cwd: '/tmp/project' } },
    { type: 'turn_context', timestamp: '2026-07-17T00:00:01Z',
      payload: { model: 'gpt-5.4', effort: 'high' } },
    { type: 'event_msg', timestamp: '2026-07-17T00:00:02Z',
      payload: { type: 'user_message', message: 'hello' } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeCodex('/tmp/session.jsonl', { size: content.length }, content);
  assert.equal(summary.thinkingEffort, 'high');
});

test('normalizes provider and dated model aliases', () => {
  assert.equal(normalizeModelName('openai/gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(normalizeModelName('azure-gpt-5.4-2026-03-05'), 'gpt-5.4');
  assert.equal(priceForModel('anthropic/claude-opus-4-8').input, 5);
});

test('normalizes thinking effort from runtime-specific configurations', () => {
  assert.equal(extractThinkingEffort({ thinkingLevel: 'low' }), 'low');
  assert.equal(extractThinkingEffort('{"reasoning_config":{"effort":"high"}}'), 'high');
  assert.equal(extractThinkingEffort({ reasoningEffort: 'max' }), 'max');
  assert.equal(extractThinkingEffort({ reasoning_config: null }), null);
});

test('prices Codex uncached, cached, and output tokens separately', () => {
  const usage = normalizedUsage({
    input_tokens: 19_000,
    cached_input_tokens: 9_984,
    output_tokens: 314,
    total_tokens: 19_314,
  }, 'codex');
  const result = summarizeUsageRecords([{ model: 'gpt-5.6-sol', usage }]);

  assert.equal(usage.inputTokens, 9_016);
  assert.equal(usage.cachedInputTokens, 9_984);
  assert.equal(result.cost.usd, 0.059492);
  assert.equal(result.cost.complete, true);
});

test('uses long-context prices above 272K input tokens', () => {
  const usage = normalizedUsage({ input_tokens: 300_000, output_tokens: 1_000 }, 'codex');
  const result = summarizeUsageRecords([{ model: 'gpt-5.4', usage }]);

  assert.equal(result.cost.usd, 1.5225);
});

test('deduplicates repeated Claude log entries by message id', () => {
  const user = { type: 'user', message: { content: 'hello' }, timestamp: '2026-07-17T00:00:00Z' };
  const assistant = {
    type: 'assistant',
    effort: 'xhigh',
    timestamp: '2026-07-17T00:00:01Z',
    message: {
      id: 'msg-1',
      model: 'claude-fable-5',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 10 },
    },
  };
  const summary = summarizeClaude('/tmp/session.jsonl', { size: 1 },
    [user, assistant, { ...assistant, uuid: 'duplicate-row' }].map(JSON.stringify).join('\n'));

  assert.equal(summary.model, 'claude-fable-5');
  assert.equal(summary.thinkingEffort, 'xhigh');
  assert.equal(summary.usage.requests, 1);
  assert.equal(summary.usage.totalTokens, 310);
  assert.equal(summary.cost.usd, 0.0017);
});

test('splits usage records into per-day per-model cost buckets', () => {
  const { summarizeDailyRecords } = require('../server');
  const usage = normalizedUsage({ input_tokens: 1_000_000, output_tokens: 0 }, 'claude');
  const records = [
    { model: 'claude-fable-5', usage, ts: '2026-07-20T18:00:00+08:00' },
    { model: 'claude-fable-5', usage, ts: '2026-07-20T19:00:00+08:00' },
    { model: 'gpt-5.5', usage, ts: '2026-07-21T08:00:00+08:00' },
    { model: 'gpt-5.5', usage, ts: null }, // 无时间戳的记录不进入按天统计
  ];
  const daily = summarizeDailyRecords(records);

  assert.equal(daily.length, 2);
  assert.deepEqual(daily.map(d => d.model), ['claude-fable-5', 'gpt-5.5']);
  assert.equal(daily[0].usd, 20); // 2M input @ $10/M
  assert.equal(daily[0].requests, 2);
  assert.ok(daily[0].date <= daily[1].date);
});

test('claude summaries expose daily cost and activity buckets', () => {
  const mkAssistant = (id, ts) => ({
    type: 'assistant', timestamp: ts,
    message: {
      id, model: 'claude-fable-5', content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 100, output_tokens: 10 },
    },
  });
  const rows = [
    { type: 'user', message: { content: 'hello' }, timestamp: '2026-07-19T23:00:00Z' },
    mkAssistant('m1', '2026-07-19T23:00:10Z'),
    mkAssistant('m2', '2026-07-20T01:00:00Z'),
  ];
  const summary = summarizeClaude('/tmp/session.jsonl', { size: 1 },
    rows.map(JSON.stringify).join('\n'));

  assert.equal(summary.daily.reduce((a, d) => a + d.requests, 0), 2);
  assert.ok(summary.daily.every(d => d.model === 'claude-fable-5'));
  assert.equal(summary.activity.reduce((a, d) => a + d.turns, 0), 3);
});

test('marks models without an official catalog price as unknown', () => {
  const usage = normalizedUsage({ input_tokens: 1_000, output_tokens: 100 }, 'claude');
  const result = summarizeUsageRecords([{ model: 'unknown-model-v1', usage }]);

  assert.equal(result.cost.usd, null);
  assert.deepEqual(result.cost.unknownModels, ['unknown-model-v1']);
});

test('parses OpenClaw messages, tools, usage, and subagent metadata', () => {
  const file = path.join(os.homedir(), '.openclaw', 'agents', 'main', 'sessions',
    '11111111-1111-4111-8111-111111111111.jsonl');
  const rows = [
    { type: 'session', version: 3, id: 'session-1', timestamp: '2026-07-18T00:00:00Z', cwd: '/tmp/project' },
    { type: 'model_change', timestamp: '2026-07-18T00:00:01Z', provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
    { type: 'message', timestamp: '2026-07-18T00:00:02Z', message: { role: 'user', content: 'build it' } },
    { type: 'message', timestamp: '2026-07-18T00:00:03Z', message: {
      role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5',
      content: [
        { type: 'thinking', thinking: 'plan' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'a.txt' } },
      ],
      usage: { input: 10, output: 5, cacheRead: 20, cacheWrite: 30, totalTokens: 65 },
    } },
    { type: 'message', timestamp: '2026-07-18T00:00:04Z', message: {
      role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: 'contents' }],
    } },
    { type: 'message', timestamp: '2026-07-18T00:00:05Z', message: {
      role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'done' }],
      usage: { input: 11, output: 6, cacheRead: 21, cacheWrite: 31, totalTokens: 69 },
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const raw = summarizeOpenClaw(file, { size: content.length }, content);
  const summary = decorateOpenClawSummary(raw, {
    agentId: 'main', sessionKey: 'agent:main:subagent:child-1', label: 'worker',
    parentSessionKey: 'agent:main:main', parentSessionId: 'parent-1', status: 'done', thinkingLevel: 'low',
  });

  assert.equal(summary.project, '/tmp/project');
  assert.equal(summary.title, 'worker');
  assert.equal(summary.sessionKind, 'subagent');
  assert.equal(summary.thinkingEffort, 'low');
  assert.equal(summary.parentSessionId, 'parent-1');
  assert.equal(summary.turns, 3);
  assert.equal(summary.usage.inputTokens, 21);
  assert.equal(summary.usage.cachedInputTokens, 41);
  assert.equal(summary.usage.cacheWriteTokens, 61);
  assert.equal(summary.contextTokens, 69);

  const detail = detailOpenClaw(file, content);
  assert.deepEqual(detail.map(m => m.role), ['user', 'thinking', 'tool_use', 'tool_result', 'assistant']);
  assert.equal(detail[2].callId, 'call-1');
  assert.equal(detail[3].output, 'contents');
});

test('parses Claude Code sidechain rows when they are in a subagent transcript', () => {
  const file = '/tmp/project/parent-session/subagents/agent-worker-1.jsonl';
  const rows = [
    { type: 'user', isSidechain: true, agentId: 'worker-1', sessionId: 'parent-session',
      cwd: '/tmp/project', timestamp: '2026-07-18T00:00:00Z', message: { content: 'inspect the code' } },
    { type: 'assistant', isSidechain: true, agentId: 'worker-1', sessionId: 'parent-session',
      cwd: '/tmp/project', timestamp: '2026-07-18T00:00:01Z', message: {
        id: 'msg-1', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'found it' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeClaude(file, { size: content.length }, content);

  assert.equal(summary.id, 'worker-1');
  assert.equal(summary.sessionKind, 'subagent');
  assert.equal(summary.parentSessionId, 'parent-session');
  assert.equal(summary.project, '/tmp/project');
  assert.equal(summary.turns, 2);
  assert.deepEqual(detailClaude(file, content).map(m => m.role), ['user', 'assistant']);
});

test('renders Claude Code subagent launch and completion as agent events', () => {
  const rows = [
    { type: 'user', timestamp: '2026-07-18T00:00:00Z', toolUseResult: {
      isAsync: true, status: 'async_launched', agentId: 'worker-2', description: 'Find benchmarks',
    }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'launched' }] } },
    { type: 'user', timestamp: '2026-07-18T00:01:00Z', message: { role: 'user', content:
      '<task-notification>\n<task-id>worker-2</task-id>\n<status>completed</status>\n' +
      '<summary>Agent "Find benchmarks" finished</summary>\n<result>done</result>\n</task-notification>' } },
  ];
  const detail = detailClaude('/tmp/project/main.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.deepEqual(detail.map(m => [m.role, m.event, m.agentId]), [
    ['subagent', 'started', 'worker-2'],
    ['subagent', 'completed', 'worker-2'],
  ]);
  assert.equal(detail[1].title, 'Find benchmarks');
});

test('preserves structured Edit arguments for diff rendering', () => {
  const edit = {
    type: 'assistant', timestamp: '2026-07-18T00:00:00Z', message: { content: [{
      type: 'tool_use', id: 'edit-1', name: 'Edit', input: {
        file_path: '/tmp/example.js', old_string: 'const old = true;\n',
        new_string: 'const updated = true;\n', replace_all: true,
      },
    }] },
  };
  const [message] = detailClaude('/tmp/project/main.jsonl', JSON.stringify(edit));

  assert.deepEqual(message.edit, {
    path: '/tmp/example.js', oldText: 'const old = true;\n',
    newText: 'const updated = true;\n', replaceAll: true,
  });
  assert.ok(message.input.includes('old_string'));
});

test('preserves Bash commands and Write content for specialized rendering', () => {
  const row = {
    type: 'assistant', timestamp: '2026-07-18T00:00:00Z', message: { content: [
      { type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'npm test\necho done' } },
      { type: 'tool_use', id: 'write-1', name: 'Write', input: {
        file_path: '/tmp/new.txt', content: 'first line\nsecond line\n',
      } },
    ] },
  };
  const detail = detailClaude('/tmp/project/main.jsonl', JSON.stringify(row));

  assert.deepEqual(detail[0].bash, { command: 'npm test\necho done' });
  assert.deepEqual(detail[1].write, {
    path: '/tmp/new.txt', content: 'first line\nsecond line\n',
  });
});

test('preserves complete Read results and structured file ranges', () => {
  const fileContent = Array.from({ length: 80 }, (_, i) => `line ${i + 1}: ${'x'.repeat(12)}`).join('\n');
  const rows = [
    { type: 'assistant', timestamp: '2026-07-18T00:00:00Z', message: { content: [{
      type: 'tool_use', id: 'read-1', name: 'Read', input: {
        file_path: '/tmp/long.txt', offset: 20, limit: 80,
      },
    }] } },
    { type: 'user', timestamp: '2026-07-18T00:00:01Z', message: { content: [{
      type: 'tool_result', tool_use_id: 'read-1', content: fileContent,
    }] } },
  ];
  const detail = detailClaude('/tmp/project/main.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.deepEqual(detail[0].read, {
    path: '/tmp/long.txt', offset: 20, limit: 80, pages: null,
  });
  assert.ok(fileContent.length > 600);
  assert.equal(detail[1].output, fileContent);
  assert.equal(detail[1].readContent, fileContent);
});

test('renders context compaction events from supported logs', () => {
  const claude = detailClaude('/tmp/project/main.jsonl', JSON.stringify({
    type: 'system', subtype: 'compact_boundary', timestamp: '2026-07-18T00:00:00Z',
    compactMetadata: { trigger: 'auto', preTokens: 167000, postTokens: 4200, durationMs: 1500 },
  }));
  assert.deepEqual(claude, [{
    role: 'compaction', ts: '2026-07-18T00:00:00Z', trigger: 'auto',
    beforeTokens: 167000, afterTokens: 4200, durationMs: 1500,
  }]);

  const codex = detailCodex('/tmp/session.jsonl', JSON.stringify({
    type: 'compacted', timestamp: '2026-07-18T00:01:00Z',
    payload: { trigger: 'manual', tokens_before: 120000, tokens_after: 5000 },
  }));
  assert.equal(codex[0].role, 'compaction');
  assert.equal(codex[0].beforeTokens, 120000);

  const openClaw = detailOpenClaw('/tmp/session.jsonl', JSON.stringify({
    type: 'compaction', timestamp: '2026-07-18T00:02:00Z', fromHook: true, tokensBefore: 190000,
  }));
  assert.equal(openClaw[0].role, 'compaction');
  assert.equal(openClaw[0].trigger, 'auto');
  assert.equal(openClaw[0].beforeTokens, 190000);
});
