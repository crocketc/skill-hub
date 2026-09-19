/**
 * 界面呈现约定（AGENTS.md「路径展示」）的统一格式化入口：
 * 1) 去掉 `\\?\`、`\??\`、`\\?\UNC\` 等 Windows 内部前缀——它们是内核/Win32
 *    调用的实现细节，不属于用户可见路径；
 * 2) 同一目录只按一种斜杠风格展示：Windows 形态路径（盘符或含反斜杠）
 *    统一为反斜杠，POSIX 路径保持正斜杠。
 * 所有面向用户的路径展示位必须经此格式化，不得直接渲染后端/扫描原始串。
 */

/** Windows 盘符形态（`C:\` 或 `C:/`）。 */
const DRIVE_PATH = /^[a-zA-Z]:[\\/]/;

/** `\\?\UNC\server\share` → `\\server\share`。 */
const EXTENDED_UNC_PREFIX = "\\\\?\\UNC\\";
/** `\\?\C:\...`（Win32 文件命名空间前缀）。 */
const EXTENDED_PREFIX = "\\\\?\\";
/** `\??\C:\...`（内核对象管理器形态前缀）。 */
const KERNEL_PREFIX = "\\??\\";

export function displayPath(path: string): string {
  if (!path) return path;
  let value = path.trim();
  if (value.startsWith(EXTENDED_UNC_PREFIX)) {
    value = `\\${value.slice(EXTENDED_UNC_PREFIX.length - 1)}`;
  } else if (value.startsWith(EXTENDED_PREFIX)) {
    value = value.slice(EXTENDED_PREFIX.length);
  } else if (value.startsWith(KERNEL_PREFIX)) {
    value = value.slice(KERNEL_PREFIX.length);
  }
  if (!value) return path;
  const looksWindows = DRIVE_PATH.test(value) || value.includes("\\");
  if (looksWindows) {
    return value.replaceAll("/", "\\");
  }
  return value;
}
