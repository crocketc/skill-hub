# 依赖与供应链策略

本文件是仓库依赖检查的人工审阅记录。依赖安装统一使用锁定文件和
`--ignore-scripts`；本表不会授权执行脚本，只记录为什么某个上游包在依赖图中
声明了安装生命周期脚本。生命周期检查脚本会读取 `pnpm-lock.yaml` 和已安装包的
`package.json`，要求每个 `preinstall`、`install`、`postinstall` 或 `prepare` 都有
精确的包名、版本、脚本类型和理由。新增或升级依赖时必须先补充审阅记录。

当前允许列表为空之外的每一项都必须是明确的包版本；不存在通配符或“全部允许”。

| package | version | lifecycle script | reason |
|---|---|---|---|
| @codemirror/autocomplete | 6.20.3 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/commands | 6.11.0 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/lang-css | 6.3.1 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/lang-html | 6.4.12 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/lang-javascript | 6.2.5 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/lang-markdown | 6.5.2 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/language | 6.12.4 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/lint | 6.9.7 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/search | 6.7.1 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/state | 6.7.1 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/theme-one-dark | 6.1.3 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @codemirror/view | 6.43.9 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @eslint/eslintrc | 3.3.6 | prepare | 上游构建准备脚本；仅作为锁定 ESLint 依赖，安装阶段禁用脚本。 |
| @humanfs/core | 0.19.2 | prepare | 上游构建准备脚本；仅作为锁定 ESLint 依赖，安装阶段禁用脚本。 |
| @humanfs/node | 0.16.8 | prepare | 上游构建准备脚本；仅作为锁定 ESLint 依赖，安装阶段禁用脚本。 |
| @humanfs/types | 0.15.0 | prepare | 上游构建准备脚本；仅作为锁定 ESLint 依赖，安装阶段禁用脚本。 |
| @humanwhocodes/module-importer | 1.0.1 | prepare | 上游构建准备脚本；仅作为锁定 ESLint 依赖，安装阶段禁用脚本。 |
| @humanwhocodes/retry | 0.4.3 | prepare | 上游构建准备脚本；仅作为锁定 ESLint 依赖，安装阶段禁用脚本。 |
| @lezer/common | 1.5.2 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @lezer/css | 1.3.6 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @lezer/highlight | 1.2.3 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @lezer/html | 1.3.13 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @lezer/javascript | 1.5.4 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @lezer/lr | 1.4.10 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @lezer/markdown | 1.7.2 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| @marijn/find-cluster-break | 1.0.4 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| acorn | 8.18.0 | prepare | 上游构建准备脚本；仅作为锁定解析器依赖，安装阶段禁用脚本。 |
| aria-hidden | 1.2.6 | prepare | 上游构建准备脚本；仅作为锁定 UI 依赖，安装阶段禁用脚本。 |
| balanced-match | 4.0.4 | prepare | 上游构建准备脚本；仅作为锁定构建依赖，安装阶段禁用脚本。 |
| brace-expansion | 5.0.9 | prepare | 上游构建准备脚本；仅作为锁定构建依赖，安装阶段禁用脚本。 |
| codemirror | 6.0.2 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| cookie | 1.1.1 | prepare | 上游构建准备脚本；仅作为锁定 UI 依赖，安装阶段禁用脚本。 |
| crelt | 1.0.7 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| dompurify | 3.4.14 | prepare | 上游构建准备脚本；仅作为锁定安全渲染依赖，安装阶段禁用脚本。 |
| echarts | 6.1.0 | prepare | 上游构建准备脚本；仅作为锁定图表依赖，安装阶段禁用脚本。 |
| esbuild | 0.25.12 | postinstall | 上游平台二进制准备脚本；安装阶段禁用脚本，构建环境使用锁定包。 |
| eslint-visitor-keys | 3.4.3 | prepare | 上游构建准备脚本；仅作为锁定 ESLint 依赖，安装阶段禁用脚本。 |
| globals | 14.0.0 | prepare | 上游构建准备脚本；仅作为锁定 ESLint 依赖，安装阶段禁用脚本。 |
| i18next | 26.4.0 | prepare | 上游构建准备脚本；仅作为锁定本地化依赖，安装阶段禁用脚本。 |
| inline-style-parser | 0.2.7 | prepare | 上游构建准备脚本；仅作为锁定 Markdown 依赖，安装阶段禁用脚本。 |
| jsdom | 26.1.0 | prepare | 上游构建准备脚本；仅作为锁定测试依赖，安装阶段禁用脚本。 |
| keyv | 4.5.4 | prepare | 上游构建准备脚本；仅作为锁定测试依赖，安装阶段禁用脚本。 |
| lru-cache | 10.4.3 | prepare | 上游构建准备脚本；仅作为锁定构建依赖，安装阶段禁用脚本。 |
| minimatch | 10.2.6 | prepare | 上游构建准备脚本；仅作为锁定构建依赖，安装阶段禁用脚本。 |
| pathval | 2.0.1 | prepare | 上游构建准备脚本；仅作为锁定测试依赖，安装阶段禁用脚本。 |
| react-i18next | 17.0.12 | prepare | 上游构建准备脚本；仅作为锁定本地化依赖，安装阶段禁用脚本。 |
| rollup | 4.62.5 | prepare | 上游构建准备脚本；仅作为锁定构建依赖，安装阶段禁用脚本。 |
| style-mod | 4.1.3 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| style-to-js | 1.1.21 | prepare | 上游构建准备脚本；仅作为锁定 Markdown 依赖，安装阶段禁用脚本。 |
| style-to-object | 1.0.14 | prepare | 上游构建准备脚本；仅作为锁定 Markdown 依赖，安装阶段禁用脚本。 |
| stylis | 4.4.0 | prepare | 上游构建准备脚本；仅作为锁定 UI 依赖，安装阶段禁用脚本。 |
| tinyexec | 0.3.2 | prepare | 上游构建准备脚本；仅作为锁定构建依赖，安装阶段禁用脚本。 |
| tinyexec | 1.3.0 | prepare | 上游构建准备脚本；仅作为锁定构建依赖，安装阶段禁用脚本。 |
| ts-api-utils | 2.5.0 | prepare | 上游构建准备脚本；仅作为锁定 TypeScript 依赖，安装阶段禁用脚本。 |
| uuid | 14.0.2 | prepare | 上游构建准备脚本；仅作为锁定运行时依赖，安装阶段禁用脚本。 |
| w3c-keyname | 2.2.8 | prepare | 上游构建准备脚本；仅作为锁定编辑器依赖，安装阶段禁用脚本。 |
| whatwg-encoding | 3.1.1 | prepare | 上游构建准备脚本；仅作为锁定测试依赖，安装阶段禁用脚本。 |
| whatwg-url | 14.2.0 | prepare | 上游构建准备脚本；仅作为锁定测试依赖，安装阶段禁用脚本。 |
| zrender | 6.1.0 | prepare | 上游构建准备脚本；仅作为锁定图表依赖，安装阶段禁用脚本。 |

## Rust 依赖策略

- `cargo-deny` 检查 advisories、bans、licenses 和 sources，配置见根目录 `deny.toml`。
- 重复版本和已撤回 crate 先作为可见警告；升级、替换或豁免必须记录理由，不能用无依据的忽略项压制检查。
- 许可证白名单只包含当前依赖图需要且经过审阅的许可证。
