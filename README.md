# DSH Obsidian Sync Plugin

> 自动将 DSH 对话内容同步到 Obsidian 知识库

## 功能特性

1. **会话前自动读取知识库**
   - 根据用户输入关键词，自动搜索 Obsidian 知识库
   - 将相关内容注入到系统提示中
   - 提供上下文补充，提升对话质量

2. **会话后自动同步**
   - 自动生成会话摘要
   - 提取主题标签
   - 保存到 Obsidian 知识库

## 安装

### 方式一：从 npm 安装（推荐）

```bash
dsh plugin --profile web add dsh-obsidian-sync
```

### 方式二：从本地路径安装

```bash
cd dsh-obsidian-sync
npm install
npm run build
dsh plugin --profile web add .
```

## 配置

在 `~/.dsh/settings.yaml` 中添加：

```yaml
obsidian-sync:
  vaultPath: "D:/path/to/your/obsidian/vault"
  autoSync: true
  syncOnTurnEnd: true
  readBeforeTurn: true
```

## 使用

安装后插件会自动：
- 对话前搜索相关知识库内容
- 对话后生成摘要并同步

## 开发

```bash
npm install
npm run build
npm test
```

## 发布

```bash
npm version patch
git push origin main --tags
npm publish
```

## 许可证

MIT

---

**作者**: Dingpenghui-good  
**仓库**: https://github.com/Dingpenghui-good/dsh-obsidian-sync
