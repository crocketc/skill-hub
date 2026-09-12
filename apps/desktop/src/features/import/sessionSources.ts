/**
 * M-29：标准导入向导的会话内已选来源。
 *
 * 模块级单例只在本次应用会话内存续——不写 localStorage、不跨重启；
 * 返回上一步/取消/关闭向导后再次进入时已选来源仍然保留，而真正提交
 * 导入才落库。onboarding 变体不经过此存储（其来源由初始化流程注入）。
 */

let sessionSelectedSources: string[] = [];

export function readSessionSelectedSources(): string[] {
  return [...sessionSelectedSources];
}

export function writeSessionSelectedSources(sources: string[]): void {
  sessionSelectedSources = [...new Set(sources)];
}

export function clearSessionSelectedSources(): void {
  sessionSelectedSources = [];
}
