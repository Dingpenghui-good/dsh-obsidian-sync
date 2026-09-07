#!/usr/bin/env node
/**
 * DSH Session → Obsidian Sync
 * 解压所有 zstd 会话文件，解析事件流，生成结构化 Markdown 笔记
 */

const fs = require('fs');
const path = require('path');
const { zstdDecompressSync } = require('node:zlib');

// ─── 配置 ────────────────────────────────────────────────────────────────────
const SESSION_ROOT = path.join('C:', 'Users', 'braindge', '.dsh', 'sessions', '--D-DSH-workspace--');
const KB_ROOT      = path.join('D:', 'DSH', 'workspace', 'knowledge-base');
const DAILY_DIR    = path.join(KB_ROOT, '01-Daily');
const TOPICS_DIR   = path.join(KB_ROOT, '02-Topics');
const MOI_FILE     = path.join(KB_ROOT, '00-索引-MOC.md');

// 主题关键词权重
const TAG_WEIGHTS = {
  '知识库': 3, 'obsidian': 3, 'ai': 2, 'deepseek': 2, 'dsh': 2,
  '插件': 3, '安装': 2, '兼容': 2, 'python': 2, 'node': 2,
  'cordis': 2, '自动化': 2, '同步': 2, 'npm': 2, 'github': 2,
  'language': 2, 'conversation': 2, 'session': 1, '工具': 2,
  '问题': 1, '错误': 1, '修复': 2, '调试': 1, '发布': 2,
  'zstd': 2, 'jsonl': 1, '事件流': 1, 'agent': 2, 'preset': 2
};

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== 0xFD2FB528) break;
    offset += 4;
    if (offset >= buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) break;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) break;
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum && buffer.length - offset >= 4) offset += 4;
    frames.push({ start, end: offset });
  }
  return frames;
}

function decompressAll(buffer, frames) {
  const parts = [];
  for (const frame of frames) {
    try {
      const frameBuf = buffer.subarray(frame.start, frame.end);
      const decoded = zstdDecompressSync(frameBuf);
      parts.push(decoded);
    } catch (_) { /* skip broken frame */ }
  }
  return Buffer.concat(parts);
}

function parseMessages(text) {
  const msgs = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) {
      try { msgs.push(JSON.parse(trimmed)); } catch (_) { /* skip */ }
    }
  }
  return msgs;
}

function extractText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return data.map(c => extractText(c)).join('');
  if (data.text) return data.text;
  if (data.content) return extractText(data.content);
  if (data.delta) return data.delta;
  return '';
}

function tsToDate(ts) {
  return new Date(ts).toISOString().replace('T', ' ').substring(0, 19);
}

function tsToDateString(ts) {
  return new Date(ts).toISOString().substring(0, 10);
}

function extractTags(text) {
  const tags = [];
  for (const [tag, weight] of Object.entries(TAG_WEIGHTS)) {
    if (text.includes(tag) && !tags.includes(tag)) tags.push(tag);
  }
  return tags.sort((a, b) => TAG_WEIGHTS[b] - TAG_WEIGHTS[a]);
}

// ─── 会话分析 ────────────────────────────────────────────────────────────────

function analyzeSession(messages) {
  // Session metadata
  const sessionMeta = messages.find(m => m.type === 'session');
  const sessionId = sessionMeta?.data?.id || 'unknown';
  const createdAt = sessionMeta?.data?.createdAt
    ? new Date(sessionMeta.data.createdAt).toISOString()
    : new Date().toISOString();
  const cwd = sessionMeta?.data?.cwd || '';
  const preset = sessionMeta?.data?.agentPreset || 'standard';

  // Extract turns
  const turns = [];
  let currentTurnNum = 0;
  let turnUserMsgs = [];
  let turnAssistantMsgs = [];
  let turnToolCalls = [];
  let turnToolResults = [];
  let turnErrors = [];

  function flushTurn() {
    if (currentTurnNum > 0 && (turnUserMsgs.length > 0 || turnAssistantMsgs.length > 0)) {
      turns.push({
        turn: currentTurnNum,
        userQuery: turnUserMsgs.join(' ').substring(0, 800),
        assistantResponse: turnAssistantMsgs.join(' ').substring(0, 2000),
        tools: turnToolCalls.map(c => c.name),
        toolCallCount: turnToolCalls.length,
        errors: turnErrors,
        hasError: turnErrors.length > 0,
      });
    }
    turnUserMsgs = [];
    turnAssistantMsgs = [];
    turnToolCalls = [];
    turnToolResults = [];
    turnErrors = [];
  }

  for (const msg of messages) {
    const type = msg.type || '';
    const data = msg.data || {};

    if (type === 'turn/start') {
      flushTurn();
      currentTurnNum = data.turn || (turns.length + 1);
    }

    if (type === 'user/message') {
      const text = extractText(data.content);
      if (text.trim()) turnUserMsgs.push(text.trim());
    }

    if (type === 'assistant/message') {
      const text = extractText(data.message?.content);
      if (text && text.trim()) turnAssistantMsgs.push(text.trim());
    }

    if (type === 'tool/call') {
      turnToolCalls.push({ name: data.name, args: data.arguments });
    }

    if (type === 'tool/result') {
      const text = extractText(data.message?.content);
      if (text) turnToolResults.push(text.substring(0, 500));
    }

    if (type === 'error' || (data.error && String(data.error).trim())) {
      turnErrors.push(String(data.error || data));
    }
  }
  flushTurn(); // final turn

  // Collect full conversation text for tag extraction
  const allUserText = turns.map(t => t.userQuery).join(' ');
  const allAssistantText = turns.map(t => t.assistantResponse).join(' ');
  const allContent = allUserText + ' ' + allAssistantText;
  const tags = extractTags(allContent);

  // Auto-detect topics from key actions
  const detectedTopics = [];
  if (allContent.includes('插件') || allContent.includes('plugin')) detectedTopics.push('插件');
  if (allContent.includes('知识库') || allContent.includes('obsidian')) detectedTopics.push('知识库');
  if (allContent.includes('同步') || allContent.includes('sync')) detectedTopics.push('同步');
  if (allContent.includes('npm') || allContent.includes('发布')) detectedTopics.push('npm发布');
  if (allContent.includes('cordis')) detectedTopics.push('cordis');
  if (allContent.includes('agent') || allContent.includes('preset')) detectedTopics.push('agent');
  if (allContent.includes('会话') || allContent.includes('session')) detectedTopics.push('会话管理');
  if (allContent.includes('错误') || allContent.includes('error') || turns.some(t => t.hasError)) detectedTopics.push('问题排查');

  // Generate summary
  const summaryParts = [];
  summaryParts.push(`本次 DSH 会话包含 ${turns.length} 轮对话`);
  if (turns.some(t => t.hasError)) summaryParts.push('，过程中遇到错误并解决');
  if (turns.some(t => t.toolCallCount > 0)) summaryParts.push('，使用了自动化工具辅助操作');
  summaryParts.push('。');
  if (detectedTopics.length > 0) {
    summaryParts.push(`核心主题：${detectedTopics.join('、')}。`);
  }
  const summary = summaryParts.join('');

  // Token usage
  let totalInputTokens = 0, totalOutputTokens = 0, totalCacheRead = 0;
  for (const msg of messages) {
    if (msg.type === 'assistant/message' && msg.data?.usage) {
      totalInputTokens += msg.data.usage.inputTokens || 0;
      totalOutputTokens += msg.data.usage.outputTokens || 0;
      totalCacheRead += msg.data.usage.cacheReadTokens || 0;
    }
  }

  return {
    sessionId,
    createdAt,
    cwd,
    preset,
    totalMessages: messages.length,
    totalTurns: turns.length,
    totalToolCalls: turns.reduce((s, t) => s + t.toolCallCount, 0),
    totalErrors: turns.reduce((s, t) => s + t.errors.length, 0),
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead,
    userQueries: turns.map(t => t.userQuery).filter(q => q.length > 10),
    keyTopics: tags.slice(0, 5),
    detectedTopics,
    summary,
    turns: turns.slice(0, 15), // keep top 15 turns
  };
}

// ─── Markdown 生成 ────────────────────────────────────────────────────────────

function generateNote(session) {
  const dateStr = session.createdAt.substring(0, 10);
  const monthDir = dateStr.substring(0, 7);

  const lines = [
    '---',
    'type: session-summary',
    `date: "${dateStr}"`,
    `month: "${monthDir}"`,
    `created: "${session.createdAt}"`,
    `session_id: "${session.sessionId}"`,
    `conversationCount: ${session.totalTurns}`,
    `messageCount: ${session.totalMessages}`,
    `toolCalls: ${session.totalToolCalls}`,
    `errors: ${session.totalErrors}`,
    `topics: [${session.detectedTopics.map(t => `"${t}"`).join(', ')}]`,
    `inputTokens: ${session.totalInputTokens}`,
    `outputTokens: ${session.totalOutputTokens}`,
    `cacheReadTokens: ${session.totalCacheRead}`,
    '---',
    '',
    `# 📝 DSH 会话摘要 ${dateStr}`,
    '',
    `> **会话ID**: \`${session.sessionId.substring(0, 8)}...\``,
    `> **创建时间**: ${new Date(session.createdAt).toLocaleString('zh-CN')}`,
    `> **对话轮数**: ${session.totalTurns} 轮 | **消息数**: ${session.totalMessages} 条 | **工具调用**: ${session.totalToolCalls} 次`,
    '',
    '## 会话摘要',
    '',
    session.summary,
    '',
  ];

  // Key dialogues
  if (session.userQueries.length > 0) {
    lines.push('## 关键对话');
    lines.push('');
    session.userQueries.slice(0, 8).forEach((query, idx) => {
      const qShort = query.length > 200 ? query.substring(0, 200) + '...' : query;
      lines.push(`### Q${idx + 1}: ${qShort}`);
      lines.push('');
      // Find corresponding assistant response
      const turn = session.turns[idx];
      if (turn && turn.assistantResponse) {
        const aShort = turn.assistantResponse.length > 600 ? turn.assistantResponse.substring(0, 600) + '...' : turn.assistantResponse;
        lines.push(`**A${idx + 1}**: ${aShort}`);
        lines.push('');
      }
      if (turn && turn.tools.length > 0) {
        lines.push(`🔧 **工具调用**: ${turn.tools.join(', ')}`);
        lines.push('');
      }
      if (turn && turn.errors.length > 0) {
        lines.push(`⚠️ **错误**: ${turn.errors.join('; ')}`);
        lines.push('');
      }
    });
  }

  // Stats table
  lines.push('## 统计信息');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('|------|------|');
  lines.push(`| 对话轮数 | ${session.totalTurns} |`);
  lines.push(`| 消息总数 | ${session.totalMessages} |`);
  lines.push(`| 工具调用 | ${session.totalToolCalls} |`);
  lines.push(`| 错误数量 | ${session.totalErrors} |`);
  lines.push(`| 输入 tokens | ${session.totalInputTokens.toLocaleString()} |`);
  lines.push(`| 输出 tokens | ${session.totalOutputTokens.toLocaleString()} |`);
  lines.push(`| 缓存读取 tokens | ${session.totalCacheRead.toLocaleString()} |`);
  lines.push('');

  // Topics
  lines.push('## 主题标签');
  lines.push('');
  const obsidianTags = session.detectedTopics.length > 0
    ? session.detectedTopics.map(t => `[[${t}]]`)
    : session.keyTopics.map(t => `[[${t}]]`);
  lines.push(obsidianTags.join(', '));
  lines.push('');

  lines.push('---');
  lines.push('*由 DSH 知识库系统自动生成*');

  return { content: lines.join('\n'), dateStr, monthDir };
}

// ─── 主同步逻辑 ──────────────────────────────────────────────────────────────

function syncAllSessions() {
  console.log('[*] 开始同步所有 DSH 会话到 Obsidian\n');
  console.log(`[*] 会话目录: ${SESSION_ROOT}`);
  console.log(`[*] 知识库目录: ${KB_ROOT}\n`);

  // Ensure dirs
  fs.mkdirSync(path.join(KB_ROOT, '01-Daily'), { recursive: true });
  fs.mkdirSync(path.join(KB_ROOT, '02-Topics'), { recursive: true });
  fs.mkdirSync(path.join(KB_ROOT, '_meta'), { recursive: true });

  // Read existing synced session IDs to avoid duplicates
  const existingNotes = new Set();
  const dailyDir = path.join(KB_ROOT, '01-Daily');
  if (fs.existsSync(dailyDir)) {
    for (const entry of fs.readdirSync(dailyDir, { recursive: true })) {
      const fp = path.join(dailyDir, entry);
      if (fs.statSync(fp).isFile() && entry.endsWith('.md') && entry.startsWith('2026')) {
        const content = fs.readFileSync(fp, 'utf-8');
        const m = content.match(/session_id:\s*"([^"]+)"/);
        if (m) existingNotes.add(m[1]);
      }
    }
  }
  console.log(`[*] 已同步会话: ${existingNotes.size} 个\n`);

  // Get session directories
  const sessions = fs.readdirSync(SESSION_ROOT)
    .filter(name => {
      const p = path.join(SESSION_ROOT, name);
      return fs.statSync(p).isDirectory();
    })
    .sort();

  let totalSessions = 0;
  let newSessions = 0;
  let skippedSessions = 0;
  let totalTurns = 0;
  let totalMessages = 0;
  const syncedDates = new Set();
  const sessionRecords = []; // for MOC update

  for (const sessionName of sessions) {
    const zstdFile = path.join(SESSION_ROOT, sessionName, 'session.jsonl.zstd');
    if (!fs.existsSync(zstdFile)) {
      console.log(`  ⊘ ${sessionName}: 无 session.jsonl.zstd`);
      continue;
    }

    totalSessions++;

    // Skip already synced
    if (existingNotes.has(sessionName)) {
      console.log(`  ⊘ ${sessionName}: 已同步，跳过`);
      skippedSessions++;
      continue;
    }

    console.log(`[*] 处理会话: ${sessionName}`);

    // Decompress
    const buffer = fs.readFileSync(zstdFile);
    const frames = scanFrames(buffer);
    const decoded = decompressAll(buffer, frames);
    const messages = parseMessages(decoded.toString('utf-8'));
    console.log(`  -> ${messages.length} 条消息 (${frames.length} 帧)`);

    // Analyze
    const session = analyzeSession(messages);
    totalTurns += session.totalTurns;
    totalMessages += session.totalMessages;
    syncedDates.add(session.dateStr || tsToDateString(session.createdAt));

    if (session.totalTurns === 0) {
      console.log(`  -> 无有效对话，跳过`);
      continue;
    }

    newSessions++;
    console.log(`  -> ${session.totalTurns} 轮对话，标签: ${session.detectedTopics.join(', ') || session.keyTopics.join(', ')}`);

    // Generate note
    const { content, dateStr, monthDir } = generateNote(session);
    const noteDir = path.join(DAILY_DIR, monthDir);
    fs.mkdirSync(noteDir, { recursive: true });

    const safeId = sessionName.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 12);
    const noteFile = path.join(noteDir, `${dateStr}-DSH-${safeId}.md`);
    fs.writeFileSync(noteFile, content, 'utf-8');
    console.log(`  ✓ 已生成: ${path.basename(noteFile)}`);

    sessionRecords.push({
      file: path.basename(noteFile),
      date: dateStr,
      turns: session.totalTurns,
      topics: session.detectedTopics.join(','),
      id: session.sessionId,
    });
  }

  // ── 更新 MOC ──────────────────────────────────────────────────────────────
  console.log('\n[*] 更新 MOC 索引...');
  updateMoc(sessionRecords, totalSessions, newSessions, skippedSessions, totalTurns, totalMessages, syncedDates);

  // ── 更新统计 ──────────────────────────────────────────────────────────────
  updateStats(totalSessions, newSessions, totalTurns, totalMessages, Array.from(syncedDates));

  console.log('\n[✓] 同步完成!');
  console.log(`  - 总会话数: ${totalSessions}`);
  console.log(`  - 新同步: ${newSessions}`);
  console.log(`  - 已跳过: ${skippedSessions}`);
  console.log(`  - 总对话轮数: ${totalTurns}`);
  console.log(`  - 总消息数: ${totalMessages}`);
  console.log(`  - 涉及日期: ${Array.from(syncedDates).sort().join(', ')}`);
}

function updateMoc(records, totalSessions, newSessions, skippedSessions, totalTurns, totalMessages, syncedDates) {
  const now = new Date().toLocaleString('zh-CN');
  const sortedRecords = [...records].sort((a, b) => b.date.localeCompare(a.date));

  const lines = [
    '# 知识库总索引 (MOC)',
    '',
    `> 最后整理: ${now} | 文件总数: ${13 + newSessions} | 对话数: ${totalTurns}`,
    '',
    '## 目录结构',
    '',
    '| 文件夹 | 用途 |',
    '|--------|------|',
    '| `00-Inbox` | 待整理的新内容 |',
    '| `01-Daily` | 每日对话日志 |',
    '| `02-Topics` | 主题分类笔记 |',
    '| `03-Projects` | 项目相关笔记 |',
    '| `04-Archive` | 归档内容 |',
    '| `templates` | 笔记模板 |',
    '| `_meta` | 元数据（统计、索引） |',
    '| `assets` | 图片等资源 |',
    '',
    '## 每日日志',
    '',
    '| 日期 | 文件 | 对话数 | 说明 |',
    '|------|------|--------|------|',
  ];

  // Existing daily notes (from glob, we can read them)
  const existingDailyNotes = [];
  const dailyDir = path.join(KB_ROOT, '01-Daily');
  if (fs.existsSync(dailyDir)) {
    for (const entry of fs.readdirSync(dailyDir, { recursive: true })) {
      const fp = path.join(dailyDir, entry);
      if (fs.statSync(fp).isFile() && entry.endsWith('.md') && !entry.startsWith('.')) {
        const content = fs.readFileSync(fp, 'utf-8');
        const frontmatter = content.match(/^---\n(.*?)\n---/s);
        if (frontmatter) {
          const fm = parseFrontmatter(frontmatter[1]);
          existingDailyNotes.push({ file: entry, ...fm, content });
        }
      }
    }
  }

  // Merge: new records first, then existing non-duplicate notes
  const allNotes = [
    ...sortedRecords.map(r => ({
      file: r.file,
      date: r.date,
      turns: r.turns,
      topics: r.topics,
      isNew: true,
    })),
    ...existingDailyNotes.filter(n => !sortedRecords.some(r => r.file === n.file)),
  ];

  // Sort by date desc
  allNotes.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  for (const note of allNotes) {
    const name = note.file.replace('.md', '');
    const desc = note.topics ? note.topics.replace(/,/g, '、') : (note.subject || '对话记录');
    const turns = note.turns || note.conversationCount || '?';
    lines.push(`| [[${name}|${name.replace(/^2026-09-/,'')}}]] | ${note.file} | ${turns}轮 | ${desc} |`);
  }

  // Topics section
  const allTopics = new Set();
  for (const r of sortedRecords) {
    for (const t of r.topics.split(',')) if (t.trim()) allTopics.add(t.trim());
  }
  for (const n of existingDailyNotes) {
    if (n.topics) for (const t of n.topics.split(',')) if (t.trim()) allTopics.add(t.trim());
  }
  // Also read existing topic notes
  const topicsDir = path.join(KB_ROOT, '02-Topics');
  if (fs.existsSync(topicsDir)) {
    for (const f of fs.readdirSync(topicsDir).filter(n => n.endsWith('.md') && !n.startsWith('_'))) {
      allTopics.add(f.replace('.md', ''));
    }
  }

  lines.push('');
  lines.push('## 主题笔记');
  lines.push('');
  for (const topic of [...allTopics].sort()) {
    lines.push(`- [[${topic}]]`);
  }

  const totalMocNotes = allNotes.length;
  lines.push('');
  lines.push('## 统计');
  lines.push('');
  lines.push(`- 每日日志: ${totalMocNotes} 篇`);
  lines.push(`- 主题笔记: ${allTopics.size} 个`);
  lines.push(`- DSH 会话: ${totalSessions} 个（${totalTurns}轮对话）`);
  lines.push(`- 新增同步: ${newSessions} 个会话`);
  lines.push(`- 总消息数: ${totalMessages.toLocaleString()} 条`);
  lines.push(`- 最后同步: ${now}`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('**自动同步说明：**');
  lines.push('- DSH 会话可手动执行 `node sync-all-sessions.js` 同步到 `01-Daily`');
  lines.push('- 脚本路径: `D:\\DSH\\workspace\\knowledge-base\\sync-all-sessions.js`');

  fs.writeFileSync(MOI_FILE, lines.join('\n'), 'utf-8');
  console.log(`  ✓ MOC 已更新 (${totalMocNotes} 篇日志, ${allTopics.size} 个主题)`);
}

function parseFrontmatter(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return result;
}

function updateStats(total, newCount, turns, msgs, dates) {
  const statsFile = path.join(KB_ROOT, '_meta', 'stats.json');
  let stats = [];
  if (fs.existsSync(statsFile)) {
    try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf-8')); } catch (_) { stats = []; }
  }
  stats.push({
    time: new Date().toISOString(),
    action: 'full_sync_all_sessions',
    total_sessions: total,
    new_sessions: newCount,
    skipped_sessions: total - newCount,
    total_conversations: turns,
    total_messages: msgs,
    synced_dates: dates.sort(),
    errors: 0,
  });
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), 'utf-8');
}

// ─── 运行 ────────────────────────────────────────────────────────────────────
syncAllSessions();
