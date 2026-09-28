import { useState } from "react";
import { WelcomeHero } from "./WelcomeHero";

export function App() {
  const [screen, setScreen] = useState<"welcome" | "setup">("welcome");

  if (screen === "setup") {
    return (
      <main className="wm-setup">
        <button className="wm-setup__back" onClick={() => setScreen("welcome")} type="button">
          <span aria-hidden="true">←</span> 返回欢迎页
        </button>
        <div className="wm-setup__content">
          <p className="wm-setup__eyebrow">SkillHub 初始化</p>
          <h1>选择初始化方式</h1>
          <p>集中库可以通过三种方式开始：新建空库、使用已有集中库，或从备份恢复。</p>
          <div className="wm-setup__choices">
            <button onClick={() => undefined} type="button"><b>新建集中库</b><span>从一个干净的技能库开始</span></button>
            <button onClick={() => undefined} type="button"><b>使用已有集中库</b><span>继续管理已有的技能库</span></button>
            <button onClick={() => undefined} type="button"><b>从备份恢复</b><span>恢复此前保存的 SkillHub 备份</span></button>
          </div>
        </div>
      </main>
    );
  }

  return <WelcomeHero onStart={() => setScreen("setup")} />;
}
