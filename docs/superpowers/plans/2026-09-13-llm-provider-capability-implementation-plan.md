# SkillHub LLM 多供应商能力架构实施计划

日期：2026-09-13
依据：`docs/superpowers/specs/2026-09-13-llm-provider-capability-architecture-design.md`
状态：计划完成，交由其他 Agent 实施
参考源码：`C:\project\cc-switch`，锁定提交 `5a040348`

## 1. 实施目标

把当前“协议枚举决定全部请求行为”的实现改为四层明确契约：

1. 传输协议负责 URL、认证和响应信封。
2. 兼容配置档负责供应商/产品线的能力差异。
3. 结构化输出策略负责 Schema、JSON Object、提示词约束和推理控制。
4. 连接测试分别验证服务可达、模型可调用和结构化输出兼容。

最终必须解决 DeepSeek、GLM、Kimi 等同协议不同能力导致的误判，同时不影响 LLM 之外的功能模块和 UI。

## 2. 编码前红线

- 当前分支为 `codex/acceptance-optimization-2026-09-13`，工作区已有大量人工验收修复，禁止 `git reset --hard`、`git checkout --`、整目录覆盖或清理未跟踪文件。
- 开始前执行 `git status --short`、`git diff --check`，记录已有修改；每个任务只暂存自己确认过的文件。
- `.zcode/`、概览页 `TagDistributionChart*.tsx` 和其他无关改动不属于本计划，不得删除或顺手修改。
- 行为变更严格采用单个纵向切片的红—绿循环：一个失败测试、一个最小实现、相关回归通过后再进入下一切片。
- 不允许通过供应商显示名称、用户可编辑 ID、模型名或 URL 在正常运行时猜测请求策略。旧记录迁移可以根据应用历史上生成的已知预设 ID 做一次性映射；未知记录必须回退 `Generic`。
- 不实现自动协议试错、自动供应商回退或一次任务多次请求。避免重复计费及副作用。
- TypeScript 绑定必须由 `cargo test -p skillhub-desktop generate_bindings` 生成，不得手改重复契约。
- 真实密钥只能从用户明确授权的位置读取到内存；不得打印、写入日志、夹具、文档、数据库或提交。
- 人工验收清单中结果为空的其他条目不得改动。

## 3. 目标模块边界

建议新增以下模块，避免继续把所有供应商条件堆进 `protocol.rs`：

```text
crates/skillhub-core/src/llm/
  compatibility.rs       # 领域枚举、配置档、协议组合校验、旧配置映射
  connection.rs          # 三层连接测试结果
  model.rs               # 运行时 profile 携带兼容档
  provider.rs            # 配置与预设

crates/skillhub-adapters/src/llm/
  request_plan.rs        # Text/Structured 请求规划公开缝隙
  protocol.rs            # 线协议 URL、认证、请求信封、响应文本提取
  http_runner.rs         # 执行计划、错误映射、三层测试编排
```

如果实施者选择不同文件名，必须保持相同职责边界，不能把供应商判断重新塞回 UI 或业务任务。

核心公开测试缝隙：

- `LlmProviderConfig` / `LlmProviderPreset`：持久化和 UI 契约。
- `compatibility_policy(profile, protocol)`：供应商能力单一事实源。
- `plan_request(profile, request, expectation)`：可独立验证的出站请求规划。
- `LlmAdmin::check_connection`：三层连接测试应用边界。
- 设置页 provider draft 与连接报告：用户可见边界。

## 4. 工作流与依赖关系

```text
Task 0 基线保护
  ├─ Task 1 供应商证据台账（可并行研究）
  └─ Task 2 核心领域模型
       → Task 3 预设与旧配置迁移
       → Task 4 请求规划器
            → Task 5A/5B/5C/5D 供应商策略切片
            → Task 6 三层连接测试
                 → Task 7 应用层与生成绑定
                 → Task 8 设置页 UI
                      → Task 9 真实服务验证
                      → Task 10 文档、全量回归与交接
```

Task 1 的资料核验可分给多个 Agent 并行执行；Task 2—8 会修改共享契约，必须按顺序合入。Task 5 的研究和夹具可并行，但最终策略代码由一个集成 Agent 合入，避免多人同时修改注册表和 `protocol.rs`。

## 5. 详细任务

### Task 0：冻结基线并标记现有改动

只读检查：

- `git status --short`
- `git diff --check`
- `git log -5 --oneline`
- 阅读 `README.md` 和四份 `docs/development/*-2026-09-13.md` 当前文档。
- 阅读本设计与本计划。

交付证据：

- 在任务报告中列出开始提交、分支、已有修改和本任务明确不碰的文件。
- 不产生源码提交。

完成条件：实施 Agent 能区分已有人工验收改动与自己后续新增的 LLM 架构改动。

### Task 1：建立四层供应商证据台账

目标文件：

- `docs/llm/供应商兼容矩阵-2026-09-10.md`（最终合入时更新日期或按项目文档规则形成新快照）
- 可在任务分支临时使用不提交的研究笔记，但最终结论必须进入兼容矩阵。

并行研究分组：

- 1A 国外官方：OpenAI、Anthropic、Gemini、Azure OpenAI、xAI、Groq、Mistral。
- 1B 国内官方：DeepSeek、DashScope/Qwen、Moonshot、Kimi Coding、GLM、GLM Coding、MiniMax、火山方舟、百度千帆。
- 1C 聚合/中转：OpenRouter，以及计划范围内的知名中转站；中转站必须作为独立配置档，不能继承底层模型厂商方言。
- 1D 本地：Ollama、LM Studio，包括 loopback、私网和链路本地 HTTP 地址。

每个产品线记录：

- cc-switch 提交、文件、行号。
- 官方文档 URL 与核验日期。
- 产品线和 Key 是否互通。
- 支持协议、默认 Base URL、完整 endpoint 拼接规则。
- 认证头、模型列表端点及响应形状。
- 结构化输出形态、strict 支持、推理/思考控制参数。
- 普通文本与结构化输出是否完成 SkillHub 真实验证。
- 冲突项及采用结论；官方当前契约优先于 cc-switch 旧预设。

必须核对的 cc-switch 入口：

- `src/config/claudeProviderPresets.ts`
- `src/config/codexProviderPresets.ts`
- `src/config/piProviderPresets.ts`
- `src/config/openclawProviderPresets.ts`
- `src-tauri/src/proxy/providers/adapter.rs`
- `src-tauri/src/proxy/providers/claude.rs`
- `src-tauri/src/proxy/providers/codex.rs`
- `src-tauri/src/proxy/forwarder.rs`
- `src-tauri/src/proxy/providers/transform_codex_chat_moonshot_schema.rs`
- `docs/user-manual/zh/4-proxy/4.5-model-test.md`

禁止结论：

- 不得因为 cc-switch 有预设就写“已验证”。
- 不得把 cc-switch 的短文本 Stream Check 当成结构化输出证据。
- 不得直接复制可能过时的模型名，例如旧 DeepSeek alias。

验证：文档中的每个“支持”结论都至少有官方文档或真实请求证据；每个 cc-switch 结论都带精确行号。

提交检查点：`Document LLM provider compatibility evidence`

### Task 2：新增兼容配置档领域模型

修改文件：

- 新增 `crates/skillhub-core/src/llm/compatibility.rs`
- `crates/skillhub-core/src/llm/mod.rs`
- `crates/skillhub-core/src/llm/model.rs`
- `crates/skillhub-core/src/llm/provider.rs`
- `crates/skillhub-core/tests/llm_provider_domain.rs`

先写失败测试：

1. `LlmCompatibilityProfile` 可稳定 serde 往返，至少覆盖设计规格列出的全部配置档和 `Generic`。
2. `LlmStructuredOutputStrategy` 覆盖 strict Schema、Schema、JSON Object、Prompted JSON、Gemini Schema。
3. `LlmReasoningPolicy` 覆盖默认、结构化时关闭 thinking、结构化时 effort none。
4. `LlmProviderConfig` 和 `LlmProfile` 显式携带兼容档；默认构造为 `Generic`，不根据 endpoint 猜测。
5. 配置档与协议非法组合在 profile 构造阶段返回 `llm.protocol_incompatible`，且测试证明没有网络调用机会。
6. `Generic` 允许用户明确选择结构化策略覆盖；内置配置档拒绝不受支持的任意覆盖，或明确限定覆盖边界。

最小实现：

- 新增上述枚举和一个只读 `LlmCompatibilityPolicy` 值对象。
- `LlmProviderConfig` 增加 `compatibility_profile` 和可选 `structured_output_override`。
- `LlmProfile` 携带相同字段。
- `to_profile()`、`to_model_listing_profile()` 完整传递新字段。
- 保持现有 `LlmProtocolFamily` serde 值兼容；本任务不急于重命名旧枚举，避免无价值迁移。

验证命令：

```powershell
cargo test -p skillhub-core --test llm_provider_domain
cargo fmt --all -- --check
```

提交检查点：`Add explicit LLM compatibility profiles`

### Task 3：让预设声明能力并迁移旧配置

修改文件：

- `crates/skillhub-core/src/llm/provider.rs`
- `crates/skillhub-core/src/llm/compatibility.rs`
- `crates/skillhub-core/tests/llm_provider_domain.rs`
- `crates/skillhub-storage/src/database/llm_provider_repository.rs`
- `crates/skillhub-storage/tests/llm_provider_repository.rs`

预设至少覆盖当前 24 个 ID：

```text
openai, anthropic, google-gemini, azure-openai, openrouter,
deepseek, deepseek-anthropic, alibaba-dashscope, moonshot-kimi,
kimi-code-openai, kimi-code-anthropic, zhipu-glm,
zhipu-glm-coding-chat, zhipu-glm-coding-anthropic, minimax,
volcengine-doubao, xai-grok, groq, mistral, baidu-qianfan,
baidu-qianfan-anthropic, ollama, lm-studio,
custom-openai-compatible
```

先写失败测试：

1. 每个预设有兼容档、默认协议和非空 `supported_protocols`。
2. 默认协议必须属于支持协议集合。
3. GLM 普通 API、GLM Coding Plan；Kimi 开放平台、Kimi Coding Plan 使用不同产品档。
4. DeepSeek 的协议集合由 Task 1 证据决定，不能由当前单个预设的协议反推。
5. 旧 JSON 缺少兼容字段时可读取。
6. 已知旧预设 ID 迁移到正确档；未知 ID 回退 Generic；任何 endpoint、model、credential reference、headers、enabled 均不变化。
7. 迁移幂等；保存一次后 JSON 中存在显式兼容字段。

最小实现：

- `LlmProviderPreset` 增加 `compatibility_profile`、`supported_protocols`。
- 提供单一 `legacy_profile_for_builtin_id()`，仅用于旧记录归一化。
- repository 解码后调用归一化；不根据 URL、label、model 推断。
- 旧记录无需新增 SQLite 列，继续存于 `config_json`。

验证命令：

```powershell
cargo test -p skillhub-core --test llm_provider_domain
cargo test -p skillhub-storage --test llm_provider_repository
```

提交检查点：`Persist provider compatibility policies`

### Task 4：建立统一请求规划器

修改文件：

- 新增 `crates/skillhub-adapters/src/llm/request_plan.rs`
- `crates/skillhub-adapters/src/llm/mod.rs`
- `crates/skillhub-adapters/src/llm/protocol.rs`
- `crates/skillhub-adapters/src/llm/http_runner.rs`
- `crates/skillhub-adapters/tests/llm_protocol_contract.rs`

公开契约建议：

```rust
enum ResponseExpectation {
    Text,
    Structured { schema: serde_json::Value },
}

struct LlmRequestPlan {
    url: String,
    headers: Vec<(String, String)>,
    body: serde_json::Value,
    response_extractor: LlmResponseExtractor,
    expectation: ResponseExpectation,
}
```

先写失败测试：

1. 同为 OpenAI Chat 的 OpenAI 与 DeepSeek，在结构化字段和 reasoning 参数上产生不同计划。
2. Text 计划不携带 `response_format`、JSON Schema 或结构化提示词，只要求非空文本。
3. Structured 计划依据兼容策略选择 strict Schema、JSON Object、Prompted JSON 或 Gemini Schema。
4. URL 与认证仍由协议适配器决定；兼容配置档不得复制 Bearer/x-api-key 拼装。
5. 响应先由协议提取为文本，再按 expectation 解析；“信封不兼容”和“文本不是合法结构化 JSON”返回不同错误码。
6. 请求计划中不得出现密钥日志值。

最小实现：

- 把 `protocol.rs` 中当前固定 strict JSON Schema 的请求构造拆成协议信封 + 策略应用。
- `http_runner` 只执行 `LlmRequestPlan`，不再自行判断供应商。
- 现有业务 `run()` 一律使用 Structured expectation；连接测试可使用 Text expectation。
- 保留本地任务级严格校验和完整 fenced JSON 兼容规则。

验证命令：

```powershell
cargo test -p skillhub-adapters --test llm_protocol_contract
cargo test -p skillhub-adapters --test llm_runner_contract
```

提交检查点：`Plan LLM requests from protocol and capability`

### Task 5A：实现 OpenAI、Azure、Anthropic、Gemini 基线

修改文件：

- `crates/skillhub-core/src/llm/compatibility.rs`
- `crates/skillhub-adapters/src/llm/request_plan.rs`
- `crates/skillhub-adapters/src/llm/protocol.rs`
- 两个 adapter contract 测试文件

失败测试与最低行为：

- OpenAI Chat/Responses 按官方能力发送结构化字段。
- Azure 保留 deployment-scoped URL、`api-key` 和 API version，不误用普通 OpenAI URL。
- Anthropic Messages 使用自己的认证、消息信封和经 Task 1 确认的结构化策略。
- Gemini 使用 `responseMimeType` 与原生 Schema，不把 OpenAI `response_format` 发给 Gemini。

提交检查点：`Add first party LLM request policies`

### Task 5B：实现 DeepSeek、GLM、Kimi 回归切片

这是本轮最高优先级，必须逐供应商写独立测试，不能用参数化测试隐藏差异。

失败测试：

- DeepSeek Chat：结构化任务不发送 strict JSON Schema；发送 JSON Object；关闭 thinking。
- DeepSeek Responses：发送 JSON Object；`reasoning.effort = none`；能从 reasoning + message 的 output 数组中提取最终 `output_text`。
- DeepSeek Text 探测：不要求 JSON，任何非空最终文本即模型可调用。
- GLM 普通 API 与 Coding Plan 地址、产品档和协议集合分开。
- GLM Coding Chat、Responses、Anthropic 分别使用其官方 Base URL，不把 `/responses` 拼到 `/paas/v4`。
- Kimi 开放平台与 Coding Plan Key/产品提示分开；Chat 与 Anthropic 请求走各自端点。
- Moonshot/Kimi 的 Schema 方言差异若影响 SkillHub 当前任务 Schema，采用最小供应商策略并添加回归；不要复制与 Codex tool schema 无关的 cc-switch 改写。
- 返回 Markdown fenced JSON 可解析；夹带说明文字不可解析。

真实问题基线：

- 用户授权 DeepSeek 实测已证明：Responses + `json_object` + `reasoning.effort=none` 返回可解析 `{"ok":true}`。
- 用户授权 GLM Coding Plan 和 LM Studio 已有真实连通证据；实施后必须从应用同一路径复验。

验证命令：

```powershell
cargo test -p skillhub-adapters --test llm_protocol_contract deepseek
cargo test -p skillhub-adapters --test llm_protocol_contract glm
cargo test -p skillhub-adapters --test llm_protocol_contract kimi
cargo test -p skillhub-adapters --test llm_runner_contract
```

提交检查点：`Handle DeepSeek GLM and Kimi capabilities`

### Task 5C：实现其余官方直连供应商

范围：DashScope/Qwen、MiniMax、火山方舟、xAI、Groq、Mistral、百度千帆。

每个供应商至少一个独立请求计划测试，断言：

- 精确协议和 endpoint。
- 精确认证方式。
- Task 1 证据确认的结构化策略。
- 推理字段是平台级策略，不根据模型名注入厂商方言。
- 模型列表明确为支持、候选路径或不支持；不伪造成功。

特别防回归：同一个 GLM/DeepSeek/MiniMax 模型经聚合平台调用时，使用聚合平台配置档，不使用模型厂商官方参数。

提交检查点：`Add direct provider capability contracts`

### Task 5D：实现 OpenRouter、本地服务和 Generic

范围：OpenRouter、Ollama、LM Studio、Generic。

失败测试：

- OpenRouter 采用平台自身 reasoning/结构化规则，不按底层模型名猜测。
- Ollama 默认 `http://127.0.0.1:11434/v1`，LM Studio 默认 `http://127.0.0.1:1234/v1`。
- Local 部署允许 loopback、RFC1918、IPv4/IPv6 link-local HTTP；Online 仍要求 HTTPS。
- LM Studio 用户给出的 `http://169.254.83.107:1234` 继续通过本地地址校验。
- Generic 不根据域名识别厂商；同一 URL 改变显示名不改变计划。
- Generic 的高级结构化策略覆盖能产生对应请求，并保存到配置。

提交检查点：`Support local and generic LLM policies`

### Task 6：把连接测试拆成三层

修改文件：

- `crates/skillhub-core/src/llm/connection.rs`
- `crates/skillhub-core/src/llm/task.rs`
- `crates/skillhub-adapters/src/llm/http_runner.rs`
- `crates/skillhub-adapters/tests/llm_runner_contract.rs`
- 受 trait fake 影响的 application 测试

目标结构：

- `endpoint: EndpointCheckResult`
- `model: Option<ModelCheckResult>`
- `model_failure_code: Option<String>`
- `structured: Option<StructuredCheckResult>`
- `structured_failure_code: Option<String>`

先写失败测试：

1. endpoint 不可达：model/structured 均不执行。
2. endpoint 可达但 401：model 失败，structured 不执行。
3. 普通文本有响应、结构化失败：model 成功，structured 失败。
4. 三层成功：`model_ok()`、`structured_ok()`、`task_ready()` 均符合定义。
5. Text 探测接受非空普通文字，不再强制 `{"ok":true}`。
6. Structured 探测与实际任务共用请求规划器。
7. 取消、超时、429、404 和协议信封错误保留准确错误码。
8. 不进行结构化策略自动回退；mock 服务断言只有预期请求次数。

最小实现：

- 模型层执行低 token 的 Text 请求。
- 结构化层执行最小 Structured 请求并本地验证 `ok: boolean`。
- 三层各自记录延迟；结构化失败不覆盖 model 成功。

验证命令：

```powershell
cargo test -p skillhub-adapters --test llm_runner_contract connection
cargo test -p skillhub-application --test facade_llm_admin
```

提交检查点：`Report three LLM connection levels`

### Task 7：贯通应用层、草稿凭据与生成绑定

修改文件：

- `crates/skillhub-application/src/lib.rs`
- `crates/skillhub-application/tests/facade_llm_admin.rs`
- `apps/desktop/src-tauri/src/lib.rs`
- 生成 `apps/desktop/src/api/bindings.ts`
- `apps/desktop/src/features/settings/llmApi.ts`
- `apps/desktop/src/features/settings/llmApi.test.ts`

先写失败测试：

- 新增、编辑、获取模型列表、测试草稿和测试已保存配置都保留 compatibility profile。
- 草稿 API Key 仍只存在内存覆盖层，不进入 provider JSON。
- 清除凭据不改变 enabled；测试时准确返回 credential 未配置。
- 旧配置经 facade 列出时带迁移后的兼容档。
- 模型字段为空时仍可获取模型列表，普通保存仍要求模型。

生成绑定：

```powershell
cargo test -p skillhub-desktop generate_bindings -- --nocapture
cargo test -p skillhub-desktop
```

生成后检查 `bindings.ts` 只包含生成差异，禁止手工修补类型。

提交检查点：`Carry LLM capability profiles through desktop API`

### Task 8：调整设置页协议选项与三层状态

修改文件：

- `apps/desktop/src/features/settings/LlmProvidersSettings.tsx`
- `apps/desktop/src/features/settings/ConnectionReportList.tsx`
- `apps/desktop/src/features/settings/LlmProviderRow.tsx`
- `apps/desktop/src/features/settings/LlmProvidersSettings.test.tsx`
- `apps/desktop/src/i18n/zh-CN/common.json`
- `apps/desktop/src/i18n/en-US/common.json`
- 必要的 settings CSS；不得全局改 UI

用户行为：

- 选内置预设后，接口格式下拉框只显示 `supported_protocols`。
- 切换格式不改已填写的 Base URL、模型和密钥。
- 彻底移除“需开启路由”字样。
- Generic 显示折叠的结构化策略高级选项；内置预设隐藏实现细节。
- 测试报告显示“服务可达”“模型可调用”“结构化输出兼容”三行。
- model 成功、structured 失败时，不显示“模型协议不兼容”；显示结构化能力警告。
- 保存配置不要求测试成功。
- 清除凭据后保留“已启用”，凭据状态显示“未配置”；原“在线”如保留必须表达部署类型而非健康状态，建议文案改为“云端”。

先写失败测试：

- DeepSeek 只显示证据确认的格式。
- GLM 普通/Coding、Kimi 开放/Coding 不混用协议选项和说明。
- 自定义配置可选择显式结构化策略。
- 三层状态图标和文字不只依赖颜色。
- 清除凭据后的状态组合正确。
- 原有 drawer、键盘、取消、编辑和模型列表行为不回归。

验证命令：

```powershell
pnpm --dir apps/desktop test -- LlmProvidersSettings
pnpm --dir apps/desktop test -- ConnectionReportList
pnpm --dir apps/desktop check
```

提交检查点：`Expose provider capabilities and structured checks`

### Task 9：执行授权真实服务验证

测试对象：

- DeepSeek：用户已授权使用 `test_key.txt` 中 DeepSeek Key。
- GLM Coding Plan：用户已说明 `test_key.txt` 第一行 `glm:` 开头为 Coding Plan Key。
- LM Studio：`http://169.254.83.107:1234`，无 Key，模型 `qwen3.5-4b`。

每个对象从最终应用调用路径验证：

1. 获取模型列表；供应商无此契约时确认失败提示允许手填。
2. 服务可达。
3. 普通文本模型调用成功。
4. 按配置档的结构化探测成功。
5. 保存后重新打开，配置档、协议和模型不漂移。
6. 清除凭据后，模型测试返回凭据错误，启用状态不伪装成健康状态。

安全要求：

- 命令和测试输出不得出现 Key；不得把响应全文写入仓库。
- 只记录 HTTP 状态、耗时、模型、协议、策略、是否成功和脱敏错误码。
- 真实验证失败必须回到对应契约层定位，不得临时改 prompt 掩盖。

若没有其他供应商凭据：保持“契约通过、真实未验证”，不得推断通过。

提交检查点：真实验证本身不提交凭据或临时脚本；只在文档任务中提交脱敏结论。

### Task 10：文档同步、全量回归与交接

修改文件：

- `docs/llm/用户配置与隐私说明-2026-09-10.md`（按规则更新快照日期/引用）
- `docs/llm/供应商兼容矩阵-2026-09-10.md`（按规则更新快照日期/引用）
- `docs/development/开发状态-2026-09-13.md`
- `docs/development/自动化测试说明-2026-09-13.md`
- `docs/development/功能完成度与验收状态矩阵-2026-09-13.md`
- `docs/development/人工验收清单-2026-09-13.md`，仅更新相关已有条目的说明和复验入口
- 必要的 README LLM 简介

文档必须写清：

- 三层连接测试语义。
- 每个供应商产品线、协议、结构化策略和四层证据状态。
- cc-switch 只作为参考实现证据，不等同于 SkillHub 已支持。
- 真实验证与未验证边界。
- 清除凭据、启用状态、云端/本地部署标签的含义。

最终验证：

```powershell
cargo fmt --all -- --check
cargo test -p skillhub-core --test llm_provider_domain
cargo test -p skillhub-storage --test llm_provider_repository
cargo test -p skillhub-adapters --test llm_protocol_contract
cargo test -p skillhub-adapters --test llm_runner_contract
cargo test -p skillhub-application --test facade_llm_admin
cargo test -p skillhub-desktop generate_bindings -- --nocapture
cargo test -p skillhub-desktop
pnpm --dir apps/desktop test -- LlmProvidersSettings
pnpm --dir apps/desktop check
pnpm --dir apps/desktop build
git diff --check
```

相关检查全绿后再运行仓库完整本地 CI：

```powershell
.\scripts\ci-local.ps1
```

提交检查点：`Document and verify LLM provider compatibility`

## 6. 多 Agent 分派建议

### 研究 Agent A：国外官方与 OpenRouter

只读 cc-switch 与官方文档，交付 Task 1A/1C 的证据表。不得修改 Rust/React 源码。

### 研究 Agent B：国内官方与 Coding Plan

只读 cc-switch 与官方文档，重点核验 DeepSeek、GLM、Kimi、MiniMax、DashScope、火山、千帆。交付 Task 1B 证据表。不得使用真实 Key。

### 研究 Agent C：本地服务

核验 Ollama、LM Studio 的端点、无 Key 行为、模型列表和结构化能力。只交付证据与 mock 用例建议。

### 核心实现 Agent

串行执行 Task 2—4，建立稳定领域与请求规划接口。完成前不让其他 Agent 直接改这些共享文件。

### 供应商策略 Agent

在核心接口合入后执行 Task 5A—5D。可以分支并行写独立测试/夹具，但由一个 Agent 统一修改策略注册表并解决冲突。

### 连接/UI Agent

Task 6—8 必须在请求规划器稳定后执行。前端 Agent 不自行重建供应商能力表，只消费生成绑定。

### 集成验收 Agent

执行 Task 9—10，核对真实服务结果、四份当前文档和完整 CI，不修无关模块。

## 7. 每个任务的统一交接格式

每个 Agent 完成后必须报告：

1. 修改文件。
2. 首个失败测试及失败原因。
3. 最小实现说明。
4. 验证命令与通过数量。
5. 提交哈希。
6. 未验证供应商和残余风险。
7. 是否触碰开始时已有的未提交改动。

禁止只写“已完成”或“测试通过”。真实服务、mock 契约和文档核验必须分开报告。

## 8. 发布阻塞条件

出现以下任一情况，不得宣称本轮完成：

- 仍由 `OpenAiCompatible` 固定发送 strict JSON Schema。
- 仍按 label、model 或 URL 在正常请求路径猜供应商策略。
- 测试按钮仍把结构化失败显示成模型完全不可调用。
- DeepSeek Chat/Responses、GLM Coding Plan、Kimi 产品线仍共用未经区分的请求策略。
- 内置预设存在没有独立契约测试的能力声明。
- 生成绑定有手工漂移。
- 真实 Key 出现在日志、diff、测试输出或文档中。
- 四份当前开发文档未同步，或误改人工验收清单中结果为空的其他条目。

## 9. 最终人工复验入口

实施完成后请用户重点复验：

1. DeepSeek OpenAI Chat。
2. DeepSeek OpenAI Responses。
3. GLM Coding Plan OpenAI Chat/Responses。
4. LM Studio 链路本地 HTTP。
5. Generic OpenAI-compatible 自定义策略。
6. 模型有普通响应但结构化失败时的三层状态。
7. 清除凭据后“云端/本地、已启用、未配置凭据”的状态组合。
8. 切换接口格式不会覆盖已填写地址、模型或密钥。
