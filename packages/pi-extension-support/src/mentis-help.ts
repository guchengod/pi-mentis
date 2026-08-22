export interface MentisHelpOptions {
  readonly configPath: string;
  readonly memory?: boolean;
  readonly knowledge?: boolean;
  readonly doctor?: boolean;
  readonly providerSettings?: boolean;
}

export function formatMentisHelp(options: MentisHelpOptions): string {
  const memory = options.memory !== false;
  const knowledge = options.knowledge !== false;
  const lines = [
    "Pi Mentis 使用帮助",
    "",
    `配置文件：${options.configPath}`,
    options.providerSettings === true
      ? "Provider 设置会在选择或输入后立即保存并热加载；API Key 不会写进配置文件。"
      : "修改配置后，请运行 /reload 或重启 Pi。API Key 应放在环境变量中，不要写进配置文件。",
  ];

  if (memory) {
    lines.push(
      "",
      "记忆：",
      "- 当问题涉及以前的偏好、决定、项目历史或当前上下文里没有的信息时，Pi 会使用 search_memory 搜索。",
      "- 只有你明确说“记住、更新、纠正、忘记”时，Pi 才应使用 commit_memory。",
      "- 自动召回默认关闭。可在配置中设置 retrieval.automaticRecall=true 开启；开启后会增加提示词和后台工作，TUI 可能出现可感知延迟。",
    );
  }

  if (knowledge) {
    lines.push(
      "",
      "知识库：",
      "- /kb add <路径或网址>：添加文件、目录或网页。",
      "- /kb sync <路径或网址>：同步已有来源。",
      "- /kb rebuild <路径或网址>：重新构建来源索引。",
      "- /kb status：查看服务、存储和任务状态。",
      "- /kb jobs <任务 ID>：查看导入任务。",
      "- /kb cancel <任务 ID>：取消尚未完成的任务。",
      "- /kb inspect <文档 ID>：查看已索引文档。",
      "- /kb remove <来源 ID>：删除一个知识来源。",
      "- /kb models：查看 Embedding 和 Rerank 配置。",
      "- /kb help：显示本帮助。",
    );
  }

  lines.push(
    "",
    "服务：",
    ...(options.providerSettings === true
      ? [
          "- /mentis：选择 Provider 并配置 API Key、Embedding 和 Rerank 模型。",
          "- /mentis key：直接输入或更新当前 Provider 的 API Key。",
          "- /mentis config：打开当前 Provider 的模型设置。",
          "- /mentis test：验证当前 Provider 的 Embedding 和 Rerank 连接。",
        ]
      : []),
    "- /mentis status：查看 Mentis 当前状态。",
    ...(options.doctor === true
      ? ["- /mentis doctor：运行只读的本地配置、凭证和 Sidecar 健康检查。"]
      : []),
    "- /mentis help：显示本帮助。",
    "- 每个 Pi 扩展进程只维护一个 Sidecar；Sidecar 意外退出后会按需自动重启。",
  );
  return lines.join("\n");
}
