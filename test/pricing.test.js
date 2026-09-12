const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const {
  alignRemoteCacheFile,
  attachSubagentEvents,
  decorateOpenClawSummary,
  decorateHermesSummary,
  detailClaude,
  detailCodex,
  detailCetus,
  detailDsh,
  detailHermesRows,
  detailOpenClaw,
  extractThinkingEffort,
  includeSubagentCosts,
  linkCodexSubagents,
  linkDshSubagents,
  normalizeModelName,
  normalizedUsage,
  parseHermesDelegationBatch,
  parseHermesBackgroundProcess,
  priceForModel,
  summarizeClaude,
  summarizeCodex,
  summarizeCetus,
  summarizeDsh,
  summarizeOpenClaw,
  summarizeUsageRecords,
} = require('../server');

test('renders Codex attachment envelopes as a collapsed compact list', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /function renderUserMarkdown\(text\)/);
  assert.match(html, /Files mentioned by the user:[\s\S]*?My request:/);
  assert.match(html, /<details|el\('details', 'user-attachments'\)/);
  assert.match(html, /m\.role === 'user' \? renderUserMarkdown\(m\.text\)/);
});

test('prevents iOS from enlarging individual diff lines', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /\.edit-diff\s*\{[^}]*-webkit-text-size-adjust:\s*none;[^}]*text-size-adjust:\s*none;/s);
});

test('allows the aggregated other model slice to expand into model details', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /const rawTotals = new Map\(\)/);
  assert.match(html, /const slices = otherValue > 0 \? \[\.\.\.top, \[other, otherValue\]\] : top/);
  assert.match(html, /otherDetails\.hidden = !expanded/);
  assert.match(html, /row\.onclick = toggleOtherDetails/);
  assert.match(html, /path\.addEventListener\('click', toggleOtherDetails\)/);
  assert.match(html, /for \(const \[model, modelValue\] of otherModels\)/);
});

test('links Hermes subagents to their main session so the list can hide them', () => {
  const child = decorateHermesSummary(
    { source: 'hermes', id: 'child', file: 'hermes:child' },
    'main',
    'subagent',
  );

  assert.equal(child.sessionKind, 'subagent');
  assert.equal(child.parentSessionId, 'main');
  assert.equal(child.parentFile, 'hermes:main');
  assert.equal(child.subagentType, 'hermes');
});

test('does not nest continued Hermes channel sessions as subagents', () => {
  const session = { source: 'hermes', id: 'next', file: 'hermes:next' };
  const decorated = decorateHermesSummary(session, 'previous', 'weixin');

  assert.equal(decorated, session);
  assert.equal(decorated.sessionKind, undefined);
  assert.equal(decorated.parentFile, undefined);
});

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

test('renders Hermes context summaries as compaction events', () => {
  const prefix = '[CONTEXT COMPACTION — REFERENCE ONLY] Earlier turns were compacted into the summary below:';
  const rows = [
    { role: 'user', content: `${prefix}\n## Checkpoint\n\nContinue here.`, timestamp: 1 },
    { role: 'assistant', content: '[CONTEXT SUMMARY]: Legacy checkpoint', timestamp: 2 },
    { role: 'user', content: 'actual request', timestamp: 3 },
  ];

  const detail = detailHermesRows(rows);
  assert.deepEqual(detail.map(message => message.role), ['compaction', 'compaction', 'user']);
  assert.equal(detail[0].summary, '## Checkpoint\n\nContinue here.');
  assert.equal(detail[1].summary, 'Legacy checkpoint');
  assert.equal(detail[2].text, 'actual request');
});

test('renders Hermes background process notifications as task events', () => {
  const content = `[IMPORTANT: Background process proc_example completed normally (exit code 0).
Command: npm test
Output:
all tests passed
]`;
  assert.deepEqual(parseHermesBackgroundProcess(content), {
    role: 'background_task', event: 'completed', taskId: 'proc_example', toolName: 'terminal',
    exitCode: 0, command: 'npm test', output: 'all tests passed',
  });
  const detail = detailHermesRows([{ role: 'user', content, timestamp: 1, active: 1 }]);
  assert.equal(detail[0].role, 'background_task');
});

test('renders Hermes async delegation batch completions as structured events', () => {
  const content = `[ASYNC DELEGATION BATCH COMPLETE — deleg_example]
A background fan-out of 2 subagent(s) you dispatched earlier has finished.
Role: leaf   Model: deepseek-v4-flash   Total duration: 12.5s

--- ✓ TASK 1/2: First task  (status=done, api_calls=3, 10.2s) ---
Completed successfully.
Full live transcript (complete tool/assistant trace): /tmp/task-0.log

--- ✗ TASK 2/2: Second task  (status=timeout, api_calls=4, 12.4s) ---
(no summary — status=timeout)`;
  const batch = parseHermesDelegationBatch(content);
  assert.equal(batch.role, 'delegation_batch');
  assert.equal(batch.delegationId, 'deleg_example');
  assert.equal(batch.model, 'deepseek-v4-flash');
  assert.equal(batch.tasks.length, 2);
  assert.deepEqual(batch.tasks[0], {
    index: 1, total: 2, symbol: '✓', title: 'First task', status: 'done', apiCalls: 3,
    duration: 10.2, summary: 'Completed successfully.', transcript: '/tmp/task-0.log',
  });

  const detail = detailHermesRows([{ role: 'user', content, timestamp: 1, active: 1 }]);
  assert.deepEqual(detail.map(message => [message.role, message.event, message.title]), [
    ['subagent', 'completed', 'First task'],
    ['subagent', 'timeout', 'Second task'],
  ]);
});

test('does not render inactive Hermes compaction archive copies', () => {
  const rows = [
    { role: 'user', content: 'preserved request', timestamp: 1, active: 0, compacted: 1 },
    { role: 'user', content: 'preserved request', timestamp: 1, active: 1, compacted: 0 },
    { role: 'assistant', content: 'preserved response', timestamp: 2, active: 0, compacted: 1 },
    { role: 'assistant', content: 'preserved response', timestamp: 2, active: 1, compacted: 0 },
  ];

  const detail = detailHermesRows(rows);
  assert.deepEqual(detail.map(message => message.text), ['preserved request', 'preserved response']);
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
    { type: 'tool/result', time: 1785515767000, data: { message: {
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
  assert.equal(detail[4].toolName, 'bash');
  assert.equal(detail[4].output, 'tests passed');
  assert.equal(detail.filter(message => message.role === 'tool_result').length, 1);
});

test('keeps an active DeepSeek Harness goal session before it emits plain text', () => {
  const rows = [
    { type: 'session', id: 'goal-session', createdAt: 1786728202863, cwd: '/tmp/dsh-goal' },
    { type: 'user/message', time: 1786729499568, data: {
      source: { kind: 'goal', goalId: 'goal-example', round: 1 },
      content: [{ type: 'text', text: '<goal_round>\nObjective: "Build the kernel"\nRound: 1/10\n</goal_round>' }],
    } },
    { type: 'assistant/message', time: 1786729502698, data: { message: {
      source: { model: 'deepseek-v4-pro' },
      content: [
        { type: 'reasoning', text: 'Inspect the workspace first.' },
        { type: 'tool-call', name: 'bash', arguments: '{"command":"pwd"}' },
      ],
    } } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeDsh('/tmp/goal-session/session.jsonl.zstd', { size: content.length }, content);

  assert.ok(summary);
  assert.equal(summary.id, 'goal-session');
  assert.equal(summary.title, 'Build the kernel');
  assert.equal(summary.turns, 0);
  assert.equal(summary.model, 'deepseek-v4-pro');
});

test('preserves DeepSeek str_replace_editor commands for specialized rendering', () => {
  const calls = [
    { type: 'tool/call', time: 1785515765000, data: {
      callId: 'replace-1', name: 'str_replace_editor', arguments: JSON.stringify({
        command: 'str_replace', path: '/tmp/example.js', old_str: 'const old = true;\n',
        new_str: 'const updated = true;\n',
      }),
    } },
    { type: 'tool/call', time: 1785515765001, data: {
      callId: 'create-1', name: 'str_replace_editor', arguments: JSON.stringify({
        command: 'create', path: '/tmp/new.txt', file_text: 'first\nsecond\n',
      }),
    } },
    { type: 'tool/call', time: 1785515765002, data: {
      callId: 'insert-1', name: 'str_replace_editor', arguments: JSON.stringify({
        command: 'insert', path: '/tmp/example.js', insert_line: 8, new_str: 'inserted();\n',
      }),
    } },
    { type: 'tool/call', time: 1785515765003, data: {
      callId: 'view-1', name: 'str_replace_editor', arguments: JSON.stringify({
        command: 'view', path: '/tmp/example.js', view_range: [10, 25],
      }),
    } },
  ];
  const detail = detailDsh('/tmp/editor/session.jsonl.zstd', calls.map(JSON.stringify).join('\n'));

  assert.deepEqual(detail[0].edit, {
    path: '/tmp/example.js', oldText: 'const old = true;\n',
    newText: 'const updated = true;\n', replaceAll: false,
  });
  assert.deepEqual(detail[1].write, { path: '/tmp/new.txt', content: 'first\nsecond\n' });
  assert.deepEqual(detail[2].write, {
    path: '/tmp/example.js', content: 'inserted();\n', insertLine: 8,
  });
  assert.deepEqual(detail[3].read, {
    path: '/tmp/example.js', offset: null, limit: null, pages: null, startLine: 10, endLine: 25,
  });
});

test('links DeepSeek Harness subagent sessions to their parent', () => {
  const parentRows = [
    { type: 'session', id: 'parent', cwd: '/tmp/project' },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'delegate' }] } },
    { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', content: [
      { type: 'text', text: 'started subagent child-id' },
    ] }] } } },
  ];
  const childRows = [
    { type: 'session', id: 'child-id', cwd: '/tmp/project' },
    { type: 'subagent/descriptor', data: { label: 'Review parser', mode: 'continuable' } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
  ];
  const parent = summarizeDsh('/tmp/parent/session.jsonl.zstd', { size: 1 }, parentRows.map(JSON.stringify).join('\n'));
  const child = summarizeDsh('/tmp/child-id/session.jsonl.zstd', { size: 1 }, childRows.map(JSON.stringify).join('\n'));
  linkDshSubagents([parent, child]);
  assert.equal(child.sessionKind, 'subagent');
  assert.equal(child.subagentType, 'Review parser');
  assert.equal(child.parentFile, parent.file);
});

test('does not duplicate a linked DeepSeek Harness subagent start event', () => {
  const parentFile = '/tmp/parent/session.jsonl.zstd';
  const child = { source: 'dsh', id: 'child-id', agentId: 'child-id',
    file: '/tmp/child/session.jsonl.zstd', parentFile, project: '/tmp',
    title: 'You are working in the', subagentType: 'Build static riscv64 nginx', sessionKind: 'subagent' };
  const events = attachSubagentEvents([{
    role: 'subagent', event: 'started', agentId: 'call-1',
    title: 'Build static riscv64 nginx', ts: '2026-08-13T13:56:00Z',
  }], parentFile, [child]);
  assert.equal(events.filter(message => message.role === 'subagent' && message.event === 'started').length, 1);
  assert.equal(events[0].subagent.file, child.file);
});

test('renders DeepSeek Harness agent messages once and links the sender session', () => {
  const relay = {
    id: 'relay-1', role: 'user',
    source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-id' },
    content: [
      { type: 'text', text: 'Agent child-id sent a message:' },
      { type: 'text', text: 'net module done' },
    ],
  };
  const rows = [
    { type: 'session', id: 'parent', cwd: '/tmp/project' },
    { type: 'user/message', time: 1785515762000, data: { content: [{ type: 'text', text: 'delegate' }], source: { kind: 'user' } } },
    { type: 'agent/inbox/spliced', time: 1785515763000, data: { target: 'next-step', start: 0, inserted: [relay] } },
    { type: 'user/message', time: 1785515763500, data: relay },
    { type: 'assistant/message', time: 1785515764000, data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeDsh('/tmp/parent/session.jsonl.zstd', { size: content.length }, content);
  const detail = detailDsh('/tmp/parent/session.jsonl.zstd', content);

  assert.equal(summary.turns, 2);
  assert.deepEqual(detail.map(message => message.role), ['user', 'agent_message', 'assistant']);
  assert.equal(detail[1].agentId, 'child-id');
  assert.equal(detail[1].messageId, 'relay-1');
  assert.equal(detail[1].text, 'net module done');

  const child = { source: 'dsh', id: 'child-id', file: '/tmp/child/session.jsonl.zstd',
    project: '/tmp', title: 'Net module', sessionKind: 'subagent' };
  const linked = attachSubagentEvents(detail, '/tmp/parent/session.jsonl.zstd', [child]);
  assert.equal(linked[1].subagent.file, child.file);
});

test('renders DeepSeek Harness compaction summaries and context peaks', () => {
  const rows = [
    { type: 'session', id: 'session-compact', createdAt: 1785515761000, cwd: '/tmp/project' },
    { type: 'user/message', time: 1785515762000, data: { content: [{ type: 'text', text: 'work' }] } },
    { type: 'assistant/message', time: 1785515763000, data: {
      message: { source: { model: 'deepseek-v4-flash' }, content: [{ type: 'text', text: 'before' }] },
      usage: { inputTokens: 1000, cacheReadTokens: 999000, outputTokens: 10 },
    } },
    { type: 'compact/start', time: 1785515764000, data: { turn: 1 } },
    { type: 'compact/summary', time: 1785515765500, data: {
      summary: [{ type: 'text', text: '## Checkpoint\n\nContinue from here.' }],
      shadowedTokenCount: 900000, shadowedRange: { start: 1, end: 20 }, model: 'deepseek-v4-flash',
    } },
    { type: 'user/message', time: 1785515765750, data: { content: [
      { type: 'text', text: 'This is an automatically generated checkpoint condensing an earlier span.' },
      { type: 'text', text: '<compacted-summary>\n## Checkpoint\n\nContinue from here.\n</compacted-summary>' },
    ] } },
    { type: 'compact/end', time: 1785515766000, data: { turn: 1 } },
    { type: 'assistant/message', time: 1785515767000, data: {
      message: { source: { model: 'deepseek-v4-flash' }, content: [{ type: 'text', text: 'after' }] },
      usage: { inputTokens: 1000, cacheReadTokens: 380000, outputTokens: 10 },
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeDsh('/tmp/session.jsonl.zstd', { size: content.length }, content);
  const detail = detailDsh('/tmp/session.jsonl.zstd', content);

  assert.deepEqual(summary.contextPeaks, [1000000]);
  assert.equal(summary.contextTokens, 381000);
  assert.equal(summary.turns, 3);
  assert.deepEqual(detail.map(message => message.role), ['user', 'assistant', 'compaction', 'assistant']);
  assert.equal(detail[2].beforeTokens, 1000000);
  assert.equal(detail[2].durationMs, 2000);
  assert.equal(detail[2].summary, '## Checkpoint\n\nContinue from here.');
  assert.equal(detail[2].shadowedTokens, 900000);
});

test('renders DeepSeek Harness background task completions as task events', () => {
  const rows = [
    { type: 'user/message', time: 1785515762000, data: {
      content: [{ type: 'text', text:
        'background task bash-7 (bash: npm test) finished [status: completed, exit code: 0]. Read its output with task_output.' }],
      source: { kind: 'plugin', plugin: 'tool-tasks' }, role: 'user',
    } },
    { type: 'user/message', time: 1785515763000, data: {
      content: [{ type: 'text', text:
        'background task bash-8 (bash: ordinary user text) finished [status: completed, exit code: 0].' }],
      role: 'user',
    } },
  ];

  const detail = detailDsh('/tmp/session.jsonl.zstd', rows.map(JSON.stringify).join('\n'));

  assert.equal(detail[0].role, 'background_task');
  assert.equal(detail[0].event, 'completed');
  assert.equal(detail[0].taskId, 'bash-7');
  assert.equal(detail[0].toolName, 'bash');
  assert.equal(detail[0].command, 'npm test');
  assert.equal(detail[0].exitCode, 0);
  assert.equal(detail[1].role, 'user');
});

test('renders DeepSeek Harness background job completions as task events', () => {
  const multiLine = ['background job bash-22 (bash: cd /tmp/project &&',
    'npm run build) finished [status: completed, exit code: 0]. Read its output with job_output.'].join('\n');
  const rows = [
    { type: 'user/message', time: 1785515762000, data: {
      content: [{ type: 'text', text:
        'background job bash-20 (bash: npm test) finished [status: completed, exit code: 0]. Read its output with job_output.' }],
      source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice',
        summary: 'bash npm test [status: completed, exit code: 0]' }, role: 'user',
    } },
    { type: 'user/message', time: 1785515763000, data: {
      content: [{ type: 'text', text:
        'background job bash-21 (bash: echo "(a") finished [status: failed, exit code: 2]. Read its output with job_output.' }],
      source: { kind: 'plugin', plugin: 'tool-jobs' }, role: 'user',
    } },
    { type: 'user/message', time: 1785515764000, data: {
      content: [{ type: 'text', text: multiLine }],
      source: { kind: 'plugin', plugin: 'tool-jobs' }, role: 'user',
    } },
    { type: 'user/message', time: 1785515765000, data: {
      content: [{ type: 'text', text:
        'background job bash-23\n[notice truncated]\nDone; job_output.' }],
      source: { kind: 'plugin', plugin: 'tool-jobs' }, role: 'user',
    } },
  ];

  const detail = detailDsh('/tmp/session.jsonl.zstd', rows.map(JSON.stringify).join('\n'));

  assert.deepEqual(detail.map(message => message.role), Array(4).fill('background_task'));
  assert.deepEqual(detail.map(message => message.event), ['completed', 'failed', 'completed', 'completed']);
  assert.deepEqual(detail.map(message => message.taskId), ['bash-20', 'bash-21', 'bash-22', 'bash-23']);
  assert.equal(detail[0].toolName, 'bash');
  assert.equal(detail[0].command, 'npm test');
  assert.equal(detail[0].exitCode, 0);
  assert.equal(detail[1].exitCode, 2);
  assert.equal(detail[2].command, 'cd /tmp/project &&\nnpm run build');
  assert.equal(detail[2].exitCode, 0);
  assert.equal(detail[3].command, null);
  assert.equal(detail[3].text, 'background job bash-23\n[notice truncated]\nDone; job_output.');
});

test('renders DeepSeek Harness goal updates as events and excludes them from user turns', () => {
  const goal = {
    id: 'goal-example', revision: 2, objective: 'Ship the example', phase: 'blocked', maxGoalRounds: 8,
    blockedReason: { code: 'example-error', message: 'Example dependency unavailable' },
  };
  const rows = [
    { type: 'session', id: 'session-goal', createdAt: 1785515761000, cwd: '/tmp/project' },
    { type: 'user/message', time: 1785515762000, data: {
      content: [{ type: 'text', text: '<goal_state>{"example":true}</goal_state>' }],
      source: { kind: 'goal', goalId: goal.id, revision: 2, round: 0,
        change: { kind: 'goal/change', operation: 'block', goal } },
    } },
    { type: 'user/message', time: 1785515763000, data: {
      content: [{ type: 'text', text: '<goal_round>\nObjective: "Ship the example"\nRound: 3/8\n</goal_round>' }],
      source: { kind: 'goal', goalId: goal.id, revision: 2, round: 3 },
    } },
    { type: 'user/message', time: 1785515763500, data: {
      content: [{ type: 'text', text: 'Runtime policy snapshot with revised wording.' }],
      source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
    } },
    { type: 'user/message', time: 1785515764000,
      data: { content: [{ type: 'text', text: 'continue the work' }] } },
    { type: 'assistant/message', time: 1785515765000, data: {
      message: { source: { model: 'deepseek-v4-flash' }, content: [{ type: 'text', text: 'working' }] },
      usage: { inputTokens: 10, outputTokens: 2 },
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const detail = detailDsh('/tmp/session.jsonl.zstd', content);
  const summary = summarizeDsh('/tmp/session.jsonl.zstd', { size: content.length }, content);

  assert.deepEqual(detail.map(message => message.role), ['goal', 'goal', 'runtime_context', 'user', 'assistant']);
  assert.equal(detail[0].event, 'block');
  assert.equal(detail[0].objective, 'Ship the example');
  assert.equal(detail[0].reason, 'Example dependency unavailable');
  assert.equal(detail[1].event, 'round');
  assert.equal(detail[1].round, 3);
  assert.equal(detail[1].maxRounds, 8);
  assert.equal(detail[2].text, 'Runtime policy snapshot with revised wording.');
  assert.equal(summary.turns, 2);
  assert.equal(summary.title, 'continue the work');
});

test('renders DeepSeek Harness policy, todo, and subagent messages as semantic events', () => {
  const rows = [
    { type: 'user/message', time: 1785515761000, data: {
      content: [{ type: 'text', text: 'The approval policy changed from "ask" to "never" (changed by the user).' }],
      source: { kind: 'plugin', plugin: 'user-approval' }, role: 'user',
    } },
    { type: 'tool/call', time: 1785515762000, data: { callId: 'call-todo', name: 'todo_write',
      arguments: JSON.stringify({ todos: [{ content: 'Inspect parser', status: 'completed' },
        { content: 'Fix renderer', status: 'in_progress' }] }) } },
    { type: 'tool/result', time: 1785515762100, data: { message: {
      source: { kind: 'tool', callId: 'call-todo' }, content: [{ type: 'tool-result', content: [
        { type: 'text', text: 'Updated todo list' },
      ] }],
    } } },
    { type: 'tool/call', time: 1785515763000, data: { callId: 'call-agent', name: 'subagent',
      arguments: JSON.stringify({ description: 'Review parser', run_in_background: true }) } },
    { type: 'tool/result', time: 1785515763100, data: { message: {
      source: { kind: 'tool', callId: 'call-agent' }, content: [{ type: 'tool-result', content: [
        { type: 'text', text: 'started subagent agent-1' },
      ] }],
    } } },
    { type: 'agent/inbox/spliced', time: 1785515764000, data: { inserted: [{
      content: [{ type: 'text', text: 'Background subagent agent-1 reported:' }, { type: 'text', text: 'Done.' }],
      source: { kind: 'subagent-report', senderSessionId: 'agent-1' }, role: 'user',
    }] } },
    { type: 'user/message', time: 1785515764100, data: {
      content: [{ type: 'text', text: 'Background subagent agent-1 finished and will do no further work unless you send it more.\nIts closing message:\nDone.' }],
      source: { kind: 'subagent-settled', senderSessionId: 'agent-1' }, role: 'user',
    } },
  ];

  const detail = detailDsh('/tmp/session.jsonl.zstd', rows.map(JSON.stringify).join('\n'));
  assert.deepEqual(detail.map(message => [message.role, message.event || null]), [
    ['runtime_context', null], ['todo', null], ['subagent', 'started'], ['subagent', 'completed'],
  ]);
  assert.equal(detail[1].todos[1].status, 'in_progress');
  assert.equal(detail[2].title, 'Review parser');
  assert.equal(detail[3].agentId, 'agent-1');
  assert.equal(detail[3].title, 'Subagent');
  assert.equal(detail[3].text, 'Done.');
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

test('reads conversations from newer Codex response items', () => {
  const rows = [
    { type: 'session_meta', timestamp: '2026-09-05T00:00:00Z',
      payload: { id: 'codex-new', cwd: '/tmp/new-project' } },
    { type: 'response_item', timestamp: '2026-09-05T00:00:01Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>ignored</environment_context>' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['environments.environment_context'] },
    } },
    { type: 'response_item', timestamp: '2026-09-05T00:00:02Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fix the local session list' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
    } },
    { type: 'response_item', timestamp: '2026-09-05T00:00:03Z', payload: {
      type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Working on it.' }],
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeCodex('/tmp/new-session.jsonl', { size: content.length }, content);
  const detail = detailCodex('/tmp/new-session.jsonl', content);

  assert.equal(summary.id, 'codex-new');
  assert.equal(summary.title, 'Fix the local session list');
  assert.equal(summary.lastMessage, 'Working on it.');
  assert.equal(summary.turns, 2);
  assert.deepEqual(detail.map(message => [message.role, message.text]), [
    ['user', 'Fix the local session list'],
    ['assistant', 'Working on it.'],
  ]);
});

test('does not duplicate legacy Codex conversation events with response items', () => {
  const rows = [
    { type: 'session_meta', payload: { id: 'codex-legacy', cwd: '/tmp/project' } },
    { type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ type: 'input_text', text: 'duplicate user text' }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'canonical user text' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text: 'duplicate assistant text' }] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'canonical assistant text' } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeCodex('/tmp/legacy-session.jsonl', { size: content.length }, content);
  const detail = detailCodex('/tmp/legacy-session.jsonl', content);

  assert.equal(summary.title, 'canonical user text');
  assert.equal(summary.turns, 2);
  assert.deepEqual(detail.map(message => message.text), ['canonical user text', 'canonical assistant text']);
});

test('does not render generated Codex compaction summaries as assistant messages', () => {
  const prompt = 'Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:';
  const rows = [
    { type: 'session_meta', payload: { id: 'codex-new-compaction', cwd: '/tmp/project' } },
    { type: 'response_item', timestamp: '2026-09-06T04:00:00Z', payload: {
      type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue the work' }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] },
    } },
    { type: 'response_item', timestamp: '2026-09-06T04:01:00Z', payload: {
      type: 'message', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: '## Checkpoint\n\nWork completed so far.\n' }],
    } },
    { type: 'token_usage_record', timestamp: '2026-09-06T04:01:00Z', payload: {} },
    { type: 'event_msg', timestamp: '2026-09-06T04:01:00Z', payload: {
      type: 'token_count', info: { last_token_usage: { total_tokens: 1000 } },
    } },
    { type: 'compacted', timestamp: '2026-09-06T04:01:00Z', payload: {
      message: prompt + '\n## Checkpoint\n\nWork completed so far.\n',
    } },
    { type: 'response_item', timestamp: '2026-09-06T04:02:00Z', payload: {
      type: 'message', role: 'assistant', phase: 'commentary',
      content: [{ type: 'output_text', text: 'Continuing after compaction.' }],
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeCodex('/tmp/session.jsonl', { size: content.length }, content);
  const detail = detailCodex('/tmp/session.jsonl', content);

  assert.equal(summary.turns, 2);
  assert.equal(summary.lastMessage, 'Continuing after compaction.');
  assert.deepEqual(detail.map(message => message.role), ['user', 'compaction', 'assistant']);
  assert.equal(detail[1].summary, prompt + '\n## Checkpoint\n\nWork completed so far.');
});

test('recognizes Codex auto-review as a guardian subagent', () => {
  const rows = [
    { type: 'session_meta', timestamp: '2026-08-01T00:00:00Z', payload: {
      session_id: 'parent-1', id: 'review-1', parent_thread_id: 'parent-1',
      cwd: '/tmp/project', thread_source: 'subagent', source: { subagent: { other: 'guardian' } },
    } },
    { type: 'turn_context', payload: { model: 'codex-auto-review', effort: 'low' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Review this action' } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const review = summarizeCodex('/tmp/review.jsonl', { size: content.length }, content);
  const parent = { source: 'codex', id: 'parent-1', file: '/tmp/parent.jsonl' };

  linkCodexSubagents([parent, review]);

  assert.equal(review.id, 'review-1');
  assert.equal(review.title, 'Codex auto-review');
  assert.equal(review.sessionKind, 'subagent');
  assert.equal(review.subagentType, 'guardian');
  assert.equal(review.parentSessionId, 'parent-1');
  assert.equal(review.parentFile, '/tmp/parent.jsonl');
});

test('prices Codex auto-review usage using its recorded underlying model', () => {
  const responseId = 'resp_' + Buffer.from(
    'litellm:custom_llm_provider:openai;model_id:azure-gpt-5.4-mini;response_id:example',
  ).toString('base64');
  const rows = [
    { type: 'session_meta', payload: { id: 'review-1', parent_thread_id: 'parent-1', cwd: '/tmp/project' } },
    { type: 'turn_context', payload: { model: 'codex-auto-review', effort: 'low' } },
    { type: 'event_msg', timestamp: '2026-09-06T00:00:00Z', payload: {
      type: 'token_count', info: { last_token_usage: {
        input_tokens: 900, cached_input_tokens: 0, output_tokens: 100, total_tokens: 1000,
      } },
    } },
    { type: 'token_usage_record', payload: { response_id: responseId } },
    { type: 'event_msg', timestamp: '2026-09-06T00:00:00Z', payload: {
      type: 'token_count', info: { last_token_usage: {
        input_tokens: 1000, cached_input_tokens: 100, output_tokens: 100, total_tokens: 1100,
      } },
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeCodex('/tmp/review.jsonl', { size: content.length }, content);

  assert.equal(summary.model, 'codex-auto-review');
  assert.equal(summary.cost.complete, true);
  assert.deepEqual(summary.cost.unknownModels, []);
  assert.ok(summary.cost.usd > 0);
  assert.equal(summary.usage.requests, 1);
});

test('summarizes newer Codex thread_spawn subagents without plaintext messages', () => {
  const rows = [
    { type: 'session_meta', timestamp: '2026-09-03T00:00:00Z', payload: {
      id: 'child-1', parent_thread_id: 'parent-1', cwd: '/tmp/project',
      thread_source: 'subagent', source: { subagent: { thread_spawn: {
        parent_thread_id: 'parent-1', agent_path: '/root/test_x64', agent_nickname: 'Euler',
      } } },
    } },
    { type: 'session_meta', timestamp: '2026-09-03T00:00:00Z', payload: {
      id: 'parent-1', cwd: '/tmp/project',
    } },
    { type: 'event_msg', timestamp: '2026-09-03T00:00:00Z', payload: {
      type: 'user_message', message: 'copied parent history',
    } },
    { type: 'event_msg', timestamp: '2026-09-03T00:00:01Z', payload: { type: 'task_started' } },
    { type: 'inter_agent_communication', timestamp: '2026-09-03T00:00:02Z', payload: {
      author: '/root', recipient: '/root/test_x64', encrypted_content: 'opaque',
    } },
    { type: 'event_msg', timestamp: '2026-09-03T00:00:03Z', payload: { type: 'task_complete' } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const child = summarizeCodex('/tmp/child.jsonl', { size: content.length }, content);

  assert.equal(child.sessionKind, 'subagent');
  assert.equal(child.parentSessionId, 'parent-1');
  assert.equal(child.title, 'test_x64');
  assert.equal(child.subagentType, 'Euler');
  assert.equal(child.turns, 0);
});

test('normalizes provider and dated model aliases', () => {
  assert.equal(normalizeModelName('openai/gpt-5.6-sol'), 'gpt-5.6-sol');
  assert.equal(normalizeModelName('azure-gpt-5.4-2026-03-05'), 'gpt-5.4');
  assert.equal(priceForModel('anthropic/claude-opus-4-8').input, 5);
});

test('uses the published GLM 5.3 token prices', () => {
  const price = priceForModel('glm-5.3');
  assert.equal(price.name, 'GLM 5.3');
  assert.deepEqual([price.input, price.cached, price.output], [1.4, .26, 4.4]);
});

test('uses the published GPT-6 Astra standard and long-context prices', () => {
  const price = priceForModel('openai/gpt-6-astra');
  assert.deepEqual(
    [price.name, price.input, price.cached, price.cacheWrite5m, price.output, price.long, price.longCacheWrite5m],
    ['GPT-6 Astra', 10, 1, 12.5, 50, [20, 2, 75], 25],
  );

  const shortUsage = normalizedUsage({
    input_tokens: 100_000, cached_input_tokens: 10_000,
    cache_write_tokens: 100_000, output_tokens: 100_000,
  }, 'codex');
  const short = summarizeUsageRecords([{ model: 'gpt-6-astra', usage: shortUsage }]);
  assert.equal(short.cost.usd, 7.16);

  const longUsage = normalizedUsage({
    input_tokens: 300_000, cache_write_tokens: 100_000, output_tokens: 1_000_000,
  }, 'codex');
  const long = summarizeUsageRecords([{ model: 'gpt-6-astra', usage: longUsage }]);
  assert.equal(long.cost.usd, 83.5);
});

test('uses the reduced cache-read price for Claude Fable 5.1', () => {
  const price = priceForModel('anthropic/claude-fable-5-1');
  assert.deepEqual(
    [price.name, price.input, price.cached, price.cacheWrite5m, price.cacheWrite1h, price.output],
    ['Claude Fable/Mythos 5.1', 10, .25, 12.5, 20, 50],
  );
  assert.equal(priceForModel('claude-fable-5').cached, 1);

  const usage = normalizedUsage({
    input_tokens: 100_000, cache_read_input_tokens: 10_000,
    cache_creation: { ephemeral_5m_input_tokens: 20_000, ephemeral_1h_input_tokens: 10_000 },
    output_tokens: 100_000,
  }, 'claude');
  const total = summarizeUsageRecords([{ model: 'claude-fable-5.1', usage }]);
  assert.equal(total.cost.usd, 6.4525);
});

test('uses DeepSeek peak and off-peak prices after the scheduled change', () => {
  const before = priceForModel('deepseek-v4-pro', {}, new Date('2026-08-16T15:59:59Z'));
  assert.deepEqual([before.cached, before.input, before.output], [.003625, .435, .87]);

  const flashPeak = priceForModel('deepseek-v4-flash', {}, new Date('2026-08-17T02:00:00Z'));
  assert.deepEqual([flashPeak.cached, flashPeak.input, flashPeak.output], [.014, .44, 1.32]);
  const flashOffPeak = priceForModel('deepseek-chat', {}, new Date('2026-08-17T05:00:00Z'));
  assert.deepEqual([flashOffPeak.cached, flashOffPeak.input, flashOffPeak.output], [.007, .22, .66]);

  const proPeak = priceForModel('deepseek-v4-pro', {}, new Date('2026-08-17T08:00:00Z'));
  assert.deepEqual([proPeak.cached, proPeak.input, proPeak.output], [.044, 1.32, 3.96]);
  const proOffPeak = priceForModel('deepseek-v4-pro', {}, new Date('2026-08-17T12:00:00Z'));
  assert.deepEqual([proOffPeak.cached, proOffPeak.input, proOffPeak.output], [.022, .66, 1.98]);
});

test('prices DeepSeek V4.1 Flash with the Flash series rates', () => {
  const offPeak = priceForModel('deepseek-v4.1-flash-expires-on-0910', {}, new Date('2026-09-09T05:00:00Z'));
  assert.deepEqual(
    [offPeak.name, offPeak.cached, offPeak.input, offPeak.output],
    ['DeepSeek V4.1 Flash', .007, .22, .66],
  );

  const peak = priceForModel('deepseek-v4.1-flash-expires-on-0910', {}, new Date('2026-09-09T02:00:00Z'));
  assert.deepEqual([peak.cached, peak.input, peak.output], [.014, .44, 1.32]);

  const usage = normalizedUsage({
    input_tokens: 1_000_000, cached_input_tokens: 1_000_000, output_tokens: 1_000_000,
  }, 'dsh');
  const total = summarizeUsageRecords([{
    model: 'deepseek-v4.1-flash-expires-on-0910', usage, ts: '2026-09-09T05:00:00Z',
  }]);
  assert.equal(total.cost.complete, true);
  assert.deepEqual(total.cost.unknownModels, []);
  assert.equal(total.cost.usd, .887);
});

test('reduces DeepSeek Flash prices from 2026-09-10 12:00 Beijing time', () => {
  const offPeakBefore = priceForModel('deepseek-v4-flash', {}, new Date('2026-09-09T05:00:00Z'));
  assert.deepEqual([offPeakBefore.cached, offPeakBefore.input, offPeakBefore.output], [.007, .22, .66]);
  const offPeakAfter = priceForModel('deepseek-v4-flash', {}, new Date('2026-09-10T05:00:00Z'));
  assert.deepEqual([offPeakAfter.cached, offPeakAfter.input, offPeakAfter.output], [.0028, .14, .56]);

  const peakBefore = priceForModel('deepseek-v4.1-flash-expires-on-0910', {}, new Date('2026-09-10T02:00:00Z'));
  assert.deepEqual([peakBefore.cached, peakBefore.input, peakBefore.output], [.014, .44, 1.32]);
  const peakAfter = priceForModel('deepseek-v4.1-flash-expires-on-0910', {}, new Date('2026-09-11T02:00:00Z'));
  assert.deepEqual([peakAfter.cached, peakAfter.input, peakAfter.output], [.0056, .28, 1.12]);

  const pro = priceForModel('deepseek-v4-pro', {}, new Date('2026-09-11T02:00:00Z'));
  assert.deepEqual([pro.cached, pro.input, pro.output], [.044, 1.32, 3.96]);
});

test('uses off-peak DeepSeek rates on weekends', () => {
  const saturday = priceForModel('deepseek-v4-pro', {}, new Date('2026-09-12T02:00:00Z'));
  assert.deepEqual([saturday.cached, saturday.input, saturday.output], [.022, .66, 1.98]);
});

test('normalizes thinking effort from runtime-specific configurations', () => {
  assert.equal(extractThinkingEffort({ thinkingLevel: 'low' }), 'low');
  assert.equal(extractThinkingEffort('{"reasoning_config":{"effort":"high"}}'), 'high');
  assert.equal(extractThinkingEffort({ reasoningEffort: 'max' }), 'max');
  assert.equal(extractThinkingEffort({ reasoning_config: null }), null);
});

test('uses long-context prices above 272K input tokens', () => {
  const usage = normalizedUsage({ input_tokens: 300_000, output_tokens: 1_000 }, 'codex');
  const result = summarizeUsageRecords([{ model: 'gpt-5.4', usage }]);

  assert.equal(result.cost.usd, 1.5225);
});

test('uses the current GPT-5.6 Luna prices, including cache writes', () => {
  const shortUsage = normalizedUsage({ input_tokens: 100_000, cached_input_tokens: 10_000, output_tokens: 100_000 }, 'codex');
  const short = summarizeUsageRecords([{ model: 'gpt-5.6-luna', usage: shortUsage }]);
  assert.equal(short.cost.usd, .1382);

  const longUsage = normalizedUsage({ input_tokens: 300_000, output_tokens: 1_000_000, cache_write_tokens: 100_000 }, 'codex');
  const long = summarizeUsageRecords([{ model: 'gpt-5.6-luna', usage: longUsage }]);
  assert.equal(long.cost.usd, 1.97);
});

test('prices GPT-5.6 Terra and Luna: old rates before the 2026-07-30 reduction, current rates after', () => {
  const terraBefore = priceForModel('gpt-5.6-terra', {}, new Date('2026-07-29T23:59:59Z'));
  assert.deepEqual([terraBefore.input, terraBefore.cached, terraBefore.output, terraBefore.long], [2.5, .25, 15, [5, .5, 22.5]]);
  const terraAfter = priceForModel('gpt-5.6-terra', {}, new Date('2026-07-30T00:00:00Z'));
  assert.deepEqual([terraAfter.input, terraAfter.cached, terraAfter.cacheWrite5m, terraAfter.output, terraAfter.long], [2, .2, 2.5, 12, [4, .4, 18]]);

  const lunaBefore = priceForModel('gpt-5.6-luna', {}, new Date('2026-07-29T23:59:59Z'));
  assert.deepEqual([lunaBefore.input, lunaBefore.cached, lunaBefore.output, lunaBefore.long], [1, .1, 6, [2, .2, 9]]);
  const lunaAfter = priceForModel('gpt-5.6-luna', {}, new Date('2026-07-30T00:00:00Z'));
  assert.deepEqual([lunaAfter.input, lunaAfter.cached, lunaAfter.cacheWrite5m, lunaAfter.output, lunaAfter.long], [.2, .02, .25, 1.2, [.4, .04, 1.8]]);

  const usage = normalizedUsage({ input_tokens: 300_000, output_tokens: 1_000_000, cache_write_tokens: 100_000 }, 'codex');
  const oldTerra = summarizeUsageRecords([{ model: 'gpt-5.6-terra', usage, ts: '2026-07-29T12:00:00Z' }]);
  assert.equal(oldTerra.cost.usd, 24.5);
  const newTerra = summarizeUsageRecords([{ model: 'gpt-5.6-terra', usage, ts: '2026-07-30T12:00:00Z' }]);
  assert.equal(newTerra.cost.usd, 19.7);
  const oldLuna = summarizeUsageRecords([{ model: 'gpt-5.6-luna', usage, ts: '2026-07-29T12:00:00Z' }]);
  assert.equal(oldLuna.cost.usd, 9.8);
});

test('prices GPT-5.6 Sol: old rates before the 2026-08-21 promotion, promotional rates after', () => {
  const before = priceForModel('gpt-5.6-sol', {}, new Date('2026-08-20T23:59:59Z'));
  assert.deepEqual([before.input, before.cached, before.output, before.long], [5, .5, 30, [10, 1, 45]]);
  assert.equal(before.cacheWrite5m, undefined);
  const after = priceForModel('gpt-5.6-sol', {}, new Date('2026-08-21T00:00:00Z'));
  assert.equal(after.input, 4);
  assert.equal(after.output, 20);

  // 8-21 之前的会话按原价计费
  const oldUsage = normalizedUsage({ input_tokens: 300_000, output_tokens: 1_000_000, cache_write_tokens: 100_000 }, 'codex');
  const old = summarizeUsageRecords([{ model: 'gpt-5.6-sol', usage: oldUsage, ts: '2026-08-20T12:00:00Z' }]);
  assert.equal(old.cost.usd, 49);

  // 当前推广价：Codex 用量按未缓存/缓存/输出分开计费
  const usage = normalizedUsage({
    input_tokens: 19_000,
    cached_input_tokens: 9_984,
    output_tokens: 314,
    total_tokens: 19_314,
  }, 'codex');
  assert.equal(usage.inputTokens, 9_016);
  assert.equal(usage.cachedInputTokens, 9_984);
  const result = summarizeUsageRecords([{ model: 'gpt-5.6-sol', usage }]);
  assert.equal(result.cost.usd, 0.0463376);
  assert.equal(result.cost.complete, true);

  const shortUsage = normalizedUsage({ input_tokens: 100_000, cached_input_tokens: 10_000, output_tokens: 100_000 }, 'codex');
  const short = summarizeUsageRecords([{ model: 'gpt-5.6-sol', usage: shortUsage }]);
  assert.equal(short.cost.usd, 2.364);

  const longUsage = normalizedUsage({ input_tokens: 300_000, output_tokens: 1_000_000, cache_write_tokens: 100_000 }, 'codex');
  const long = summarizeUsageRecords([{ model: 'gpt-5.6-sol', usage: longUsage }]);
  assert.equal(long.cost.usd, 33.4);
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

test('uses the latest Claude Code custom title after rename', () => {
  const rows = [
    { type: 'user', message: { content: 'original prompt' } },
    { type: 'summary', summary: 'Generated summary' },
    { type: 'custom-title', customTitle: 'First rename' },
    { type: 'custom-title', customTitle: '  Latest renamed session  ' },
  ];
  const summary = summarizeClaude('/tmp/session.jsonl', { size: 1 },
    rows.map(JSON.stringify).join('\n'));

  assert.equal(summary.title, 'Latest renamed session');
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
  assert.equal(daily[0].tokenUsage, 2_000_000);
  assert.ok(daily[0].date <= daily[1].date);
});

test('daily token usage includes input and output but excludes cache tokens', () => {
  const { summarizeDailyRecords } = require('../server');
  const usage = normalizedUsage({
    input_tokens: 1_100,
    cached_input_tokens: 900,
    output_tokens: 50,
  }, 'codex');
  const [daily] = summarizeDailyRecords([
    { model: 'gpt-5.5', usage, ts: '2026-07-21T08:00:00+08:00' },
  ]);

  assert.equal(daily.tokenUsage, 250);
  assert.equal(daily.totalTokens, 1_150);
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

test('parses Cetus sessions with the compatible event format', () => {
  const file = path.join(os.homedir(), 'Library', 'Application Support', 'dev.cetus.app', 'sessions', 'session.jsonl');
  const rows = [
    { type: 'session', id: 'cetus-1', timestamp: '2026-08-01T00:00:00Z', cwd: '/tmp/cetus-project' },
    { type: 'model_change', timestamp: '2026-08-01T00:00:01Z', provider: 'openai', modelId: 'gpt-5.4' },
    { type: 'message', timestamp: '2026-08-01T00:00:02Z', message: { role: 'user', content: 'ship it' } },
    { type: 'message', timestamp: '2026-08-01T00:00:03Z', message: {
      role: 'assistant', model: 'gpt-5.4', content: [{ type: 'text', text: 'done' }],
      usage: { input: 10, output: 2, cacheRead: 3, totalTokens: 15 },
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeCetus(file, { size: content.length }, content);

  assert.equal(summary.source, 'cetus');
  assert.equal(summary.id, 'cetus-1');
  assert.equal(summary.project, '/tmp/cetus-project');
  assert.equal(summary.version, 'Cetus');
  assert.equal(summary.usage.totalTokens, 15);
  assert.deepEqual(detailCetus(file, content).map(message => message.role), ['user', 'assistant']);
});

test('preserves Cetus multi-edit arguments for diff rendering', () => {
  const row = {
    type: 'message', timestamp: '2026-08-01T00:00:00Z', message: { role: 'assistant', content: [{
      type: 'toolCall', id: 'edit-1', name: 'edit', arguments: {
        path: '/tmp/example.js', edits: [
          { oldText: 'const first = 1;', newText: 'const first = 2;' },
          { oldText: 'const second = 1;', newText: 'const second = 2;' },
        ],
      },
    }] },
  };
  const [message] = detailCetus('/tmp/cetus.jsonl', JSON.stringify(row));

  assert.deepEqual(message.edit, {
    path: '/tmp/example.js',
    edits: [
      { oldText: 'const first = 1;', newText: 'const first = 2;' },
      { oldText: 'const second = 1;', newText: 'const second = 2;' },
    ],
    replaceAll: false,
  });
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

test('renders Claude Code /btw sidechain messages in the main transcript', () => {
  const rows = [
    { type: 'user', isSidechain: true, timestamp: '2026-08-15T00:00:00Z',
      message: { role: 'user', content: 'What does this option do?' } },
    { type: 'assistant', isSidechain: true, timestamp: '2026-08-15T00:00:01Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'It enables the example behavior.' }] } },
    { type: 'assistant', isSidechain: true, agentId: 'example-agent',
      timestamp: '2026-08-15T00:00:02Z', message: {
        role: 'assistant', content: [{ type: 'text', text: 'Agent-internal response.' }],
      } },
  ];

  const detail = detailClaude('/tmp/example-project/main.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.deepEqual(detail, [
    { role: 'btw', speaker: 'user', text: 'What does this option do?', ts: '2026-08-15T00:00:00Z' },
    { role: 'btw', speaker: 'assistant', text: 'It enables the example behavior.', ts: '2026-08-15T00:00:01Z' },
  ]);
});

test('renders /btw messages with dedicated labels and styling', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /if \(m\.role === 'btw'\)/);
  assert.match(html, /btwQuestion: '\/btw · User'/);
  assert.match(html, /\.msg\.btw \.meta/);
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

test('renders synchronous Claude Code Agent calls with their subagent type', () => {
  const rows = [
    { type: 'assistant', timestamp: '2026-07-19T00:00:00Z', message: { content: [{
      type: 'tool_use', id: 'call-agent-1', name: 'Agent', input: {
        description: 'Map the example modules', subagent_type: 'Explore',
      },
    }] } },
    { type: 'user', timestamp: '2026-07-19T00:01:00Z', toolUseResult: {
      agentId: 'example-agent-id', agentType: 'Explore',
    }, message: { content: [{
      type: 'tool_result', tool_use_id: 'call-agent-1', content: 'Example findings',
    }] } },
  ];
  const detail = detailClaude('/tmp/example-project/main.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.deepEqual(detail.map(m => [m.role, m.event, m.agentId, m.subagentType]), [
    ['subagent', 'started', 'example-agent-id', 'Explore'],
    ['subagent', 'completed', 'example-agent-id', 'Explore'],
  ]);
  assert.equal(detail[0].title, 'Map the example modules');
});

test('remote scans retain subagents belonging to selected parent sessions', () => {
  const lines = [];
  for (let i = 0; i < 11; i++) {
    lines.push(`FILE\tclaude\t${100 - i}\t10\t/remote/project/session-${i}.jsonl`);
  }
  lines.push('FILE\tclaude\t95\t5\t/remote/project/session-2/subagents/agent-example.jsonl');

  const scan = require('../server').parseRemoteScan(lines.join('\n'));

  assert.equal(scan.files.filter(file => !file.path.includes('/subagents/')).length, 10);
  assert.ok(scan.files.some(file => file.path.endsWith('/session-2/subagents/agent-example.jsonl')));
});

test('remote scans retain independent Codex subagent logs for selected parents', () => {
  const lines = [];
  for (let i = 0; i < 11; i++) {
    lines.push(`FILE\tcodex\t${100 - i}\t10\t/remote/parent-${i}.jsonl`);
    const meta = Buffer.from(JSON.stringify({ payload: { id: `parent-${i}` } })).toString('base64');
    lines.push(`CODEX_META\t/remote/parent-${i}.jsonl\t${meta}`);
  }
  lines.push('FILE\tcodex\t1\t5\t/remote/child.jsonl');
  const childMeta = Buffer.from(JSON.stringify({ payload: {
    id: 'child-1', parent_thread_id: 'parent-2',
  } })).toString('base64');
  lines.push(`CODEX_META\t/remote/child.jsonl\t${childMeta}`);

  const scan = require('../server').parseRemoteScan(lines.join('\n'));

  assert.equal(scan.files.filter(file => !file.path.endsWith('/child.jsonl')).length, 10);
  assert.ok(scan.files.some(file => file.path.endsWith('/child.jsonl')));
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
    payload: { trigger: 'manual', tokens_before: 120000, tokens_after: 5000,
      message: '## Checkpoint\n\nContinue from here.' },
  }));
  assert.equal(codex[0].role, 'compaction');
  assert.equal(codex[0].beforeTokens, 120000);
  assert.equal(codex[0].summary, '## Checkpoint\n\nContinue from here.');

  const openClaw = detailOpenClaw('/tmp/session.jsonl', JSON.stringify({
    type: 'compaction', timestamp: '2026-07-18T00:02:00Z', fromHook: true, tokensBefore: 190000,
  }));
  assert.equal(openClaw[0].role, 'compaction');
  assert.equal(openClaw[0].trigger, 'auto');
  assert.equal(openClaw[0].beforeTokens, 190000);
});

test('renders Claude Code compaction summaries and context peaks', () => {
  const rows = [
    { type: 'user', timestamp: '2026-07-18T00:00:00Z', cwd: '/tmp/project',
      message: { role: 'user', content: 'Build a fictional example.' } },
    { type: 'assistant', timestamp: '2026-07-18T00:00:01Z', message: {
      id: 'before', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Working.' }],
      usage: { input_tokens: 160000, output_tokens: 1000 },
    } },
    { type: 'system', subtype: 'compact_boundary', timestamp: '2026-07-18T00:00:02Z',
      compactMetadata: { trigger: 'auto', preTokens: 167000 } },
    { type: 'user', isCompactSummary: true, isVisibleInTranscriptOnly: true,
      timestamp: '2026-07-18T00:00:03Z', message: {
      role: 'user', content: '## Summary\n\nContinue from the checkpoint.',
    } },
    { type: 'assistant', timestamp: '2026-07-18T00:00:04Z', message: {
      id: 'after', model: 'claude-sonnet-4-5', content: [{ type: 'text', text: 'Done.' }],
      usage: { input_tokens: 12000, output_tokens: 500 },
    } },
    { type: 'assistant', timestamp: '2026-07-18T00:00:05Z', message: {
      id: 'placeholder', model: '<synthetic>', content: [],
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeClaude('/tmp/project/session.jsonl', { size: content.length }, content);
  const detail = detailClaude('/tmp/project/session.jsonl', content);

  assert.deepEqual(summary.contextPeaks, [167000]);
  assert.equal(summary.contextTokens, 12500);
  assert.equal(detail.find(message => message.role === 'compaction').summary,
    '## Summary\n\nContinue from the checkpoint.');
  assert.equal(detail.some(message => message.role === 'user' && message.text.startsWith('## Summary')), false);
});

test('merges Codex compaction completion notifications into their compacted summaries', () => {
  const rows = [
    { type: 'session_meta', timestamp: '2026-07-18T00:00:00Z', payload: {
      id: 'session-context', cwd: '/tmp/example-project', originator: 'Codex CLI',
    } },
    { type: 'turn_context', timestamp: '2026-07-18T00:00:01Z', payload: { model: 'gpt-5.5' } },
    { type: 'event_msg', timestamp: '2026-07-18T00:00:02Z', payload: {
      type: 'user_message', message: 'Build a fictional example.',
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:01:00Z', payload: {
      type: 'token_count', info: { last_token_usage: { total_tokens: 120000 } },
    } },
    { type: 'compacted', timestamp: '2026-07-18T00:01:01Z', payload: {
      message: 'First synthetic checkpoint.',
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:01:02Z', payload: {
      type: 'token_count', info: { last_token_usage: { total_tokens: 7000 } },
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:01:03Z', payload: {
      type: 'context_compacted',
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:02:00Z', payload: {
      type: 'token_count', info: { last_token_usage: { total_tokens: 83000 } },
    } },
    { type: 'compacted', timestamp: '2026-07-18T00:02:01Z', payload: {
      message: 'Second synthetic checkpoint.',
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:03:00Z', payload: {
      type: 'token_count', info: { last_token_usage: { total_tokens: 14000 } },
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:03:00Z', payload: {
      type: 'context_compacted',
    } },
    { type: 'event_msg', timestamp: '2026-07-18T00:03:01Z', payload: {
      type: 'agent_message', message: 'Finished.',
    } },
  ];
  const content = rows.map(JSON.stringify).join('\n');
  const summary = summarizeCodex('/tmp/session.jsonl', { size: content.length }, content);
  const detail = detailCodex('/tmp/session.jsonl', content).filter(message => message.role === 'compaction');

  assert.deepEqual(summary.contextPeaks, [120000, 83000]);
  assert.equal(summary.contextTokens, 14000);
  assert.deepEqual(detail.map(message => message.beforeTokens), [120000, 83000]);
  assert.deepEqual(detail.map(message => message.afterTokens), [7000, 14000]);
  assert.deepEqual(detail.map(message => message.summary), [
    'First synthetic checkpoint.', 'Second synthetic checkpoint.',
  ]);
});

test('extracts text blocks from Codex custom tool call outputs', () => {
  const rows = [
    {
      type: 'response_item', timestamp: '2026-07-18T00:00:00Z',
      payload: { type: 'custom_tool_call', name: 'example_tool', call_id: 'call-example', input: '{}' },
    },
    {
      type: 'response_item', timestamp: '2026-07-18T00:00:01Z',
      payload: {
        type: 'custom_tool_call_output', call_id: 'call-example',
        output: [
          { type: 'input_text', text: 'First output line' },
          { type: 'output_text', text: 'Second output line' },
        ],
      },
    },
  ];
  const detail = detailCodex('/tmp/example-session.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.equal(detail[1].role, 'tool_result');
  assert.equal(detail[1].output, 'First output line\nSecond output line');
});

test('unwraps newer Codex exec wrappers into their nested tools', () => {
  const rows = [
    { type: 'response_item', timestamp: '2026-09-03T00:00:00Z', payload: {
      type: 'custom_tool_call', name: 'exec', call_id: 'shell-1',
      input: 'const r = await tools.exec_command({cmd:"git status --short",workdir:"/tmp/example"}); text(r.output);',
    } },
    { type: 'response_item', timestamp: '2026-09-03T00:00:01Z', payload: {
      type: 'custom_tool_call_output', call_id: 'shell-1', output: 'clean',
    } },
    { type: 'response_item', timestamp: '2026-09-03T00:00:02Z', payload: {
      type: 'custom_tool_call', name: 'exec', call_id: 'patch-1',
      input: 'const patch = "*** Begin Patch\\n*** Add File: /tmp/example.txt\\n+hello\\n*** End Patch"; text(await tools.apply_patch(patch));',
    } },
  ];
  const detail = detailCodex('/tmp/example-session.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.equal(detail[0].toolName, 'exec_command');
  assert.equal(detail[0].bash.command, 'git status --short');
  assert.equal(detail[1].output, 'clean');
  assert.equal(detail[2].toolName, 'apply_patch');
  assert.match(detail[2].patch.text, /Add File: \/tmp\/example\.txt/);
});

test('summarizes parallel commands inside a newer Codex exec wrapper', () => {
  const rows = [{ type: 'response_item', timestamp: '2026-09-03T00:00:00Z', payload: {
    type: 'custom_tool_call', name: 'exec', call_id: 'parallel-1',
    input: 'const rs = await Promise.all([tools.exec_command({cmd:"git status"}), tools.exec_command({cmd:"git diff"})]); text(rs.length);',
  } }];
  const [call] = detailCodex('/tmp/example-session.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.equal(call.toolName, 'exec_command ×2');
  assert.match(call.bash.command, /# 1\ngit status/);
  assert.match(call.bash.command, /# 2\ngit diff/);
});

test('keeps direct Codex agent tools recognizable', () => {
  const rows = [
    { type: 'response_item', timestamp: '2026-09-03T00:00:00Z', payload: {
      type: 'function_call', name: 'list_agents', call_id: 'agents-1', arguments: '{}',
    } },
    { type: 'response_item', timestamp: '2026-09-03T00:00:01Z', payload: {
      type: 'function_call_output', call_id: 'agents-1', output: '{"agents":[]}',
    } },
  ];
  const detail = detailCodex('/tmp/example-session.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.equal(detail[0].toolName, 'list_agents');
  assert.equal(detail[1].output, '{"agents":[]}');
});

test('renders Codex spawn_agent as a linked subagent event candidate', () => {
  const rows = [
    { type: 'response_item', timestamp: '2026-09-03T00:00:00Z', payload: {
      type: 'function_call', name: 'spawn_agent', call_id: 'spawn-1',
      arguments: '{"task_name":"test_x64","fork_turns":"all","message":"encrypted"}',
    } },
    { type: 'response_item', timestamp: '2026-09-03T00:00:01Z', payload: {
      type: 'function_call_output', call_id: 'spawn-1', output: '{"task_name":"/root/test_x64"}',
    } },
  ];
  const detail = detailCodex('/tmp/example-session.jsonl', rows.map(JSON.stringify).join('\n'));

  assert.deepEqual(detail.map(message => message.role), ['subagent']);
  assert.equal(detail[0].agentId, '/root/test_x64');
  assert.equal(detail[0].title, 'test_x64');
});

test('truncates remote history caches that were appended more than once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchcat-remote-'));
  const file = path.join(dir, 'session.jsonl');
  const prefix = '{"ordinal":0}\n{"ordinal":1}\n';
  const grown = prefix + '{"ordinal":2}\n';
  // 两次并发扫描各自把同一段后缀追加了一次
  fs.writeFileSync(file, grown + '{"ordinal":2}\n');

  assert.equal(alignRemoteCacheFile(file, Buffer.byteLength(grown)), true);
  assert.equal(fs.readFileSync(file, 'utf8'), grown);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reports incomplete remote history caches so they can be refetched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchcat-remote-'));
  const file = path.join(dir, 'session.jsonl');
  const content = '{"ordinal":0}\n';
  fs.writeFileSync(file, content);

  assert.equal(alignRemoteCacheFile(file, Buffer.byteLength(content) + 10), false);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
  fs.rmSync(dir, { recursive: true, force: true });
});
