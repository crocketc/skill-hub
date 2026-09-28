import { useState } from "react";
import { LifecycleMap } from "./LifecycleMap";
import { FirstRunWindowChrome } from "../../src/ui/FirstRunWindowChrome";
import "./welcome-motion.css";

export function WelcomeHero({ onStart }: { onStart: () => void }) {
  const [playing, setPlaying] = useState(true);

  return (
    <main className="wm" data-playback={playing ? "playing" : "paused"} data-motion-override={playing ? "true" : undefined}>
      <FirstRunWindowChrome />
      <button
        className="wm__playback"
        type="button"
        aria-label={playing ? "暂停动画" : "播放动画"}
        aria-pressed={playing}
        onClick={() => setPlaying((value) => !value)}
      >{playing ? <span className="wm__pause-icon" /> : <span className="wm__play-icon" />}</button>
      <section className="wm__content">
        <span className="wm__brand" aria-label="SkillHub 欢迎页">
          <span className="wm__brand-mark" aria-hidden="true"><i /><i /><i /></span>SkillHub
        </span>
        <div className="wm__copy">
          <p className="wm__eyebrow">SKILLHUB · 技能管理工作台</p>
          <h1>让每一项技能，<br />都有清晰的来路与去向</h1>
          <p className="wm__description">从收进技能库，到配置给 Agent 和项目，再到关系治理与 AI 辅助建议，SkillHub 帮你看清整条使用链路。</p>
          <button className="wm__start" type="button" onClick={onStart}>开始设置 <span aria-hidden="true">→</span></button>
          <div className="wm__principles"><span>由你掌控</span><b /><span>AI 辅助可选</span><b /><span>数据本地管理</span></div>
        </div>
      </section>
      <LifecycleMap playing={playing} />
    </main>
  );
}
