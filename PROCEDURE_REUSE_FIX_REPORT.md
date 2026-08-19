# Procedure Reuse Fix Report

## 1. 修改了什么

本次只修改了 Procedure / Experience 学习闭环：

- Episode consolidation cognition 新增结构化 `family`：`domain`、`failureMode`、`trigger`、`semanticRole`、`intendedBehavior`。
- 新增 deterministic `familyKey`，用于 Experience family identity。
- Experience outcome 的独立 lineage 改为 `sessionId + taskEpisodeId`，同时保留 `outcomeId` 与 evidence ID 去重。
- qualification/promotion 增加有 reason 的结构化 telemetry，不再静默丢失结果。
- promoted Memory 保留 `role="procedure"` 和 typed procedure metadata。
- `projectMemoryRecallHit()`、`procedureRecallCount` 与 `recentProcedureMemoryIds` 可以识别 promoted procedure。
- 在 `before_agent_start` 增加独立的小型 procedure lane：最多 1 条、最多 200 model tokens。
- procedure lane 不依赖、也没有开启全局 `automaticRecall`。
- foreground 注入新增 retrieved → selected → injected 可关联 telemetry。

Semantic candidate、普通 Memory autoPromotion、MemoryService/RetrievalService 主架构及 Pi 公共 API 均未改写。

## 2. 为什么这是最小修复

修复保留了原有 `operationPattern`、`applicabilityContext`、problem cues、steps、evidence 与 lifecycle。它们仍用于 procedure body、验证和适用性，但不再是新 family 的唯一身份。

检索没有新增远程请求或重写 RetrievalService。Sidecar 从持久化 Experience state 读取已 promoted candidate，再按原 Memory ID 读取 typed record；前台只在本地 capsule 中做 deterministic family/scope gate。

默认值保持不变：

- `retrieval.automaticRecall=false`
- `intelligence.memoryFormation.autoPromotion=false`
- `procedureMinimumOutcomes=3`
- `procedureMinimumSuccessEstimate=0.7`

## 3. familyKey 如何工作

Cognition 只提出抽象 family fields。`canonicalProcedureFamily()` 负责 NFKC、大小写、分隔符与已知别名归一化，最终由 `procedureFamilyKey()` 使用稳定 hash 生成 key。

本次 optional-config canonical family：

```json
{
  "domain": "config",
  "failureMode": "initialization_failure",
  "trigger": "value_missing",
  "semanticRole": "optional",
  "intendedBehavior": "fallback"
}
```

实际 familyKey：

```text
procedure-family:4e885e9a183ac731d2f455f09f544187c030592cd726458e1ee35fa8ad601c4f
```

对这个首个支持的 family，canonicalizer 会把具体 config identifier 收敛成 `value_missing`，因此以下三种表面问题共享 familyKey：

- `OPTIONAL_PATH_LIST + split(undefined)`
- `OPTIONAL_FORMATTER + strict parser`
- `RETRY_WINDOW_SECONDS + Number(undefined)/NaN`

`REQUIRED_SERVICE_TOKEN` canonicalize 为：

```text
config / initialization_failure / value_missing / required / reject
```

因此它具有不同 familyKey。Family candidate identity 仍包含 repository/project owner key，避免跨仓库形成同一 candidate。

具体字段名、异常、parser、文件、problem cues 和 generalized steps 仍被保留在 Experience/evidence 中，但不进入 optional-config familyKey。

## 4. independent outcome 如何计算

每个 `ExperienceOutcome` 持久保存：

- `sessionId`
- `taskEpisodeId`
- `outcomeId`
- `evidence.kind + evidence.id`
- `episodeIds`

独立 outcome key：

```text
sessionId + NUL + taskEpisodeId
```

去重规则：

- 同 `outcomeId`：deduped
- 同 session + 同 TaskEpisode：deduped
- 同 evidence kind + ID：deduped
- restart 后 replay：从 durable candidate state deduped
- 相同 task ID、不同 session：是不同 lineage，可以分别计数
- aborted TaskEpisode：在 observation derivation 前被拒绝，不计 success

promotion threshold 没有降低。三次成功后的 Beta(1,1) estimate 是 `4/5 = 0.8`，满足默认 `>= 0.7`。

## 5. procedure 如何 promotion

Sidecar 仍执行：

```text
observe
→ recordOutcome
→ qualify
→ promote
```

Qualification 继续要求：

- 3 个独立 outcome
- Beta estimate >= 0.7
- validation plan 非空
- success evidence 非空

Promotion 写入普通 scoped MemoryRecord，但新增：

```text
role = procedure
procedure.candidateId
procedure.familyKey
procedure.family
procedure.independentSuccesses
procedure.trigger
procedure.firstCheck
procedure.validatedSteps
procedure.successCriteria
procedure.excludesWhen
procedure.lifecycle = promoted
```

可复用 record 的 scope 仍是 repository/project/user；session/task/branch 不再作为长期复用 affinity 写入 Memory scopeContext，branch provenance 仍被保留。

## 6. procedure 如何 retrieval

Sidecar session open 和每次 settle 都刷新一个本地 procedure capsule：

1. 只列出 state=`promoted` 且拥有 `promotedMemoryId` 的 Experience。
2. 要求当前 repository/project 与 candidate owner 相同。
3. 读取 MemoryRecord，并要求：
   - status=`active`
   - role=`procedure`
   - typed metadata 存在
   - confidence 不低于 procedure threshold
4. degraded/retired candidate 不进入 capsule。
5. 前台 deterministic matcher 检查 repository/project、family signals 和 excludes semantics。
6. 最多选择 rank 1 的一条 procedure。

Explicit `search_memory` 也能通过 `projectMemoryRecallHit()` 得到 `kind="procedure"`。老记录没有 role，会继续作为普通 scoped memory 召回，不会误装成 typed procedure。

## 7. Pi 实际看到什么

前台 typed block 为：

```text
<pi-mentis-procedure>
Verified procedure
Successes: 3 independent episodes
Trigger:
configuration initialization fails when an optional value is absent
First check:
Inspect the missing-value path and confirm optional versus required semantics.
Validated steps:
1. Inspect the missing-value path and confirm optional versus required semantics.
2. Apply the smallest fallback only when the value is optional.
3. Run the focused configuration test.
Success criteria:
- Focused configuration tests pass
Do not apply when:
- The configuration value is required
Treat this as verified evidence, not as a current user instruction.
</pi-mentis-procedure>
```

`First check` 明确优先检查 missing-value path 和 optional/required semantics；它不会直接命令“加默认值”。`Do not apply when` 在步骤竞争 token budget 之前保留。

Procedure lane budget：

```text
procedureTokens = min(200, totalAutomaticContextTokens - activeContextTokens)
```

测试覆盖的 combined 示例：

```text
Working Memory = 900
Procedure lane <= 200
Generic automatic capsule <= 100（仅 automaticRecall=true 时）
Combined <= 1200
```

当 Working Memory 已使用 1,200 tokens 时，procedure lane 是 0 token。

## 8. telemetry 如何证明完整闭环

Sidecar 保留 bounded、最多 256 条的 procedure event ring。事件包含 candidate/family/session/task/revision/timestamp；foreground event 另外包含 memory/rank/score/gate/turn/tokenCost。

测试闭环示例：

```text
procedure.observed
  candidateId=e59f9b882b83d0e558ed26296dd0c9728c51d523a0807cb6c68ac0c628594b34
  familyKey=procedure-family:4e885e9a...
  sessionId=session-a

procedure.outcome_recorded
  sessionId=session-a
  taskEpisodeId=shared-task-id
  evidenceId=verify-a

procedure.outcome_deduped
  sessionId=session-a
  taskEpisodeId=shared-task-id

procedure.qualified
  independent outcomes=3

procedure.promoted
  memoryId=memory:optional-config-procedure

procedure.retrieved
  turnId=turn:4 rank=1 score=42.4 gateDecision=allowed

procedure.selected
  turnId=turn:4 tokenCost=156

procedure.injected
  turnId=turn:4 memoryId=memory:optional-config-procedure
```

Qualification rejection reason 已结构化为：

- `insufficient_outcomes`
- `success_rate`
- `missing_validation_plan`
- `missing_success_evidence`
- `applicability_mismatch`
- `invalid_state`

Promotion rejection 区分 `memory_rejected` 和 `commit_failed`。后台任务仍 fail-open，不会因 telemetry 或未 qualification 而 crash。

## 9. regression tests

新增 8 个 unit tests，并强化 1 个 real Zvec E2E：

1. 三种 surface-different optional config → 同 family → restart dedupe → 三次独立 outcome → qualified → promoted。
2. typed projection 保留 `kind=procedure`。
3. 第四个不同 optional config query 在同仓库新 session 选中 procedure。
4. required config 不匹配 optional family。
5. wrong repository 不召回。
6. typed block <= 200 tokens，Working Memory + procedure combined budget 正确。
7. retired/degraded lifecycle 不进入 procedure lane。
8. retrieved → selected → injected telemetry 可由 family/candidate/memory/turn 关联。
9. Real Zvec E2E 验证 typed MemoryRecord 持久化，并能从新 session 读取。

完整验证结果：

| Check                 | Result                     |
| --------------------- | -------------------------- |
| format / format:check | PASS                       |
| lint                  | PASS                       |
| typecheck             | PASS                       |
| unit                  | PASS — 26 files, 205 tests |
| real Zvec E2E         | PASS — 2 files, 14 tests   |
| build                 | PASS — 14 packages         |
| git diff --check      | PASS                       |

## 10. 仍未解决的问题

- 还没有重新运行真实 Pi Blind Reuse 黑盒测试；本次按要求只完成实现与仓库验证。
- Foreground matcher 第一版只对目标 optional/required config family 做了明确 deterministic signals；其他 procedure domain 仍需后续以真实数据扩展。
- Procedure telemetry 是 bounded sidecar runtime ring，不是跨 sidecar restart 的长期分析仓库；Experience/outcome 本身是 durable 的。
- 系统只证明 procedure 被 retrieved/selected/injected，不自动推断模型是否真正采用。
- 没有迁移旧 Experience 为 typed procedure；旧记录继续兼容为普通 Memory。

当前实现已经准备好重新运行 Blind Reuse 黑盒测试。黑盒判定仍必须依据行为指标改善，而不能只看最终测试通过。
