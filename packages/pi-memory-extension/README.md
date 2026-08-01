# @galvinsan/pi-mentis-memory

Pi `v0.83.0` 的独立个人长期记忆 Extension，使用 Pi 原生 Session/Branch provenance、Zvec 本地存储、SiliconFlow Embedding 和混合检索。

如果同时需要知识库，请安装推荐的集成包 [`@galvinsan/pi-mentis`](https://www.npmjs.com/package/@galvinsan/pi-mentis)，不要同时安装两个 Pi Mentis 产品。

## 安装

```bash
pi install npm:@galvinsan/pi-mentis-memory
```

要求：Node.js `>=22.19.0`、Pi 必须为 `0.83.0`、有效的 SiliconFlow API Key。

```bash
export SILICONFLOW_API_KEY="your-api-key"
pi
```

## 使用

本包注册 `commit_memory` 和 `search_memory`。

```text
请使用 commit_memory 记住：我在 TypeScript 项目中优先使用严格模式。
类型为 preference，重要度 0.8。
```

```text
请调用 search_memory，搜索我关于 TypeScript 编译配置的偏好。
```

支持的记忆类型：`preference`、`requirement`、`fact`、`decision`、`procedural`、`episodic`、`task`。

记忆可以绑定 user、project、repository、task 和 topic 等 scope。代码仓库上下文是可选项，普通个人会话同样可以使用。自动召回默认开启，并把召回内容标记为不受信任证据，不能覆盖当前用户指令。

## 配置

Pi Mentis 从 Pi 启动目录读取 `.pi-mentis/config.json`：

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
  "memory": {
    "offload": {
      "inlineMaxBytes": 8192,
      "truncateMaxBytes": 65536,
      "previewBytes": 4096
    }
  },
  "storage": {
    "rootDir": "/Users/your-name/.pi/agent/pi-mentis/zvec"
  }
}
```

API Key 只放在环境变量中。默认存储路径是启动目录下的 `.pi-mentis/zvec`；使用绝对 `rootDir` 可以让多个项目共享同一份个人记忆，但同一目录同时只能有一个写入进程。

## 检索与工具结果

- Dense + Full-text Search 通过 RRF 融合。
- SiliconFlow Rerank 失败时默认降级到本地排序。
- MMR 减少重复结果。
- 自动召回具有软/硬超时，不会无限阻塞回复。
- 大型工具结果会保存为本地 Artifact，模型上下文只接收预览或引用。
- Episode、Event 和 Artifact 保留证据来源；记忆是可演化的派生结论。

## 安全、备份与排障

- API Key 不写入 Zvec、manifest、诊断或日志。
- 备份前停止 Pi，整体复制 `storage.rootDir`。
- `StorageBusyError` 表示另一个进程正在写同一目录；不要删除锁文件绕过保护。
- Embedding 模型或维度发生变化时，应先备份并执行受控迁移。
- 当前包只兼容 Pi `0.83.0`，版本检查会在数据和模型初始化之前执行。

升级与卸载：

```bash
pi update npm:@galvinsan/pi-mentis-memory
pi remove npm:@galvinsan/pi-mentis-memory
```

更多信息：[架构](https://github.com/guchengod/pi-mentis/blob/main/docs/architecture.md) · [配置](https://github.com/guchengod/pi-mentis/blob/main/docs/configuration.md) · [数据模型](https://github.com/guchengod/pi-mentis/blob/main/docs/data-model.md) · [问题反馈](https://github.com/guchengod/pi-mentis/issues)

MIT License.
