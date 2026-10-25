# v4.0.0 — 活大脑：每轮检索注入 + 实时沉淀

> `@dingpenghui/dsh-obsidian-sync@4.0.0`

本版把「知识库」从**按需调用的检索工具**升级为**每轮自动参与推理的活记忆**：

1. **每轮对话开始前**自动检索知识库，把最相关的记忆注入本轮上下文（模型据此推理）；
2. **每轮对话结束时**把本轮结论实时沉淀回知识库（流水 + 摘要行 + 聚合页），下一轮即可检索命中。

原有四个工具（`obsidian_search` / `obsidian_brief` / `obsidian_read_note` / `obsidian_sync_session`）行为不变，
新增第五个工具 `obsidian_brain`（查看状态 / 手动检索）。注入能力默认开启（`brainRetrieval: true`），
实时沉淀默认关闭（`brainAutoUpdate: false`，启用会产生额外的小模型调用）。

## 一、两条链路

### 1. 每轮检索注入（`brainRetrieval`，默认开）

```
用户输入 → agent/inbox/inserted
  ├ 判定：新用户轮次 & 非系统通知 & 非本插件注入 & 有检索词
  ├ 索引就绪（dirty → 重建；超时 → 降级为"空/非空"判断）
  ├ 相关性排序：沉淀层(02/03/05/06) ×2、流水层(04/01/00) ×1、标题/路径命中 +1.5
  ├ 融合：长期约束页（决策习惯与偏好）+ topK 命中笔记（正文预览截断）
  └ agent.steer(createUserMessage(source.kind='obsidian-brain'))   ← 跟随排队输入，不额外唤醒
```

实现要点（逐条核对过 DSH 0.2.1-rc.3 源码）：

| 需求 | 扩展点 | 位置 |
|------|--------|------|
| 每轮开始挂钩 | `agent/inbox/inserted`（emit） | `@deepseek-ai/dsh-agent` runtime-types |
| 注入上下文 | `agent.steer(msg)`（跟随已排队输入，不唤醒） | `agent/README.md` "Drive an agent's conversation" |
| 消息来源标记 | `createUserMessage({ source: { kind: 'obsidian-brain' } })`（`MessageSourceMap` 合并扩展） | `@deepseek-ai/dsh-llm/message` |
| 新一轮判定 | `session.surface.nodes` + `session.deriveMessages()`，不依赖新增 API | `@deepseek-ai/dsh-session` |
| 每轮结束挂钩 | `agent/turn-stopping`（serial，转结束前） | `@deepseek-ai/dsh-agent` runtime-types |

**为什么不用 `system-prompt/assemble` 注入正文**：系统提示每轮变化会让整段历史从首个变化 token 起
失去前缀缓存，且系统提示变短会触发日志重写；而往 surface 追加一条 user 消息只增加尾部 token，缓存友好，
也更容易在会话日志里审计（source.kind 可区分）。

### 2. 实时沉淀（`brainAutoUpdate`，默认关）

```
agent/turn-stopping
  ├ 取本轮用户输入 + 助手可见文本（过滤本插件注入与系统通知）
  ├ worthDistilling：寒暄/纯确认/过短 → 跳过（不花 token）
  ├ 小模型蒸馏（严格 JSON）：title / summary / keywords / related / pinned / open
  ├ 落盘：
  │   ├ 04-Archive/<date>-<shortid>-*.md  → 「## 实时沉淀（日期）」下追加本轮小节（同轮幂等）
  │   ├ 02-Projects|03-Areas|05-Resources → 「## 实时沉淀」下追加一行摘要（行级幂等，插在「## 关联」前）
  │   └ 06-Brain/recent.md               → 最近 7 天沉淀聚合
  ├ 索引置 dirty（下一轮检索即可命中本轮新内容）
  └ 可选 brainAutoCommit：git commit + push（默认关；归档器自身的推送逻辑未改）
```

单节超过 `brainLogCapBytes` 后自动开 `## 实时沉淀（日期 续N）`，避免单篇笔记无限增长。

## 二、新增配置（全部 volatile，详情页保存即生效）

| 键 | 默认 | 说明 |
|----|------|------|
| `brainRetrieval` | `true` | 总开关：每轮检索注入 |
| `brainRetrievalTopK` | `3` | 注入笔记条数（1..8） |
| `brainRetrievalMaxChars` | `1800` | 注入字数上限（硬上限 8000） |
| `brainRetrievalMinScore` | `2.5` | 相关性阈值（与 `obsidian_search` 同量级 IDF） |
| `brainRetrievalTimeoutMs` | `1500` | 索引等待 + 检索超时，超时即放行对话 |
| `brainAutoUpdate` | `false` | 实时沉淀总开关 |
| `brainMemoryProvider` / `brainMemoryModel` | 空 | 蒸馏模型；都空时跟随当前 agent 路由 |
| `brainMemoryApiKeyEnv` | 空 | 直连时的凭据引用名（经 credentials 解析，配置里不落密钥） |
| `brainMemoryMaxCalls` | `20` | 单进程调用预算 |
| `brainPinnedBudget` | `2` | 每轮最多钉住几篇沉淀层笔记 |
| `brainAutoCommit` | `false` | 沉淀后是否 git commit + push |
| `brainLogCapBytes` | `200000` | 流水页单节大小上限 |

> bundle patch 会整体替换该行 config：升级后如沿用旧 patch，需要把新增键一并写上（本包 `cordis.patch.yml` 已给出完整示例）。

## 三、失败模式与降级

| 场景 | 行为 |
|------|------|
| 索引未就绪/超时 | 不注入，对话照常 |
| vault 不可达 | 检索返回空；沉淀跳过并记日志 |
| 蒸馏模型不可用/无凭据 | 跳过沉淀，`logger.warn`，不影响对话与归档 |
| 模型返回非法 JSON | 围栏/前后文提取 + 一次收敛；仍失败则跳过 |
| 同一轮重复触发 | 轮次键去重（注入 / 蒸馏各自一次） |
| 用户连发多条 | 合并为一次注入（`:batch` 键） |

## 四、验证

```bash
# 纯函数回归（16 项：分词分层/打分/注入上限/轮次键/蒸馏规范化/幂等追加/章节滚动…）
node --experimental-strip-types test/brain-retrieval.test.mjs

# 运行级冒烟（真实 Session / 真实 brain.ts 路径 / 假 LLM）：
#   注入、同轮去重、开关、恢复、蒸馏落盘（流水+摘要+聚合）、同轮幂等、工具侧检索
node --experimental-strip-types test/brain-runtime.test.mjs
```

实测输出（2026-10-25）：

```
16/16 passed

ok   每轮检索注入（含长期约束页）   注入长度 583 字符
ok   同一轮连发合并为一次注入
ok   开关可关闭
ok   重新开启后恢复注入
ok   蒸馏落盘（流水页 + 沉淀摘要行 + 06-Brain 聚合）   llm 调用次数 1
ok   同轮幂等（不重复调用、不重复写盘）
ok   工具侧检索入口可用（命中 3 条）
```

## 五、升级与回滚

- 升级：替换插件后**完全退出并重启 DSH**（插件宿主代码不参与 HMR）。
- 回滚：`brainRetrieval: false` + `brainAutoUpdate: false` 即回到 v3.4.8 的纯按需行为；
  已写入的「## 实时沉淀」小节可用 git 回退。
