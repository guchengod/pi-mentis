# @galvinsan/pi-mentis-memory

Pi `>= 0.84.0` 的独立个人长期记忆 Extension，使用 Pi 原生 Session/Branch provenance、Zvec 本地存储、SiliconFlow Embedding 和混合检索。

如果同时需要知识库，请安装推荐集成包 [`@galvinsan/pi-mentis`](https://www.npmjs.com/package/@galvinsan/pi-mentis)，不要同时安装两个产品。

## 安装

```bash
pi install npm:@galvinsan/pi-mentis-memory
```

要求：Node.js `>=22.19.0`、Pi `>= 0.84.0`、有效的 SiliconFlow API Key。

```bash
export SILICONFLOW_API_KEY="your-api-key"
pi
```

## 使用

本包注册 `commit_memory` 和 `search_memory`。

```text
请使用 commit_memory 记住：我在 TypeScript 项目中优先使用严格模式。
请调用 search_memory，搜索我关于 TypeScript 编译配置的偏好。
```

记忆类型：`preference`、`requirement`、`fact`、`decision`、`procedural`、`episodic`、`task`。
支持 `single` / `set` / `ordered` / `event` 时间基数；迟到旧事实只进历史，冲突保留双方，Branch hypothesis 在验证前不污染主事实。检索前执行身份、项目、环境、时间、证据和指令安全 Gate。

查看状态：`/mentis status`

## 配置

从 Pi 启动目录读取 `.pi-mentis/config.json`，所有字段可省略：

```json
{
  "inference": {
    "siliconflow": {
      "apiKeyEnv": "SILICONFLOW_API_KEY",
      "embedding": { "model": "BAAI/bge-m3", "dimensions": 1024 },
      "rerank": { "model": "BAAI/bge-reranker-v2-m3", "maxInputTokens": 8192 }
    }
  },
  "memory": {
    "offload": {
      "inlineMaxBytes": 8192,
      "truncateMaxBytes": 65536,
      "previewBytes": 4096
    }
  },
  "storage": { "rootDir": "/Users/your-name/.pi/agent/pi-mentis/zvec" }
}
```

API Key 只放环境变量。`storage.rootDir` 默认 `.pi-mentis/zvec`；同一目录同时只能有一个写入进程。

## 检索与安全

- Dense + 全文通过 RRF 融合，Rerank 失败时降级本地排序，MMR 减少重复。
- 自动召回有软/硬超时，不会无限阻塞回复；召回内容标记为不受信任证据。
- 大型工具结果保存为本地 Artifact，模型上下文只接收预览或引用；Artifact 按字节范围分段读取，并二次校验身份。
- 备份前停止 Pi，整体复制 `storage.rootDir`。
- API Key 不写入 Zvec、manifest、诊断或日志。

升级：`pi update npm:@galvinsan/pi-mentis-memory` · 卸载：`pi remove npm:@galvinsan/pi-mentis-memory`

更多信息：[架构](https://github.com/guchengod/pi-mentis/blob/main/docs/architecture.md) · [配置](https://github.com/guchengod/pi-mentis/blob/main/docs/configuration.md) · [数据模型](https://github.com/guchengod/pi-mentis/blob/main/docs/data-model.md) · [问题反馈](https://github.com/guchengod/pi-mentis/issues)

MIT License.
