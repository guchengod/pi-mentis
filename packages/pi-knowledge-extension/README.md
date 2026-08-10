# @galvinsan/pi-mentis-knowledge

Pi `>= 0.84.0` 的独立持久知识库 Extension，使用 Zvec、SiliconFlow Embedding、Dense + 全文混合检索和可降级 Rerank。

如果同时需要个人长期记忆，请安装推荐集成包 [`@galvinsan/pi-mentis`](https://www.npmjs.com/package/@galvinsan/pi-mentis)，不要同时安装两个产品。

## 安装

```bash
pi install npm:@galvinsan/pi-mentis-knowledge
```

要求：Node.js `>=22.19.0`、Pi `>= 0.84.0`、有效的 SiliconFlow API Key。

```bash
export SILICONFLOW_API_KEY="your-api-key"
pi
```

验证：`/kb status`、`/kb models`

## 添加和检索知识

```text
/kb add ./docs
/kb add ./manual.pdf
/kb add https://zhanghandong.github.io/pi-book/
/kb jobs <job-id>
```

本包注册 `commit_knowledge` 和 `search_knowledge`。HTML URL 会自动识别 sidebar/TOC、mdBook `toc.js`、`rel=next` 和 sitemap，按章节顺序导入完整文档集合（默认上限 1000 页、512 MiB）。

## 配置

默认从 `~/.pi/agent/.pi-mentis/config.json` 读取全局 profile 配置，不随启动目录或
Workspace 变化。显式 Pi profile 使用 `<PI_CODING_AGENT_DIR>/.pi-mentis`；
`PI_MENTIS_HOME` 可指定隔离的绝对路径。所有字段可省略：

```json
{
  "inference": {
    "siliconflow": {
      "apiKeyEnv": "SILICONFLOW_API_KEY",
      "embedding": { "model": "BAAI/bge-m3", "dimensions": 1024 },
      "rerank": { "model": "BAAI/bge-reranker-v2-m3", "maxInputTokens": 8192 }
    }
  },
  "storage": { "rootDir": "/Users/your-name/.pi/agent/.pi-mentis/zvec" }
}
```

API Key 只放环境变量。Embedding 模型或维度变化时需先备份并执行受控迁移（`/kb migrate-embedding <dimensions>`），`BAAI/bge-m3` 固定 1024 维不可跨维度迁移。

## 支持来源与格式

- 文件、目录、Workspace、Git tracked files、HTTPS URL、Pi package、Skill、MCP schema
- Markdown/MDX、HTML、XML、JSON/JSONL、YAML、TOML、CSV、常见源代码
- PDF、DOCX、XLSX、PPTX、EPUB、ZIP、EML、MBOX

## `/kb` 命令

| 命令                         | 用途                |
| ---------------------------- | ------------------- |
| `/kb add <path-or-url>`      | 添加来源            |
| `/kb sync <path-or-url>`     | 增量同步            |
| `/kb rebuild <path-or-url>`  | 重新构建            |
| `/kb jobs <job-id>`          | 查看任务            |
| `/kb cancel <job-id>`        | 取消任务            |
| `/kb inspect <document-id>`  | 查看文档 chunks     |
| `/kb remove <source-id>`     | 删除来源            |
| `/kb status`                 | 查看 Provider 状态  |
| `/kb migrate-embedding <d>`  | 迁移 embedding 维度 |
| `/kb rollback-embedding <g>` | 回滚旧 generation   |

## 存储与安全

- 默认数据目录 `~/.pi/agent/.pi-mentis/zvec`；同一存储目录只允许一个写入进程。
- 发现旧 `~/.pi/.pi-mentis` 与 canonical root 并存时会停止初始化，不会静默选择或覆盖。
- API Key 不进入存储或日志；私网 URL、XML 实体、Zip Slip 和压缩炸弹会被拒绝。
- 备份前停止 Pi，整体复制存储目录。

升级：`pi update npm:@galvinsan/pi-mentis-knowledge` · 卸载：`pi remove npm:@galvinsan/pi-mentis-knowledge`

更多信息：[配置](https://github.com/guchengod/pi-mentis/blob/main/docs/configuration.md) · [解析器](https://github.com/guchengod/pi-mentis/blob/main/docs/parsers.md) · [检索](https://github.com/guchengod/pi-mentis/blob/main/docs/retrieval.md) · [问题反馈](https://github.com/guchengod/pi-mentis/issues)

MIT License.
