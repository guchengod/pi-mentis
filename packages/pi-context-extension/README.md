# @galvinsan/pi-mentis

Pi Mentis 是为 [Pi](https://github.com/badlogic/pi-mono) 设计的个人长期记忆与知识库 Extension，包含知识库 + 长期记忆的完整集成版本。

- 个人长期记忆：偏好、事实、决策、流程、事件，跨会话召回。
- 知识库：文件、目录、Git 工作区、在线文档、Wiki 型站点。
- 混合检索：Dense + 全文 + RRF + 可选 Rerank + MMR。
- 本地持久化：Zvec 存储在本机，API Key 只读环境变量。
- Pi 原生：复用 Session / Branch 语义，不维护第二套会话树。
- 进程隔离：Pi 只加载轻量适配器和内存胶囊；Zvec、推理、捕获与维护运行在 Sidecar。

> English: Pi-native personal long-term memory + knowledge base, backed by Zvec and SiliconFlow.

## 要求

| 项目    | 要求                           |
| ------- | ------------------------------ |
| Pi      | `>= 0.84.0`                    |
| Node.js | `>=22.19.0`                    |
| 凭证    | `SILICONFLOW_API_KEY` 环境变量 |
| 存储    | 本机 Zvec，单写者              |

三个可选产品，只安装一个：

| 包                               | 适用场景              | 工具                                   |
| -------------------------------- | --------------------- | -------------------------------------- |
| `@galvinsan/pi-mentis`           | **推荐**：知识 + 记忆 | `commit_memory`, `search_memory`       |
| `@galvinsan/pi-mentis-memory`    | 只要个人记忆          | `commit_memory`, `search_memory`       |
| `@galvinsan/pi-mentis-knowledge` | 只要知识库            | `commit_knowledge`, `search_knowledge` |

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

详细配置默认位于 `~/.pi/.pi-mentis/config.json`，不随启动目录或 Workspace
变化；所有字段可省略并继承安全默认值。显式 Pi profile 使用
`<PI_CODING_AGENT_DIR>/.pi-mentis`，`PI_MENTIS_HOME` 可指定隔离的绝对路径。
API Key 只放环境变量，不要写入 JSON。

自动召回默认关闭。普通情况下，仅在当前轮启用了 `search_memory` 时，Extension 才会把一段
紧凑规则加入 Pi 系统提示词：当信息未知、不确定、当前上下文缺失，或可能存在于长期记忆/
知识库时，先搜索，不要猜测；工具未启用时不占用提示词 Token。

如需开启自动召回，在配置文件中加入：

```json
{
  "retrieval": { "automaticRecall": true }
}
```

开启后，召回选择本身仍然只读取内存胶囊，不访问 Zvec 或网络；但它会增加模型提示词内容，
并启用每轮结束后的语义胶囊刷新，因此发送消息后可能出现可感知的 TUI 延迟。Extension 会在
每个进程首次启用时显示警告。

Tool Result 的小结果会在一轮结束时批量发送给 Sidecar；大结果正文通过权限为 `0600` 的
一次性文件交接，避免 Node IPC 再复制整段文本。Sidecar 默认以较低 CPU 优先级运行，同时
限制知识库任务和全局文件解析并发，并把维护任务延后到消息发送后的敏感窗口之外。

## 使用

```text
请使用 commit_memory 记住：我在 Node.js 项目中优先使用 pnpm。
请调用 search_memory，搜索我关于 Node.js 包管理器的长期偏好。
```

Memory 以不分类的自然语言断言保存，不写入 Predicate、Memory Type、Domain、Cardinality、Fact Key 或 Semantic Key。需要纠正、强化或撤回时，Agent 会优先在同一轮用 `search_memory` 找到具体旧记录，再用不变的 `commit_memory({content})` 写入新陈述。主写路径先完成保存；后台优先对本轮召回的具体记录做 pairwise reasoning；没有显式召回时可复核 Core 找到的最强向量候选。相似度只选候选，不能改变状态；只有高置信成对证据才能建立 reinforce / supersede / retract / conflict 关系，不确定时安全 coexist。

这不是关键词或 correction/retraction 分类器。相似度只负责找候选，不能改变状态；后台整合保留原始来源、关系边和 decision trace。Branch hypothesis 在验证前不会污染主事实。

```text
/kb add ./docs
/kb add https://zhanghandong.github.io/pi-book/
/kb status
/kb help
/mentis help
```

`/mentis help` 会显示当前实际采用的配置文件路径和完整用法；`/kb help` 是同一份帮助的快捷入口。

安装或配置后运行 `/mentis doctor`。它只检查本地 Pi 版本、凭证变量是否存在、存储配置和
Sidecar 响应状态；不会发起任何模型或远程 provider 请求，也不会显示 API Key。

## 数据与安全

- 备份前停止 Pi，整体复制 `storage.rootDir`（默认 `~/.pi/.pi-mentis/zvec`）。
- 仅存在 `~/.pi/agent/.pi-mentis` 时会兼容使用；两套目录并存时固定选择稳定的
  `~/.pi/.pi-mentis`，另一套只报告为 inactive，不会自动合并、覆盖或删除。
- 同一存储目录只允许一个写入进程。
- 自动召回默认关闭；开启后只读取进程内不可变 Memory Capsule，不访问 Zvec、网络或文件系统。
- 完整语义检索继续由 `search_memory` 提供，并在隔离 Sidecar 中执行。
- 每个 Pi Extension 进程只启动一个 Sidecar；并发请求共享启动过程，不会重复拉起服务。
- Sidecar 在 Session 启动时异步启动、Session 关闭时停止；异常退出会自动退避重启并恢复最新 Branch。
- `search_memory`、独立的 `commit_memory` 及多个知识导入任务可在 Sidecar 中并发执行。
- 召回内容标记为不受信任证据，不会覆盖当前用户指令。

## 链接

- [GitHub](https://github.com/guchengod/pi-mentis)
- [Architecture](https://github.com/guchengod/pi-mentis/blob/main/docs/architecture.md)
- [Configuration](https://github.com/guchengod/pi-mentis/blob/main/docs/configuration.md)
- [Issues](https://github.com/guchengod/pi-mentis/issues)

MIT License.
