# @galvinsan/pi-mentis-knowledge

Pi `v0.83.0` 的独立持久知识库 Extension，使用 Zvec、SiliconFlow Embedding、Dense + Full-text 混合检索和可降级 Rerank。

如果同时需要个人长期记忆，请安装推荐的集成包 [`@galvinsan/pi-mentis`](https://www.npmjs.com/package/@galvinsan/pi-mentis)，不要同时安装两个 Pi Mentis 产品。

## 安装

```bash
pi install npm:@galvinsan/pi-mentis-knowledge
```

要求：Node.js `>=22.19.0`、Pi 必须为 `0.83.0`、有效的 SiliconFlow API Key。

```bash
export SILICONFLOW_API_KEY="your-api-key"
pi
```

验证：

```text
/kb status
/kb models
```

## 添加和检索知识

```text
/kb add ./docs
/kb add ./manual.pdf
/kb add https://zhanghandong.github.io/pi-book/
/kb jobs <job-id>
```

也可以让 Pi 调用工具：

```text
请调用 commit_knowledge，把 ./docs 添加到 user namespace。
请调用 search_knowledge，搜索“Pi session tree”，返回 10 条结果。
```

本包注册：

- `commit_knowledge`：提交文件、目录、URL、文本、Git、Pi package、Skill 或 MCP schema。
- `search_knowledge`：执行 Dense + FTS + RRF，并在可用时执行 Rerank。

## 站点级文档抓取

HTML URL 会自动识别 sidebar/TOC、mdBook `toc.js`/`toc.html`、`rel=next` 和 sitemap index，并按照菜单或章节顺序导入完整文档集合。

抓取仅限同源和入口 URL 的文档路径，过滤资源、搜索、打印和重复页面。默认上限为 1000 页、512 MiB。例如 `https://zhanghandong.github.io/pi-book/` 会得到 35 个有序页面，而不是只有首页。

已经用旧版本导入的 URL 需要重新构建：

```text
/kb rebuild https://zhanghandong.github.io/pi-book/
```

## 配置

在 Pi 启动目录创建 `.pi-mentis/config.json`：

```json
{
  "inference": {
    "siliconflow": {
      "apiKeyEnv": "SILICONFLOW_API_KEY",
      "embedding": { "model": "BAAI/bge-m3", "dimensions": 1024 },
      "rerank": {
        "model": "BAAI/bge-reranker-v2-m3",
        "maxInputTokens": 8192
      }
    }
  },
  "performance": {
    "resources": { "maxWebPages": 1000, "maxWebBytes": 536870912 }
  },
  "storage": {
    "rootDir": "/Users/your-name/.pi/agent/pi-mentis/zvec"
  }
}
```

API Key 不要写入 JSON。环境变量 `SILICONFLOW_EMBEDDING_MODEL`、`SILICONFLOW_EMBEDDING_DIMENSIONS`、`SILICONFLOW_RERANKER_MODEL` 和 `SILICONFLOW_RERANK_MAX_INPUT_TOKENS` 可覆盖模型配置。

## 支持的来源与格式

- 文件、目录、Workspace、Git tracked files、HTTPS URL
- Pi package、Skill、MCP schema
- Markdown/MDX、HTML、XML、JSON/JSONL、YAML、TOML、CSV
- 常见源代码格式
- PDF、DOCX、XLSX、PPTX、EPUB、ZIP、EML、MBOX

## `/kb` 命令

| 命令                        | 用途               |
| --------------------------- | ------------------ |
| `/kb add <path-or-url>`     | 添加来源           |
| `/kb sync <path-or-url>`    | 增量同步           |
| `/kb rebuild <path-or-url>` | 重新构建           |
| `/kb jobs <job-id>`         | 查看任务           |
| `/kb cancel <job-id>`       | 取消任务           |
| `/kb inspect <document-id>` | 查看文档 chunks    |
| `/kb remove <source-id>`    | 删除来源           |
| `/kb status`                | 查看 Provider 状态 |
| `/kb models`                | 查看生效模型       |

## 存储与安全

- 默认数据目录：启动目录下的 `.pi-mentis/zvec`。
- 同一存储目录只允许一个写入进程。
- API Key 不进入存储或日志。
- 私网 URL、超限资源、XML 实体、Zip Slip 和压缩炸弹会被拒绝。
- 备份前停止 Pi，并整体复制存储目录。

更多信息：[配置](https://github.com/guchengod/pi-mentis/blob/main/docs/configuration.md) · [解析器](https://github.com/guchengod/pi-mentis/blob/main/docs/parsers.md) · [检索](https://github.com/guchengod/pi-mentis/blob/main/docs/retrieval.md) · [问题反馈](https://github.com/guchengod/pi-mentis/issues)

MIT License.
