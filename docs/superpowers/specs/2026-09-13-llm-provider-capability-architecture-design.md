# SkillHub LLM 多供应商能力架构设计

日期：2026-09-13  
状态：待用户审阅  
范围：v0.2.0 发布前的 LLM 供应商配置、请求适配与连接测试整改

## 1. 背景与根因

当前实现用 `LlmProtocolFamily` 同时表达传输协议和供应商行为。`OpenAiCompatible` 下的所有供应商共用同一套 OpenAI Chat 请求，`OpenAiResponses` 下的所有供应商共用同一套 Responses 请求；两者默认强制发送严格 JSON Schema。连接测试又直接执行结构化任务，并将结构化输出失败解释为模型连接失败。

这种模型遗漏了以下事实：

- 相同传输协议的供应商，对 `json_schema`、`json_object`、思考模式和模型列表端点的支持不同。
- 同一供应商可能提供多套彼此独立的产品与协议，例如 GLM 普通 API、GLM Coding Plan，Kimi 开放平台、Kimi Coding Plan。
- 服务可达、凭据及模型可调用、结构化输出可用是三个不同结论。
- 通用 OpenAI-compatible 地址不能仅凭 URL 或显示名称安全推断供应商能力。

因此，继续在协议适配器中按供应商名称添加条件会让错误持续扩散。根因修复必须把传输协议、供应商兼容行为和测试判定拆开。

## 2. 目标与非目标

### 2.1 目标

1. 内置供应商预设显式声明支持的传输协议和结构化输出策略。
2. 运行时只执行配置确定的一种请求策略，不通过失败重试猜测协议。
3. 所有结构化任务最终仍由 SkillHub 本地严格校验，不信任供应商声明。
4. 连接测试分别报告服务可达、模型可调用、结构化输出兼容。
5. 旧配置可无损读取和迁移；密钥引用、供应商 ID、启用状态和默认供应商不变。
6. 设置界面保持简单：内置预设自动带入能力档，用户主要选择产品线和接口格式。
7. 通过契约测试覆盖所有内置预设，不再用“OpenAI-compatible”一个用例代表全部供应商。

### 2.2 非目标

- 不实现 cc-switch 的本地代理、客户端协议接管、流式响应转换、自动路由、熔断或故障切换。
- 不实现按请求自动选择供应商或多模型回退。
- 不把“官方文档声称支持”直接标记为真实服务已验证。
- 不在日志、测试夹具、数据库或文档中保存真实 API Key。
- 不扩展聊天、模型下载、成本管理等 v0.2.0 范围外能力。

## 3. 方案比较

### 方案 A：显式兼容配置档（采用）

供应商配置同时保存传输协议和稳定的兼容配置档。配置档提供结构化输出、推理控制、认证、端点和模型列表策略。内置预设自动选择配置档；自定义供应商使用保守的通用档。

优点：行为确定、可持久化、可测试、不会依赖名称或 URL 猜测，也不会产生额外调用。缺点：新增供应商时必须补能力声明和契约测试。

### 方案 B：按供应商 ID 或 URL 在适配器中判断

实现较快，但用户可修改 ID 和 URL，中转站也可能复用官方地址路径。条件会散落在请求构造、模型列表和连接测试中，无法形成稳定契约，因此不采用。

### 方案 C：运行时自动协商与失败回退

先尝试严格 Schema，失败后尝试 JSON Object，再失败后改用提示词。它会增加延迟和费用，可能重复执行有副作用的语义任务，还会把认证、模型、限流和能力错误混为一谈，因此不采用。

## 4. 领域模型

### 4.1 传输协议

`LlmProtocolFamily` 只描述 HTTP 线协议和基础响应信封：

- `openai_chat`
- `openai_responses`
- `anthropic_messages`
- `gemini_generate_content`
- `azure_openai_chat`

旧序列化值保持兼容读取；若重命名枚举，必须通过 serde alias 和生成绑定完成迁移，不能手改 TypeScript 重复契约。

### 4.2 兼容配置档

新增稳定字段 `compatibility_profile`，它不是用户可随意输入的供应商名称，而是版本化的行为标识。首批配置档覆盖：

- OpenAI
- Anthropic
- Gemini
- Azure OpenAI
- OpenRouter
- DeepSeek
- DashScope/Qwen
- Moonshot 开放平台
- Kimi Coding Plan
- GLM 普通 API
- GLM Coding Plan
- MiniMax
- 火山方舟
- xAI
- Groq
- Mistral
- 百度千帆
- Ollama
- LM Studio
- Generic

同一产品支持多种协议时，配置档不变，传输协议单独选择。例如 DeepSeek 可分别使用 OpenAI Chat、OpenAI Responses 或 Anthropic；GLM Coding Plan 可使用 OpenAI Chat、OpenAI Responses 或 Anthropic。

配置档必须提供：

- `supported_protocols`：允许在界面选择的协议集合。
- `structured_output_strategy`：当前协议下的结构化输出方式。
- `reasoning_policy`：结构化任务是否需要禁用或约束思考输出。
- `model_list_strategy`：模型列表路径、响应解析方式或明确不支持。
- `auth_strategy`：Bearer、`x-api-key`、Gemini Key、Azure `api-key` 或无凭据。
- `endpoint_strategy`：Base URL 如何与模型列表/生成端点安全拼接。

### 4.3 结构化输出策略

结构化输出策略是运行时能力，不等于传输协议：

- `json_schema_strict`：发送供应商原生严格 JSON Schema。
- `json_schema`：发送非 strict Schema。
- `json_object`：请求 JSON Object，Schema 放入系统提示词，返回后本地校验。
- `prompted_json`：不发送供应商结构化字段，通过系统提示词约束，返回后本地校验。
- `gemini_schema`：使用 Gemini 原生 JSON MIME 与 Schema 字段。

无论采用哪一种策略，返回值都必须经过现有任务级解析器与本地 Schema/领域约束校验。Markdown 围栏仅允许一个完整 JSON 围栏；夹带任意说明文字仍失败。

### 4.4 推理控制策略

推理控制只由配置档和协议组合决定，不散落在业务提示词中：

- `provider_default`
- `disable_for_structured`
- `effort_none_for_structured`

例如经真实请求确认的 DeepSeek：OpenAI Chat 结构化任务使用 JSON Object 并关闭 thinking；OpenAI Responses 使用 JSON Object 和 `reasoning.effort = none`。普通文本连通性探测不强制结构化参数。

### 4.5 请求规划器

新增纯函数式 `LlmRequestPlan`：输入为 `LlmProfile + LlmTaskRequest + compatibility policy`，输出为确定的 URL、认证头、请求体、响应提取器和本地校验要求。

协议适配器只负责线协议；兼容配置档只提供策略；业务任务只提供输入、系统约束和目标 Schema。三者不得互相通过供应商 ID、显示名称或 URL 猜测行为。

## 5. 预设与设置界面

### 5.1 内置预设

每个预设必须声明：产品线、兼容配置档、默认协议、可选协议、默认 Base URL、认证要求、模型提示和官方文档。

独立计费体系必须继续作为独立预设，例如：

- GLM 普通 API 与 GLM Coding Plan 分开。
- Kimi 开放平台与 Kimi Coding Plan 分开。
- 同一产品的 OpenAI/Anthropic 接口可以是同一产品线下的接口格式选项；若 API Key 不互通，则仍使用不同产品预设。

选择内置预设后，接口格式下拉框只展示该预设明确支持的协议。切换协议只改变协议和对应策略，不静默覆盖用户已填写的 Base URL、模型或密钥。

“需开启路由”标注全部移除。SkillHub 是直连客户端，不需要用户开启 cc-switch 式代理路由。

### 5.2 自定义配置

自定义配置使用 `Generic` 档，用户选择传输协议和结构化策略。默认采用保守策略：

- OpenAI Chat/Responses：`json_object`。
- Anthropic：`prompted_json`。
- Gemini：`gemini_schema`。

高级策略放在折叠区域，明确说明错误选择可能导致结构化任务失败。应用不根据域名自动升级能力。

## 6. 三层连接测试

“测试此配置”返回三个彼此独立的结果：

1. **服务可达**：目标地址返回任何 HTTP 响应，记录延迟。它不能证明凭据或模型有效。
2. **模型可调用**：使用最小普通文本请求，验证认证、模型名和响应信封；只要求提取到非空模型文本，不要求 JSON。
3. **结构化输出兼容**：按当前兼容配置档执行最小结构化任务，并完成本地 JSON 校验。

判定规则：

- 第一级失败时，不执行后两级。
- 第二级失败时，第三级不执行，并保留准确的认证、模型不存在、限流、超时或协议错误码。
- 第二级成功、第三级失败时，显示“模型可调用”，并显示“结构化输出不可用”。由于 SkillHub 当前四项 AI 能力依赖结构化输出，该配置不得被描述为“AI 功能完全可用”。
- 保存配置不依赖测试成功；用户可以保存尚未验证的配置。
- 结构化探测不执行自动策略回退，避免隐藏配置错误和产生多次计费。

连接报告新增独立的结构化检查结果与失败码。旧的 `model_ok()` 语义改为只表示第二级；新增 `structured_ok()` 和 `task_ready()`，其中 `task_ready()` 要求模型与结构化检查均通过。

## 7. 运行时错误处理

- 请求构造前验证“配置档 + 协议”组合，非法组合返回 `llm.protocol_incompatible`，不发网络请求。
- HTTP 状态继续映射为认证失败、模型不存在、限流、服务端错误等稳定错误码。
- 响应信封无法提取文本时返回协议不兼容；提取到文本但 JSON 或任务 Schema 不合格时返回结构化响应错误。
- 日志只记录脱敏 URL、配置档、协议、策略和错误码，不记录密钥、完整提示词或完整模型输出。
- 连接测试和实际任务共用同一个请求规划器，避免“测试能过、业务请求走另一套构造逻辑”。

## 8. 持久化与向后兼容

供应商配置当前以 JSON 存在 `llm_provider_configs.config_json`，无需增加数据库列。新增字段使用 serde 默认值，旧记录可继续反序列化。

迁移规则：

1. 新配置始终保存显式 `compatibility_profile`。
2. 旧配置读取时仅根据已知的、应用曾生成过的内置预设 ID 映射一次兼容档；未知 ID 一律迁移为 `Generic`，不根据 URL 猜测。
3. 迁移不得改变 endpoint、model、credential reference、custom headers、enabled、默认供应商关系或用户自定义 ID。
4. 保存后写回新字段；迁移必须幂等。

## 9. 测试策略

实现采用 TDD，按以下顺序建立失败测试：

1. 核心领域测试：配置档与协议组合、预设支持协议、旧 JSON 迁移、未知配置回退 Generic。
2. 请求规划契约：每个内置预设至少覆盖 URL、认证、结构化字段、推理控制和响应提取器。
3. 真实问题回归：
   - DeepSeek Chat 不发送 strict JSON Schema，结构化时关闭 thinking。
   - DeepSeek Responses 使用 JSON Object 和 `reasoning.effort = none`。
   - GLM 普通 API 与 Coding Plan 不共用地址或产品档。
   - Kimi 开放平台与 Coding Plan 不共用地址、密钥提示或产品档。
   - Anthropic/Gemini/Azure 不被 OpenAI 通用策略污染。
4. 三层连接测试：服务失败、认证失败、模型失败、普通文本成功但结构化失败、三层全部成功、取消与超时。
5. UI 测试：协议选项按预设约束、无“需开启路由”、三层状态文案和图标、结构化失败不误报模型失败。
6. 存储与应用层测试：草稿、保存记录、凭据覆盖层和运行时 Profile 均保留兼容配置档。
7. 生成 Specta TypeScript 绑定并验证无手工漂移。

外部真实服务验证只使用用户明确提供并授权的凭据，输出不含密钥。当前可验证 DeepSeek、GLM Coding Plan 和 LM Studio；其他供应商在没有凭据时只做官方契约与 mock 验证，并在兼容矩阵中保持“未真实验证”。

## 10. 文档与验收

行为完成后同步更新四份当前开发文档，以及：

- LLM 用户配置与隐私说明：两级连接测试改为三层测试。
- 供应商兼容矩阵：按产品线、协议、结构化策略、真实验证证据重新填写。
- 人工验收清单：只更新已有问题条目的说明和复验入口，不改动结果为空的其他条目。

人工复验至少覆盖：DeepSeek Chat、DeepSeek Responses、GLM Coding Plan、LM Studio、自定义 OpenAI-compatible，以及清除凭据后的状态语义。

## 11. 完成标准

- 不存在通过供应商显示名称或 URL 选择请求行为的代码。
- 同协议不同供应商能产生不同且可解释的结构化请求。
- 连接测试能区分服务、模型和结构化能力，不再把有普通响应的模型误判为完全不可调用。
- 所有内置预设均有独立能力契约，未验证能力不宣传为已支持。
- 相关 Rust/前端测试、格式检查、静态检查、生成绑定和生产构建通过。
- DeepSeek、GLM Coding Plan、LM Studio 的授权真实验证结果与自动化结论一致。
- 变更不影响 LLM 之外的功能模块和 UI。
