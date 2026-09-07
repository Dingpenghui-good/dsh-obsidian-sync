#!/usr/bin/env node
/**
 * DSH Session Summarizer
 * 提取 DSH 会话的关键内容并生成摘要，同步到 Obsidian 知识库
 */

const fs = require('fs');
const path = require('path');
const { zstdDecompressSync } = require('node:zlib');

// 配置
const SESSION_ROOT = path.join('C:', 'Users', 'braindge', '.dsh', 'sessions', '--D-DSH-workspace--');
const KB_ROOT = path.join('D:', 'DSH', 'workspace', 'knowledge-base');

const ZSTD_MAGIC = 0xFD2FB528;

// 主题关键词权重（用于自动分类）
const TAG_WEIGHTS = {
  '知识库': 3, 'obsidian': 3, 'ai': 2, 'deepseek': 2, 'dsh': 2,
  '插件': 3, '安装': 2, '兼容': 2, 'python': 2, 'node': 2,
  'cordis': 2, '自动化': 2, '同步': 2, 'npm': 2, 'github': 2,
  'language': 2, 'conversation': 2, 'session': 1, '工具': 2,
  '问题': 1, '错误': 1, '修复': 2, '调试': 1
};

// 扫描 zstd 帧
function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
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
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

// 解压
function decompressAll(buffer, frames) {
  const allContent = [];
  for (const frame of frames) {
    try {
      const frameBuffer = buffer.subarray(frame.start, frame.end);
      const decompressed = zstdDecompressSync(frameBuffer);
      allContent.push(decompressed);
    } catch (e) { /* skip */ }
  }
  return Buffer.concat(allContent);
}

// 解析 JSONL
function parseJsonl(text) {
  const messages = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed) {
      try { messages.push(JSON.parse(trimmed)); } catch (e) { /* skip */ }
    }
  }
  return messages;
}

// 提取文本
function extractText(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return data.map(c => extractText(c)).join('');
  if (data.text) return data.text;
  if (data.content) return extractText(data.content);
  return '';
}

// 分析会话，提取关键信息
function analyzeSession(messages) {
  const sessions = messages.filter(m => m.type === 'session').map(m => m.data);
  const sessionInfo = sessions[0] || {};
  
  // 提取对话轮次
  const turns = [];
  let currentTurn = null;
  let currentStep = null;
  let userMessages = [];
  let assistantResponses = [];
  let toolCalls = [];
  let errors = [];
  let reasoning = [];
  
  for (const msg of messages) {
    const type = msg.type || '';
    const data = msg.data || {};
    
    // Turn 开始
    if (type === 'turn/start') {
      if (currentTurn && (userMessages.length > 0 || assistantResponses.length > 0)) {
        turns.push({
          userQuery: userMessages.join(' ').substring(0, 500),
          assistantResponse: assistantResponses.join(' ').substring(0, 1000),
          toolsUsed: toolCalls.length,
          hasError: errors.length > 0,
          turnIndex: turns.length + 1
        });
      }
      userMessages = [];
      assistantResponses = [];
      toolCalls = [];
      errors = [];
      currentTurn = { time: msg.time };
    }
    
    // 用户消息
    if (type === 'user/message') {
      const content = extractText(data.content);
      if (content.trim()) {
        userMessages.push(content.trim());
      }
    }
    
    // Assistant 消息
    if (type === 'assistant/message') {
      const content = extractText(data.content);
      if (content.trim()) {
        assistantResponses.push(content.trim());
      }
    }
    
    // Tool 调用
    if (type === 'tool/call') {
      toolCalls.push(data.toolName || 'unknown');
    }
    
    // 错误
    if (type === 'error' || (data.error && data.error !== '')) {
      errors.push(data.error || String(data));
    }
    
    // Reasoning
    if (type === 'reasoning-chunks') {
      const r = extractText(data.data);
      if (r.trim()) reasoning.push(r.trim());
    }
  }
  
  // 添加最后一个 turn
  if (currentTurn && (userMessages.length > 0 || assistantResponses.length > 0)) {
    turns.push({
      userQuery: userMessages.join(' ').substring(0, 500),
      assistantResponse: assistantResponses.join(' ').substring(0, 1000),
      toolsUsed: toolCalls.length,
      hasError: errors.length > 0,
      turnIndex: turns.length + 1
    });
  }
  
  // 生成会话摘要
  const allContent = messages.map(m => extractText(m.data)).join(' ');
  const tags = extractTags(allContent);
  const summary = generateSummary(turns, tags);
  
  return {
    sessionId: sessionInfo.id || 'unknown',
    createdAt: sessionInfo.createdAt ? new Date(sessionInfo.createdAt).toISOString() : new Date().toISOString(),
    cwd: sessionInfo.cwd || '',
    preset: sessionInfo.agentPreset || 'standard',
    totalMessages: messages.length,
    totalTurns: turns.length,
    totalTools: turns.reduce((sum, t) => sum + t.toolsUsed, 0),
    totalErrors: errors.length,
    userQueries: turns.map(t => t.userQuery).filter(q => q.length > 10),
    keyTopics: tags.slice(0, 5),
    summary: summary,
    turns: turns.slice(0, 10) // 只保留前10轮关键对话
  };
}

// 提取标签
function extractTags(text) {
  const tags = [];
  for (const [tag, weight] of Object.entries(TAG_WEIGHTS)) {
    if (text.includes(tag) && !tags.includes(tag)) {
      tags.push(tag);
    }
  }
  return tags.sort((a, b) => TAG_WEIGHTS[b] - TAG_WEIGHTS[a]);
}

// 生成摘要
function generateSummary(turns, tags) {
  if (turns.length === 0) return '无有效对话内容';
  
  // 分析对话模式
  const hasErrors = turns.some(t => t.hasError);
  const hasTools = turns.some(t => t.toolsUsed > 0);
  
  // 提取关键话题
  const topicList = tags.slice(0, 3).join('、');
  
  // 构建摘要
  const parts = [];
  
  parts.push(`本次 DSH 会话包含 ${turns.length} 轮对话`);
  if (hasErrors) parts.push('，过程中遇到错误并成功解决');
  if (hasTools) parts.push('，使用了自动化工具辅助操作');
  parts.push('。');
  
  if (topicList) {
    parts.push(`核心主题围绕 **${topicList}** 展开`);
  }
  
  // 添加关键行动点
  const allQueries = turns.map(t => t.userQuery).join(' ');
  const keyActions = [];
  if (allQueries.includes('插件') || allQueries.includes('安装')) {
    keyActions.push('插件安装与调试');
  }
  if (allQueries.includes('知识库') || allQueries.includes('obsidian')) {
    keyActions.push('知识库系统搭建');
  }
  if (allQueries.includes('同步') || allQueries.includes('自动化')) {
    keyActions.push('自动化同步配置');
  }
  if (allQueries.includes('发布') || allQueries.includes('npm')) {
    keyActions.push('npm 包发布');
  }
  
  if (keyActions.length > 0) {
    parts.push(`主要完成：${keyActions.join('、')}。`);
  }
  
  return parts.join('');
}

// 生成 Markdown 笔记
function generateNote(session) {
  const dateStr = session.createdAt.substring(0, 10);
  const monthDir = dateStr.substring(0, 7);
  
  // Frontmatter
  const lines = [
    '---',
    'type: session-summary',
    `date: "${dateStr}"`,
    `month: "${monthDir}"`,
    `created: "${session.createdAt}"`,
    `session_id: "${session.sessionId}"`,
    `conversationCount: ${session.totalTurns}`,
    `messageCount: ${session.totalMessages}`,
    `toolCalls: ${session.totalTools}`,
    `errors: ${session.totalErrors}`,
    `topics: [${session.keyTopics.map(t => `"${t}"`).join(', ')}]`,
    '---',
    '',
    `# 📝 DSH 会话摘要 ${dateStr}`,
    '',
    `> **会话ID**: ${session.sessionId.substring(0, 8)}...`,
    `> **创建时间**: ${new Date(session.createdAt).toLocaleString('zh-CN')}`,
    `> **对话轮数**: ${session.totalTurns} 轮 | **消息数**: ${session.totalMessages} 条 | **工具调用**: ${session.totalTools} 次`,
    '',
    '## 会话摘要',
    '',
    session.summary,
    ''
  ];
  
  // 关键对话
  if (session.userQueries.length > 0) {
    lines.push('## 关键对话');
    lines.push('');
    session.userQueries.slice(0, 5).forEach((query, idx) => {
      lines.push(`### Q${idx + 1}: ${query.substring(0, 150)}${query.length > 150 ? '...' : ''}`);
      lines.push('');
    });
    lines.push('');
  }
  
  // 主题标签
  lines.push('## 主题标签');
  lines.push('');
  lines.push(session.keyTopics.map(t => `[[${t}]]`).join(', '));
  lines.push('');
  
  // 统计信息
  lines.push('## 统计信息');
  lines.push('');
  lines.push(`| 指标 | 数值 |`);
  lines.push(`|------|------|`);
  lines.push(`| 对话轮数 | ${session.totalTurns} |`);
  lines.push(`| 消息总数 | ${session.totalMessages} |`);
  lines.push(`| 工具调用 | ${session.totalTools} |`);
  lines.push(`| 错误数量 | ${session.totalErrors} |`);
  lines.push('');
  
  lines.push('---');
  lines.push('*由 AI 知识库系统自动生成*');
  
  return lines.join('\n');
}

// 主函数
function syncSessions() {
  console.log('[*] 开始分析并同步 DSH 会话摘要');
  console.log('[*] 会话目录:', SESSION_ROOT);
  console.log('[*] 知识库目录:', KB_ROOT);
  console.log('');
  
  fs.mkdirSync(path.join(KB_ROOT, '01-Daily'), { recursive: true });
  
  const sessions = fs.readdirSync(SESSION_ROOT)
    .filter(name => fs.statSync(path.join(SESSION_ROOT, name)).isDirectory())
    .sort();
  
  let totalSessions = 0;
  let totalConversations = 0;
  const syncedDates = new Set();
  
  for (const sessionName of sessions) {
    const zstdFile = path.join(SESSION_ROOT, sessionName, 'session.jsonl.zstd');
    if (!fs.existsSync(zstdFile)) continue;
    
    totalSessions++;
    console.log(`[*] 分析会话: ${sessionName}`);
    
    // 读取并解压
    const buffer = fs.readFileSync(zstdFile);
    const frames = scanFrames(buffer);
    console.log(`  -> ${frames.length} 个帧`);
    
    const decoded = decompressAll(buffer, frames);
    const messages = parseJsonl(decoded.toString('utf-8'));
    console.log(`  -> ${messages.length} 条消息`);
    
    // 分析会话
    const session = analyzeSession(messages);
    totalConversations += session.totalTurns;
    console.log(`  -> ${session.totalTurns} 轮对话，标签: ${session.keyTopics.join(', ')}`);
    
    if (session.totalTurns === 0) continue;
    
    // 提取日期
    const dateStr = session.createdAt.substring(0, 10);
    syncedDates.add(dateStr);
    
    // 生成笔记
    const monthDir = path.join(KB_ROOT, '01-Daily', dateStr.substring(0, 7));
    fs.mkdirSync(monthDir, { recursive: true });
    
    const safeName = sessionName.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 12);
    const logFile = path.join(monthDir, `${dateStr}-DSH-${safeName}.md`);
    const noteContent = generateNote(session);
    fs.writeFileSync(logFile, noteContent, 'utf-8');
    
    console.log(`  -> 已生成: ${path.basename(logFile)}`);
  }
  
  // 更新统计
  const statsFile = path.join(KB_ROOT, '_meta', 'stats.json');
  let stats = [];
  if (fs.existsSync(statsFile)) {
    try { stats = JSON.parse(fs.readFileSync(statsFile, 'utf-8')); } catch (e) { stats = []; }
  }
  stats.push({
    time: new Date().toISOString(),
    action: 'session_summary_sync',
    total_sessions: totalSessions,
    total_conversations: totalConversations,
    synced_dates: Array.from(syncedDates).sort(),
    errors: 0
  });
  fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2), 'utf-8');
  
  console.log('');
  console.log('[✓] 同步完成!');
  console.log(`  - 分析会话: ${totalSessions} 个`);
  console.log(`  - 总对话轮数: ${totalConversations} 轮`);
  console.log(`  - 涉及日期: ${Array.from(syncedDates).sort().join(', ')}`);
}

syncSessions();
