export interface BootstrapState {
  phase: "loading_local";
  locale: string;
}

interface AppProps {
  bootstrap: BootstrapState;
}

export function App({ bootstrap }: AppProps) {
  return (
    <main lang={bootstrap.locale}>
      {bootstrap.phase === "loading_local" && <p>正在读取本地数据</p>}
    </main>
  );
}
