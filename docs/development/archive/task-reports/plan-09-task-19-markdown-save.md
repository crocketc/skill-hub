# Plan09 Task19：Markdown 草稿原生保存

## 状态

已完成，Windows 实现与 macOS 复核均通过，提交为 `417cf49`。

## 已完成内容

- 新增 `SaveMarkdownContent` 命令和 `SavedSkillContent` 结果，不改变原有目录源保存契约。
- 保存请求携带相对 Markdown 路径、草稿文本和读取时的内容身份。
- 原生门面读取集中库当前版本，校验目标文件和身份；检测到外部修改时返回冲突，不覆盖新内容。
- 在临时工作区复制当前版本，只替换目标 Markdown 文件，捕获新版本并更新当前指针与便携清单。
- 便携清单或指针更新失败时恢复旧版本并清理本次新对象；旧版本始终不可变。
- 受管集中库版本的 Markdown 读取投影已允许编辑，编辑器可使用新版本结果刷新内容身份。

## 验证

- Windows：保存内容 facade 1/1、版本切换 1/1；Markdown 前端 7 个文件、38 个测试；Specta bindings、TypeScript、ESLint 通过。
- macOS：提交 `417cf497c4cafba7689fd3547221ae39cd710cfd` 上本地 CI 10/10；前端 60 个测试文件、334 个测试全部通过；保存内容专项 1/1，Markdown 测试 38/38，TypeScript 通过。
- 两端安全审计均为 0 漏洞，生产构建通过；仅有既有依赖和大分块警告。

## 边界与后续

- 当前只允许编辑已纳入集中库的 Markdown 文件；复杂多文件修改、脚本和非 Markdown 内容仍交给外部编辑器。
- CI 构建会删除 `apps/desktop/dist/.gitkeep`；macOS 按只读验证约定仅报告该生成物变化，未提交恢复。
