# @pi-mentis/pi-mentis-knowledge

Standalone persistent knowledge ingestion and retrieval for Pi v0.83.0, backed by Zvec and
SiliconFlow embeddings.

## Install

```bash
pi install @pi-mentis/pi-mentis-knowledge
```

Set `SILICONFLOW_API_KEY`, then start Pi. The extension registers `commit_knowledge` and
`search_knowledge`.

Install only one Pi Mentis extension product at a time. See the
[repository README](https://github.com/guchengod/pi-mentis#readme) for configuration, architecture,
and verification details.

## Requirements

- Node.js 22.19 or newer
- `@earendil-works/pi-coding-agent` exactly 0.83.0
- A SiliconFlow API key

MIT licensed.
