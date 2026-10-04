/**
 * K4-B 离开保护桥：编辑器深藏在懒加载 chunk 与 Workspace 内部，而路由拦截
 * （useBlocker）必须挂在数据路由上下文中。本 store 让编辑器登记"有未保存
 * 草稿"状态，路由层守卫经 useSyncExternalStore 读取并在放弃时回调编辑器。
 *
 * 约束：getSnapshot 返回单调递增版本号（稳定值），armed 每次渲染时从注册
 * 表推导，只在 emit 之后可能变化，符合 useSyncExternalStore 的缓存要求。
 */

export interface DraftGuardRegistration {
  /** 放弃草稿：清除未落盘的防抖定时器、抑制自动保存并调用 discardDraft。 */
  abandon: () => void;
  armed: boolean;
  /** 稳定键：`${skillId}:${path}`，同一文件同一时刻只有一个编辑器实例。 */
  key: string;
}

type Listener = () => void;

const registrations = new Map<string, DraftGuardRegistration>();
const listeners = new Set<Listener>();
let version = 0;

const emit = () => {
  version += 1;
  for (const listener of listeners) {
    listener();
  }
};

export const draftGuardStore = {
  abandonArmed(): void {
    for (const registration of [...registrations.values()]) {
      if (registration.armed) {
        registration.abandon();
      }
    }
  },
  armedRegistrations(): DraftGuardRegistration[] {
    return [...registrations.values()].filter(
      (registration) => registration.armed,
    );
  },
  getVersion(): number {
    return version;
  },
  register(registration: DraftGuardRegistration): () => void {
    registrations.set(registration.key, registration);
    emit();
    return () => {
      const existing = registrations.get(registration.key);
      if (existing === registration) {
        registrations.delete(registration.key);
        emit();
      }
    };
  },
  setArmed(key: string, armed: boolean): void {
    const registration = registrations.get(key);
    if (registration && registration.armed !== armed) {
      registration.armed = armed;
      emit();
    }
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
