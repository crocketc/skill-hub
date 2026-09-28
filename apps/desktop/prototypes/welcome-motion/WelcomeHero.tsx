import { useEffect, useState } from "react";

const scenes = [
  {
    title: "集中管理技能",
    label: "不同来源的技能汇入集中库，来源信息保留",
    kicker: "统一收纳 · 来源清晰",
    kind: "library",
  },
  {
    title: "看清技能关系",
    label: "技能关联到共享目录，再由不同 Agent 识别",
    kicker: "关系治理 · 去重呈现",
    kind: "graph",
  },
  {
    title: "冲突由你决定",
    label: "发现同名技能后并排比较，等待用户选择",
    kicker: "同名识别 · 安全处理",
    kind: "conflict",
  },
  {
    title: "AI 给出可核对的建议",
    label: "AI 根据技能内容提供管理建议，用户确认后再处理",
    kicker: "AI 辅助管理 · 由你确认",
    kind: "ai",
  },
] as const;

function SceneArt({ kind }: { kind: (typeof scenes)[number]["kind"] }) {
  if (kind === "library") {
    return (
      <div className="wm-art wm-art--library" aria-hidden="true">
        <div className="wm-source wm-source--a"><i>S</i><span><b>GitHub</b><small>代码仓库</small></span></div>
        <div className="wm-source wm-source--b"><i>⌘</i><span><b>本地目录</b><small>个人技能</small></span></div>
        <div className="wm-flow-line wm-flow-line--one" /><div className="wm-flow-line wm-flow-line--two" />
        <div className="wm-window wm-library-window">
          <div className="wm-window__top"><span /><span /><span /><b>我的技能库</b><em>12 项技能</em></div>
          <div className="wm-skill-row"><i className="wm-skill-icon wm-skill-icon--green">✦</i><span><b>文档整理</b><small>来自 GitHub · 已识别</small></span><strong>已收录</strong></div>
          <div className="wm-skill-row"><i className="wm-skill-icon wm-skill-icon--blue">⌘</i><span><b>代码审查</b><small>来自本地目录 · 已识别</small></span><strong>已收录</strong></div>
          <div className="wm-skill-row"><i className="wm-skill-icon wm-skill-icon--amber">✎</i><span><b>会议摘要</b><small>来源与版本可追溯</small></span><strong>已收录</strong></div>
        </div>
        <div className="wm-callout wm-callout--source"><i />来源保留</div>
      </div>
    );
  }
  if (kind === "graph") {
    return (
      <div className="wm-art wm-art--graph" aria-hidden="true">
        <svg className="wm-connectors" viewBox="0 0 720 430"><path d="M220 205 C280 205 285 205 335 205"/><path d="M430 205 C485 205 490 125 535 125"/><path d="M430 205 C485 205 490 285 535 285"/><circle cx="277" cy="205" r="5"/><circle cx="484" cy="165" r="5"/><circle cx="484" cy="245" r="5"/></svg>
        <div className="wm-node wm-node--skill"><i>✦</i><span><b>文档整理</b><small>Skill</small></span></div>
        <div className="wm-node wm-node--shared"><i>▦</i><span><b>共享目录</b><small>技能目录</small></span></div>
        <div className="wm-node wm-node--agent wm-node--codex"><i>C</i><span><b>Codex</b><small>终端</small></span></div>
        <div className="wm-node wm-node--agent wm-node--claude"><i>A</i><span><b>Claude</b><small>桌面端</small></span></div>
        <div className="wm-callout wm-callout--graph"><i />路径与归属一目了然</div>
      </div>
    );
  }
  if (kind === "conflict") {
    return (
      <div className="wm-art wm-art--conflict" aria-hidden="true">
        <div className="wm-conflict-card">
          <div className="wm-conflict-heading"><span className="wm-warning">!</span><div><b>发现同名技能</b><small>先比较内容，再由你选择</small></div><span className="wm-pending">待处理</span></div>
          <div className="wm-compare-grid">
            <div className="wm-compare-item"><small>集中库</small><b>文档整理</b><span>更新于 9 月 24 日</span><em>来源：团队共享</em></div>
            <div className="wm-compare-versus">对比</div>
            <div className="wm-compare-item"><small>新发现</small><b>文档整理</b><span>更新于 9 月 18 日</span><em>来源：本地目录</em></div>
          </div>
          <div className="wm-review-choice"><span>保留两份并分别管理</span><button>选择此方案</button></div>
        </div>
        <div className="wm-callout wm-callout--conflict"><i />不自动覆盖或合并</div>
      </div>
    );
  }
  return (
    <div className="wm-art wm-art--ai" aria-hidden="true">
      <div className="wm-ai-orb"><span>AI</span><i /><b /></div>
      <div className="wm-ai-card">
        <div className="wm-ai-card__head"><span className="wm-ai-spark">✦</span><div><b>管理建议</b><small>基于已读取的技能说明</small></div><span className="wm-ai-label">可选</span></div>
        <div className="wm-ai-suggestion"><span>建议归类</span><b>文档与知识管理</b></div>
        <p>该技能包含文档摘要与格式整理说明，和这类技能用途相符。</p>
        <div className="wm-ai-evidence"><i />依据：技能说明中的功能描述</div>
        <div className="wm-ai-actions"><span>由你确认后再应用</span><button>查看建议</button></div>
      </div>
      <div className="wm-callout wm-callout--ai"><i />建议可追溯、有依据</div>
    </div>
  );
}

export function WelcomeHero({ onStart }: { onStart: () => void }) {
  const [playing, setPlaying] = useState(() => !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  const [sceneIndex, setSceneIndex] = useState(0);
  const scene = scenes[sceneIndex];

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => setSceneIndex((index) => (index + 1) % scenes.length), 2200);
    return () => window.clearInterval(timer);
  }, [playing]);

  return (
    <main className="wm" data-playback={playing ? "playing" : "paused"} data-scene={scene.kind} data-motion-override={playing ? "true" : undefined}>
      <button
        className="wm__playback"
        type="button"
        aria-label={playing ? "暂停动画" : "播放动画"}
        aria-pressed={playing}
        onClick={() => setPlaying((value) => !value)}
      >{playing ? <span className="wm__pause-icon" /> : <span className="wm__play-icon" />}</button>
      <section className="wm__content">
        <a className="wm__brand" href="#welcome" aria-label="SkillHub 欢迎页">
          <span className="wm__brand-mark" aria-hidden="true"><i /><i /><i /></span>SkillHub
        </a>
        <div className="wm__copy">
          <p className="wm__eyebrow">SKILLHUB · 技能管理工作台</p>
          <h1>把分散的技能，<br />整理成清晰可管理的技能库</h1>
          <p className="wm__description">统一收纳、梳理关联、稳妥处理冲突。让每项技能的来源和去向都清楚可见。</p>
          <button className="wm__start" type="button" onClick={onStart}>开始设置 <span aria-hidden="true">→</span></button>
          <div className="wm__principles"><span>由你掌控</span><b /><span>AI 辅助可选</span><b /><span>数据本地管理</span></div>
        </div>
      </section>
      <section className="wm__showcase" aria-label="产品功能演示">
        <div className="wm__showcase-head"><span>产品导览</span><div className="wm__scene-dots" aria-label={`第 ${sceneIndex + 1} 项，共 ${scenes.length} 项`}>{scenes.map((item, index) => <i key={item.kind} className={index === sceneIndex ? "is-active" : ""} />)}</div></div>
        <div key={scene.kind} className="wm__scene">
          <div className="wm__scene-heading"><span>{scene.kicker}</span><h2>{scene.title}</h2></div>
          <div className="wm__art-frame" role="img" aria-label="SkillHub 管理流程动态演示"><SceneArt kind={scene.kind} /></div>
          <p className="wm__scene-caption">{scene.label}</p>
        </div>
        <div className="wm__timeline" aria-hidden="true"><i key={scene.kind} className={playing ? "is-running" : ""} /></div>
      </section>
      <span className="wm__sr-only" aria-live="polite">{scene.title}</span>
    </main>
  );
}
