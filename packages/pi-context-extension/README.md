# @galvinsan/pi-mentis

Pi Mentis 是为 [Pi](https://github.com/badlogic/pi-mono) 设计的个人长期记忆与知识库 Extension，包含知识库 + 长期记忆的完整集成版本。

- 个人长期记忆：偏好、事实、决策、流程、事件，跨会话召回。
- 知识库：文件、目录、Git 工作区、在线文档、Wiki 型站点。
- 混合检索：Dense + 全文 + RRF + 可选 Rerank + MMR。
- 本地持久化：Zvec 存储在本机，API Key 只读环境变量。
- Pi 原生：复用 Session / Branch 语义，不维护第二套会话树。

> English: Pi-native personal long-term memory + knowledge base, backed by Zvec and SiliconFlow.

## 要求

| 项目     | 要求                              |
| -------- | --------------------------------- |
| Pi       | `>= 0.84.0`                       |
| Node.js  | `>=22.19.0`                       |
| 凭证     | `SILICONFLOW_API_KEY` 环境变量    |
| 存储     | 本机 Zvec，单写者                 |

三个可选产品，只安装一个：

| 包                               | 适用场景                | 工具                                  |
| -------------------------------- | ----------------------- | ------------------------------------- |
| `@galvinsan/pi-mentis`           | **推荐**：知识 + 记忆   | `commit_memory`, `search_memory`      |
| `@galvinsan/pi-mentis-memory`    | 只要个人记忆            | `commit_memory`, `search_memory`      |
| `@galvinsan/pi-mentis-knowledge` | 只要知识库              | `commit_knowledge`, `search_knowledge`|

## 安装

```bash
pi install npm:@galvinsan/pi-mentis
```

升级：`pi update npm:@galvinsan/pi-mentis` · 卸载：`pi remove npm:@galvinsan/pi-mentis`

## 配置

```bash
export SILICONFLOW_API_KEY="your-api-key"
```

默认模型：Embedding `Qwen/Qwen3-Embedding-8B`（1024 维），Rerank `Qwen/Qwen3-Reranker-8B`。
可选 BAAI 模型（`SILICONFLOW_EMBEDDING_MODEL`、`SILICONFLOW_EMBEDDING_DIMENSIONS`、`SILICONFLOW_RERANKER_MODEL`、`SILICONFLOW_RERANK_MAX_INPUT_TOKENS`）。

详细配置见 Pi 启动目录下的 `.pi-mentis/config.json`，所有字段可省略并继承安全默认值。
API Key 只放环境变量，不要写入 JSON。

## 使用

```text
请使用 commit_memory 记住：我在 Node.js 项目中优先使用 pnpm。
请调用 search_memory，搜索我关于 Node.js 包管理器的长期偏好。
```

记忆类型：`preference`、`requirement`、`fact`、`decision`、`procedural`、`episodic`、`task`。
支持 `single` / `set` / `ordered` / `event` 时间基数；迟到旧事实只进历史，冲突保留双方，实验 Branch 假设不会污染主事实。

```text
/kb add ./docs
/kb add https://zhanghandong.github.io/pi-book/
/kb status
```

## 数据与安全

- 备份前停止 Pi，整体复制 `storage.rootDir`（默认 `.pi-mentis/zvec`）。
- 同一存储目录只允许一个写入进程。
- 自动召回有软/硬超时（默认 300ms / 800ms），不会无限阻塞回复。
- 召回内容标记为不受信任证据，不会覆盖当前用户指令。

## 链接

- [GitHub](https://github.com/guchengod/pi-mentis)
- [Architecture](https://github.com/guchengod/pi-mentis/blob/main/docs/architecture.md)
- [Configuration](https://github.com/guchengod/pi-mentis/blob/main/docs/configuration.md)
- [Issues](https://github.com/guchengod/pi-mentis/issues)

MIT License.
