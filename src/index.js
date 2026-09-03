/**
 * DSH Obsidian Sync Plugin
 * 自动将 DSH 对话内容同步到 Obsidian 知识库
 */
import { definePlugin } from '@deepseek-ai/dsh-plugin';
import { Tool } from '@deepseek-ai/dsh-plugin/tool';
import * as path from 'path';
const DEFAULT_CONFIG = {
    vaultPath: 'D:/DSH/workspace/knowledge-base',
    autoSync: true,
    syncOnTurnEnd: true,
    readBeforeTurn: true,
    maxRelatedNotes: 3,
    tagKeywords: [
        '知识库', 'obsidian', 'ai', 'deepseek', '插件', '安装',
        'python', 'node', 'cordis', '自动化', '同步', 'npm',
        'github', 'release', '发布', '代码', '编程'
    ]
};
export default definePlugin({
    id: 'dsh-obsidian-sync',
    name: 'DSH Obsidian Sync',
    description: '自动同步 DSH 对话到 Obsidian 知识库',
    version: '1.0.0',
    apply(ctx) {
        const config = { ...DEFAULT_CONFIG, ...(ctx.settings?.get('obsidian-sync') || {}) };
        // 注册读取知识库的 Tool
        ctx.registerTool(new Tool({
            id: 'obsidian.read_knowledge',
            name: 'obsidian_read_knowledge',
            description: '读取 Obsidian 知识库中相关主题的内容',
            parameters: {
                type: 'object',
                properties: {
                    topic: { type: 'string', description: '要查询的主题关键词' },
                    limit: { type: 'number', description: '返回结果数量限制', default: 3 }
                },
                required: ['topic']
            },
            async execute(params) {
                try {
                    const { execSync } = await import('child_process');
                    const scriptPath = path.join(__dirname, 'search-knowledge.js');
                    const result = execSync(`node "${scriptPath}" "${params.topic}" ${params.limit || 3}`, {
                        encoding: 'utf-8',
                        env: { ...process.env, VAULT_PATH: config.vaultPath }
                    });
                    return { success: true, data: JSON.parse(result) };
                }
                catch (e) {
                    return { success: false, error: e.message };
                }
            }
        }));
        // 注册同步会话的 Tool
        ctx.registerTool(new Tool({
            id: 'obsidian.sync_session',
            name: 'obsidian_sync_session',
            description: '将当前 DSH 会话内容同步到 Obsidian 知识库',
            parameters: {
                type: 'object',
                properties: {
                    session_id: { type: 'string' },
                    summary: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } }
                },
                required: ['session_id']
            },
            async execute(params) {
                try {
                    const { execSync } = await import('child_process');
                    const scriptPath = path.join(__dirname, 'sync-session.js');
                    const result = execSync(`node "${scriptPath}" --session="${params.session_id}" --summary="${(params.summary || '').replace(/"/g, '\\"')}" --tags="${(params.tags || []).join(',')}"`, { encoding: 'utf-8', env: { ...process.env, VAULT_PATH: config.vaultPath } });
                    return { success: true, output: result };
                }
                catch (e) {
                    return { success: false, error: e.message };
                }
            }
        }));
        // 会话前钩子：读取相关知识
        if (config.readBeforeTurn) {
            ctx.on('turn/start', async (event, context) => {
                try {
                    const keywords = extractKeywords(event.data?.content || '', config.tagKeywords);
                    if (keywords.length > 0) {
                        const { execSync } = await import('child_process');
                        const scriptPath = path.join(__dirname, 'search-knowledge.js');
                        for (const kw of keywords.slice(0, 2)) {
                            try {
                                const result = execSync(`node "${scriptPath}" "${kw}" 3`, {
                                    encoding: 'utf-8',
                                    env: { ...process.env, VAULT_PATH: config.vaultPath },
                                    timeout: 5000
                                });
                                const notes = JSON.parse(result);
                                if (notes.length > 0) {
                                    const content = notes.map((n) => `[${n.file}]\n${n.preview}`).join('\n\n');
                                    context.addSystemHint(`\n\n## Obsidian 参考\n${content}`);
                                }
                            }
                            catch (e) { /* ignore */ }
                        }
                    }
                }
                catch (e) { /* ignore */ }
            });
        }
        // 会话后钩子：自动同步
        if (config.syncOnTurnEnd && config.autoSync) {
            ctx.on('turn/end', async (event, context) => {
                try {
                    const { execSync } = await import('child_process');
                    const scriptPath = path.join(__dirname, 'sync-session.js');
                    const sessionId = context.sessionId || 'unknown';
                    const messages = context.messages || [];
                    const summary = generateSummary(messages);
                    const tags = extractTags(messages, config.tagKeywords);
                    execSync(`node "${scriptPath}" --session="${sessionId}" --summary="${summary.replace(/"/g, '\\"')}" --tags="${tags.join(',')}"`, { encoding: 'utf-8', env: { ...process.env, VAULT_PATH: config.vaultPath }, stdio: 'ignore' });
                }
                catch (e) { /* ignore */ }
            });
        }
    }
});
function extractKeywords(text, keywords) {
    const found = [];
    const textLower = text.toLowerCase();
    for (const kw of keywords) {
        if (textLower.includes(kw.toLowerCase()) && !found.includes(kw)) {
            found.push(kw);
        }
    }
    return found;
}
function generateSummary(messages) {
    const userMsgs = messages.filter((m) => m.role === 'user');
    const assistantMsgs = messages.filter((m) => m.role === 'assistant');
    const lastUser = userMsgs[userMsgs.length - 1]?.content?.substring(0, 200) || '';
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1]?.content?.substring(0, 500) || '';
    return `用户: ${lastUser}\n\n助手: ${lastAssistant}`;
}
function extractTags(messages, tagKeywords) {
    const allText = messages.map((m) => m.content || '').join(' ');
    const tags = [];
    for (const kw of tagKeywords) {
        if (allText.includes(kw) && !tags.includes(kw)) {
            tags.push(kw);
        }
    }
    return tags;
}
