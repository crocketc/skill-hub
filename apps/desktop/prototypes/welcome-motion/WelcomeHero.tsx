import { useState, type CSSProperties } from "react";
import "./welcome-motion.css";

interface WelcomeHeroProps {
  onStart: () => void;
}

const sampleSkills = [
  { name: "api-review", source: "代码助手", color: "leaf" },
  { name: "release-notes", source: "项目工具", color: "blue" },
  { name: "api-review", source: "桌面 Agent", color: "clay" },
];

export function WelcomeHero({ onStart }: WelcomeHeroProps) {
  const [isPlaying, setIsPlaying] = useState(() => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const [motionOverride, setMotionOverride] = useState(false);

  return (
    <main className="wm" data-motion-override={motionOverride || undefined} lang="zh-CN">
      <div aria-hidden="true" className="wm__backdrop" />
      <button
        aria-label={isPlaying ? "暂停动画" : "播放动画"}
        aria-pressed={isPlaying}
        className="wm__playback"
        onClick={() => {
          setMotionOverride(true);
          setIsPlaying((playing) => !playing);
        }}
        title={isPlaying ? "暂停动画" : "播放动画"}
        type="button"
      >
        {isPlaying ? <span aria-hidden="true" className="wm__pause-icon" /> : <span aria-hidden="true" className="wm__play-icon" />}
      </button>
      <section className="wm__content" aria-labelledby="wm-title">
        <div aria-label="SkillHub" className="wm__brand">
          <span aria-hidden="true" className="wm__brand-mark"><i /><i /><i /></span>
          <span>SkillHub</span>
        </div>

        <div className="wm__copy">
          <p className="wm__eyebrow">本地技能管理</p>
          <h1 id="wm-title">把分散的技能，<br />整理成清晰可管理的技能库</h1>
          <p className="wm__description">保留来源，理清关系与冲突，按需关联到 Agent 和项目。</p>
          <button className="wm__start" onClick={onStart} type="button">
            开始设置
            <span aria-hidden="true">↗</span>
          </button>
          <p className="wm__principles">本地管理优先 <b /> 操作由你确认 <b /> AI 辅助可选</p>
        </div>
      </section>

      <figure
        aria-label="SkillHub 管理流程动态演示"
        className="wm__demo"
        data-playback={isPlaying ? "playing" : "paused"}
        role="img"
      >
        <figcaption className="wm__sr-only">
          技能从多处汇入技能库，关系逐渐清晰，冲突由你确认，AI 只提供可选建议。
        </figcaption>
        <div className="wm__ambient wm__ambient--one" />
        <div className="wm__ambient wm__ambient--two" />

        <svg aria-hidden="true" className="wm__routes" viewBox="0 0 860 620" preserveAspectRatio="xMidYMid meet">
          <path className="wm__route wm__route--source" d="M120 170 C220 170 228 256 334 265" />
          <path className="wm__route wm__route--target" d="M510 270 C610 270 586 158 711 170" />
          <path className="wm__route wm__route--shared" d="M510 325 C615 325 612 422 742 420" />
          <circle className="wm__route-dot wm__route-dot--a" cx="120" cy="170" r="5" />
          <circle className="wm__route-dot wm__route-dot--b" cx="711" cy="170" r="5" />
        </svg>

        <div className="wm__source-stack" aria-hidden="true">
          {sampleSkills.map((skill, index) => (
            <div
              className={`wm__skill-chip wm__skill-chip--${skill.color}`}
              key={`${skill.name}-${skill.source}`}
              style={{ "--chip-index": index } as CSSProperties}
            >
              <span className="wm__file-glyph" />
              <span><strong>{skill.name}</strong><small>{skill.source}</small></span>
            </div>
          ))}
          <span className="wm__source-caption">不同来源 · 相似名称</span>
        </div>

        <section className="wm__library" aria-hidden="true">
          <header className="wm__panel-head">
            <span className="wm__window-dots"><i /><i /><i /></span>
            <span>技能库</span>
            <span className="wm__library-count">12 项</span>
          </header>
          <div className="wm__library-summary">
            <strong>所有技能，一处管理</strong>
            <span>来源和版本清楚可查</span>
          </div>
          <div className="wm__library-list">
            <div className="wm__library-row"><span className="wm__mini-icon wm__mini-icon--green">A</span><span><b>api-review</b><small>来自代码助手</small></span><em>已整理</em></div>
            <div className="wm__library-row"><span className="wm__mini-icon wm__mini-icon--blue">R</span><span><b>release-notes</b><small>来自项目工具</small></span><em>已整理</em></div>
            <div className="wm__library-row wm__library-row--subtle"><span className="wm__mini-icon wm__mini-icon--clay">A</span><span><b>api-review</b><small>另一份同名内容</small></span><em>待比较</em></div>
          </div>
          <span className="wm__kept-source"><i /> 原始位置仍保留</span>
        </section>

        <section className="wm__agent" aria-hidden="true">
          <div className="wm__agent-logo wm__agent-logo--codex">C</div>
          <span><b>Codex</b><small>终端</small></span>
          <span className="wm__agent-check">✓</span>
        </section>
        <section className="wm__agent wm__agent--second" aria-hidden="true">
          <div className="wm__agent-logo wm__agent-logo--claude">✳</div>
          <span><b>Claude</b><small>桌面端</small></span>
          <span className="wm__agent-check">✓</span>
        </section>

        <section className="wm__graph" aria-hidden="true">
          <div className="wm__graph-heading"><span>关系治理</span><span className="wm__graph-state"><i /> 清晰可查</span></div>
          <div className="wm__graph-flow">
            <div className="wm__graph-node wm__graph-node--skill"><i /> Skill</div>
            <span className="wm__graph-link" />
            <div className="wm__graph-node wm__graph-node--shared"><i />共享目录</div>
            <span className="wm__graph-link" />
            <div className="wm__graph-node wm__graph-node--agent"><i />Agent</div>
          </div>
          <small className="wm__graph-note">一份共享目录，多个识别方</small>
        </section>

        <section className="wm__conflict" aria-hidden="true">
          <div className="wm__conflict-title"><span className="wm__warning-mark">!</span><b>同名内容，先比较再决定</b></div>
          <div className="wm__compare">
            <div><small>代码助手</small><b>api-review</b><span>检查接口变更</span></div>
            <span className="wm__compare-mark">≠</span>
            <div><small>桌面 Agent</small><b>api-review</b><span>生成测试建议</span></div>
          </div>
          <div className="wm__user-choice"><i /> 等待你选择如何处理</div>
        </section>

        <section className="wm__ai" aria-hidden="true">
          <div className="wm__ai-orbit"><span /><i /><b /></div>
          <div className="wm__ai-copy"><span>可选 AI 建议</span><b>这两份技能用途不同</b><small>建议分别保留，最终由你确认</small></div>
          <span className="wm__ai-evidence">依据：用途与内容差异</span>
        </section>

        <span aria-hidden="true" className="wm__demo-caption">从分散，到看清每一段关系</span>
        <div aria-hidden="true" className="wm__timeline"><i /></div>
      </figure>
      <span aria-hidden="true" className="wm__grain" />
    </main>
  );
}
