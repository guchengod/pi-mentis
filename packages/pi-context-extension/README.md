# @galvinsan/pi-mentis

Pi Mentis 是为 [Pi](https://github.com/badlogic/pi-mono) `v0.83.0` 设计的个人长期记忆与知识库 Extension。
它以代码 Agent 场景为第一优先级，但不绑定某个代码仓库：个人偏好、事实、决策、流程、任务、会话经历和外部知识都可以持久保存并在后续会话中召回。

这个包是推荐安装的集成版本，同时包含：

- 个人长期记忆：显式写入、证据绑定、冲突与演化关系。
- 知识库：文件、目录、Git 工作区、在线文档、静态书籍和 Wiki 型站点。
- Knowledge-first 检索：先检索知识，再利用知识结果引导记忆检索。
- 混合召回：Dense Vector + Full-text Search + RRF + 可选 Rerank + MMR。
- Pi 原生上下文：复用 Pi Session、Branch、Steering 和 Compaction 语义，不维护第二套会话树。
- Zvec 本地持久化：原始数据保存在本机，不把 API Key 写入存储或日志。

> English summary: Pi-native, knowledge-first personal long-term memory backed by Zvec and SiliconFlow.

## 兼容性与要求

| 项目     | 要求                                                |
| -------- | --------------------------------------------------- |
| Pi       | `@earendil-works/pi-coding-agent` **必须为 0.83.0** |
| Node.js  | `>=22.19.0`                                         |
| 推理服务 | SiliconFlow Embedding；Rerank 可降级                |
| 凭证     | `SILICONFLOW_API_KEY` 环境变量                      |
| 存储     | 本机 Zvec，单写者                                   |

Pi Mentis 有三个可选产品，只安装一个：

| 包                               | 适用场景                    | Pi 工具                                |
| -------------------------------- | --------------------------- | -------------------------------------- |
| `@galvinsan/pi-mentis`           | **推荐**：知识库 + 长期记忆 | `commit_memory`, `search_memory`       |
| `@galvinsan/pi-mentis-knowledge` | 只需要知识库                | `commit_knowledge`, `search_knowledge` |
| `@galvinsan/pi-mentis-memory`    | 只需要个人记忆              | `commit_memory`, `search_memory`       |

## 安装、升级与卸载

```bash
pi install npm:@galvinsan/pi-mentis
```

升级：

```bash
pi update npm:@galvinsan/pi-mentis
```

查看安装状态：

```bash
pi list
```

卸载：

```bash
pi remove npm:@galvinsan/pi-mentis
```

## 最小配置

API Key 必须放在环境变量中，不要写入 JSON：

```bash
export SILICONFLOW_API_KEY="your-api-key"
```

默认模型是：

- Embedding：`Qwen/Qwen3-Embedding-8B`，1024 维
- Rerank：`Qwen/Qwen3-Reranker-8B`，最大输入 32768 tokens

如果使用 BAAI 模型，可同时设置：

```bash
export SILICONFLOW_EMBEDDING_MODEL="BAAI/bge-m3"
export SILICONFLOW_EMBEDDING_DIMENSIONS="1024"
export SILICONFLOW_RERANKER_MODEL="BAAI/bge-reranker-v2-m3"
export SILICONFLOW_RERANK_MAX_INPUT_TOKENS="8192"
```

将环境变量写入 `~/.zshrc` 后执行：

```bash
source ~/.zshrc
```

## 完整配置

Pi Mentis 从 **Pi 启动目录**读取 `.pi-mentis/config.json`。所有字段均可省略并继承安全默认值：

```json
{
  "inference": {
    "siliconflow": {
      "apiKeyEnv": "SILICONFLOW_API_KEY",
      "embedding": {
        "model": "BAAI/bge-m3",
        "dimensions": 1024
      },
      "rerank": {
        "model": "BAAI/bge-reranker-v2-m3",
        "maxInputTokens": 8192
      }
    }
  },
  "memory": {
    "offload": {
      "inlineMaxBytes": 8192,
      "truncateMaxBytes": 65536,
      "previewBytes": 4096
    }
  },
  "performance": {
    "queue": { "maxQueuedTaskAgeMs": 1800000 },
    "resources": {
      "maxWebPages": 1000,
      "maxWebBytes": 536870912
    }
  },
  "intelligence": {
    "context": { "persistSnapshots": true, "capabilityMaxAgeMs": 60000 },
    "temporal": { "enabled": true, "repairOnStartup": true },
    "views": { "enabled": true, "ttlMs": 300000 },
    "effectiveness": { "enabled": true, "flushIntervalMs": 250, "maxBatch": 64 },
    "adaptivePolicy": { "enabled": true, "cooldownMs": 1800000 }
  },
  "storage": {
    "rootDir": "/Users/your-name/.pi/agent/pi-mentis/zvec"
  }
}
```

环境变量对模型配置具有更高优先级。`storage.rootDir` 默认是当前目录下的 `.pi-mentis/zvec`；如果希望多个项目共享同一份个人记忆，建议配置绝对路径，并确保相关启动目录使用同一份配置。

同一存储目录只能由一个 Pi 进程写入。不要同时启动两个指向相同 `rootDir` 的写入进程。

## 启动与健康检查

```bash
pi
```

进入 Pi 后：

```text
/kb status
/kb models
```

正常状态应包含 `ready: true`，并显示 embedding、reranker、knowledge、memory、retrieval 五个 active Provider。
同一状态输出还包含当前 Context revision、Topic/Task、相关 State Views、Effectiveness Buffer、
Outcome 汇总以及 Active/Shadow/Canary/Fallback Policy。

## 记忆如何保持“当前事实”

Pi Mentis 不把所有相似文本都当成同一层级的永真信息：

- `single` 事实只有一个当前 Head；较新的高可信事实会 supersede 旧事实。
- `set`、`ordered` 和 `event` 可以保留多个值或事件。
- 迟到的旧事实只进入 historical，不会覆盖当前 Head。
- 无法安全判断时进入 conflict，不猜测一个胜者。
- 实验 Branch 中的 hypothesis 不会修改主 Branch；放弃 Branch 后会被拒绝。
- Commit 使用可选 `idempotencyKey` 防止重试生成重复 Claim。

`search_memory` 的 `temporalMode` 可选择 `current`、`historical` 或 `all`。默认只返回当前可用事实。

## 安全 Gate、State View 与自适应检索

候选必须依次通过 tenant/user/app/agent、项目、时间、Branch、环境、证据、前提和指令安全检查。
网页、知识库、工具输出和模型推断可以作为数据被召回，但不会因此升级为用户指令。
`procedural` 记忆在未显式提供 applicability 时会绑定当前仓库、运行时和包管理器上下文。

Project/User/Topic/Task/Capability View 是可丢弃的派生加速层；每个字段保留 Atomic Memory ID，
不能创造新事实。过期 View 会立即返回旧值并在后台校验，失败不会阻塞 Atomic Memory 搜索。

检索 Trace 先写入有界内存 Buffer，再批量落盘。成功归因区分“展示过”和“实际在工具参数中使用”；
执行成功、验证通过和用户确认分别记录。Adaptive Policy 只优化有界检索参数，经过 Offline Replay、
Shadow、Canary 和 EWMA 监控；安全隔离、证据完整性、指令安全和删除规则永远不可自适应修改。

## 长期记忆的使用

可以直接用自然语言要求 Pi 调用工具：

```text
请使用 commit_memory 记住：我在 Node.js 项目中优先使用 pnpm。
类型为 preference，重要度 0.8。
```

可用记忆类型：

- `preference`：个人偏好
- `requirement`：长期约束或要求
- `fact`：稳定事实
- `decision`：已经做出的决定
- `procedural`：可复用流程
- `episodic`：一次会话或事件经历
- `task`：持续任务状态

手动检索：

```text
请调用 search_memory，搜索我关于 Node.js 包管理器的长期偏好。
```

大型 Tool Result 会返回 `artifactId`。可继续使用同一个工具按 UTF-8 安全的字节范围读取，
响应中的 `nextOffset` 可直接用于下一页：

```text
请调用 search_memory，artifactId 为 <id>，offset 为 0，length 为 32768。
```

也可以同时提供 Memory `id` 和 `query`，在该记忆的 Event/Artifact 证据链中搜索；返回匹配
片段与 `artifactOffset`，再按范围精确读取。Artifact 读取会再次校验 tenant/user/app/agent，
不会仅凭 ID 跨身份返回内容。

自动召回默认开启。相关证据会在模型回复前以明确标记的“不受信任证据”进入上下文，不能覆盖当前用户指令。

## 添加知识库

在 Pi 中使用 `/kb`：

```text
/kb add ./docs
/kb add ./README.md
/kb add https://zhanghandong.github.io/pi-book/
```

命令会返回后台任务 ID：

```text
/kb jobs <job-id>
```

已经导入的来源可重新同步或重建：

```text
/kb sync ./docs
/kb rebuild https://zhanghandong.github.io/pi-book/
```

### 在线书籍、文档站点和 Wiki

对于 HTML URL，Pi Mentis 不仅抓取入口页。它会按以下优先级发现完整、有序的文档集合：

1. 页面 sidebar、table of contents、navigation 菜单
2. mdBook 的 `toc.js` 或 `toc.html`
3. 章节的 `rel=next` 链
4. sitemap 和 sitemap index

抓取只允许同源并限制在入口 URL 的文档路径内；资源文件、搜索页、打印页和重复 URL 会被过滤。每个页面记录：

- `collectionUri`
- `pageOrder`
- `pageCount`
- `discovery`

例如添加 `https://zhanghandong.github.io/pi-book/` 会按“前言 → 第 1–33 章 → 附录”抓取 35 个页面，而不是只保存首页。

这是“目录边界抓取”，不会无边界遍历整个域名的所有链接。默认最多 1000 页、总计 512 MiB，可通过配置调整。

### 支持的来源和格式

来源包括文件、目录、工作区、Git 跟踪文件、HTTPS URL、Pi package、Skill 和 MCP schema。

主要格式包括：

- 文本、Markdown/MDX、HTML、XML
- JSON/JSONL、YAML、TOML、CSV
- TypeScript、JavaScript、Go、Rust、Python 等源代码
- PDF、DOCX、XLSX、PPTX、EPUB、ZIP
- EML、MBOX

解析结果保留标题、章节路径、页码、表格、代码符号和稳定语义键。HTML 优先提取 `<main>` 或 `<article>`，减少导航与页面外壳噪声。

## `/kb` 命令参考

| 命令                        | 说明                                      |
| --------------------------- | ----------------------------------------- |
| `/kb status`                | 查看 Provider 与 P8–P13 Intelligence 状态 |
| `/kb models`                | 查看当前生效的 Embedding/Rerank 模型      |
| `/kb add <path-or-url>`     | 添加文件、目录或 URL                      |
| `/kb sync <path-or-url>`    | 增量同步来源                              |
| `/kb rebuild <path-or-url>` | 重新解析并构建来源                        |
| `/kb jobs <job-id>`         | 查看后台任务结果或错误                    |
| `/kb cancel <job-id>`       | 取消尚未完成的任务                        |
| `/kb inspect <document-id>` | 查看文档及其 chunks                       |
| `/kb remove <source-id>`    | 删除指定来源                              |
| `/kb sources`               | 查看知识库能力和支持范围                  |

知识导入和 Embedding 迁移任务使用持久化的
`queued/leased/running/succeeded/failed/dead` 生命周期。命令会在“queued”响应前写入 Zvec；进程
中断后由下一次启动接管未完成 Lease，幂等 Source/Chunk/Generation ID 防止重试产生重复效果。

## 检索行为

集成包只暴露 `commit_memory` 和 `search_memory`，这是有意设计：

- 知识内容通过 `/kb` 管理，不允许模型随意改写。
- `search_memory` 先检索知识库，再检索长期记忆。
- Dense 与全文检索通过 RRF 融合。
- Rerank 不可用时会降级为本地排序，除非配置为 required。
- MMR 减少重复结果，知识和记忆使用独立 token 预算。
- 自动召回默认软超时 300 ms、硬超时 800 ms，不会无限阻塞当前回复。

## 数据、安全与备份

- API Key 只从环境变量读取，不写入 Zvec、manifest、诊断或日志。
- 私网 URL、符号链接循环、超大文件、XML DTD/ENTITY、Zip Slip 和压缩炸弹会被拒绝。
- 工具结果超过阈值时会保存为本地 Artifact，只把预览或引用放入模型上下文。
- 备份前先停止 Pi，然后复制整个 `storage.rootDir`；恢复时也必须整体恢复。
- 不要手动修改 Zvec collection 或 active manifest。

## 常见问题

### `SILICONFLOW_API_KEY` 未配置

确认变量在启动 Pi 的同一个 shell 中可见：

```bash
test -n "$SILICONFLOW_API_KEY" && echo configured
```

### 模型维度不匹配

Embedding 模型和 `dimensions` 必须与已有 Zvec generation 一致。切换维度前请先备份，并参考 [Embedding migration](https://github.com/guchengod/pi-mentis/blob/main/docs/embedding-migration.md)。

### `StorageBusyError`

已有另一个 Pi 进程持有同一存储目录。退出另一个写入进程后重试，不要删除锁文件来绕过单写者保护。

### 在线文档以前只导入了首页

升级到最新版本后执行：

```text
/kb rebuild <url>
```

### Pi 版本不兼容

当前版本只接受 Pi `0.83.0`。兼容性检查在工具、Zvec、Worker 和模型初始化之前执行，避免不兼容版本修改数据。

## 链接

- [GitHub repository](https://github.com/guchengod/pi-mentis)
- [Architecture](https://github.com/guchengod/pi-mentis/blob/main/docs/architecture.md)
- [Configuration](https://github.com/guchengod/pi-mentis/blob/main/docs/configuration.md)
- [Parsers](https://github.com/guchengod/pi-mentis/blob/main/docs/parsers.md)
- [Retrieval](https://github.com/guchengod/pi-mentis/blob/main/docs/retrieval.md)
- [Operations](https://github.com/guchengod/pi-mentis/blob/main/docs/operations.md)
- [Issues](https://github.com/guchengod/pi-mentis/issues)

MIT License.
