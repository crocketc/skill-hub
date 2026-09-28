import { useEffect, useRef } from "react";

const journeyPath = "M 95 100 C 155 78 214 68 288 78 S 450 70 530 100 C 605 132 652 185 628 255 C 608 318 550 365 490 354 C 424 344 358 320 288 328 C 207 338 121 399 145 446 C 181 508 332 502 455 525";

export function LifecycleMap({ playing }: { playing: boolean }) {
  const travelerRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    const svg = travelerRef.current;
    if (!svg) return;
    if (playing) svg.unpauseAnimations?.();
    else svg.pauseAnimations?.();
  }, [playing]);

  return (
    <section className="wm-journey" aria-label="Skill 生命周期演示">
      <div className="wm-journey__heading">
        <span>一项 Skill 的完整旅程</span>
        <p>从导入、配置到治理与建议，沿着同一条路径前进</p>
      </div>
      <div className="wm-journey__canvas">
        <div className="wm-journey__halo wm-journey__halo--one" />
        <div className="wm-journey__halo wm-journey__halo--two" />
        <svg className="wm-journey__route" viewBox="0 0 720 620" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <defs>
            <linearGradient id="wm-route-gradient" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#69a878" />
              <stop offset="54%" stopColor="#88b4a0" />
              <stop offset="100%" stopColor="#76a985" />
            </linearGradient>
          </defs>
          <path d={journeyPath} className="wm-journey__route-shadow" />
          <path d={journeyPath} className="wm-journey__route-line" />
          <path d={journeyPath} className="wm-journey__route-current" />
        </svg>

        <ol className="wm-journey__stations">
          <li className="wm-island wm-island--import">
            <span className="wm-island__index">01</span><h3>导入技能</h3><p>来源进入集中库</p>
            <div className="wm-import-motion" aria-hidden="true"><span>⌘</span><i>→</i><b>▤</b><em>已识别</em></div>
          </li>
          <li className="wm-island wm-island--conflict">
            <span className="wm-island__index">02</span><h3>处理冲突</h3><p>同名先比较</p>
            <div className="wm-conflict-motion" aria-hidden="true"><span>文档整理</span><i>≠</i><span>文档整理</span><b>由你选择</b></div>
          </li>
          <li className="wm-island wm-island--graph">
            <span className="wm-island__index">03</span><h3>技能图谱</h3><p>来源与去向连成图</p>
            <div className="wm-graph-motion" aria-hidden="true"><span>Skill</span><i /><b>共享目录</b><i /><span>Agent</span></div>
          </li>
          <li className="wm-island wm-island--agent">
            <span className="wm-island__index">04</span><h3>配置到 Agent</h3><p>按目标类型配置</p>
            <div className="wm-agent-motion" aria-hidden="true"><i>→</i><span>终端</span><span>桌面端</span></div>
          </li>
          <li className="wm-island wm-island--project">
            <span className="wm-island__index">05</span><h3>配置到项目</h3><p>技能进入项目范围</p>
            <div className="wm-project-motion" aria-hidden="true"><span>✦</span><i>→</i><b>▣ 项目空间</b></div>
          </li>
          <li className="wm-island wm-island--governance">
            <span className="wm-island__index">06</span><h3>关系治理</h3><p>关联清晰、可追踪</p>
            <div className="wm-governance-motion" aria-hidden="true"><span>Skill</span><i /><b>共享目录</b><em>已梳理</em></div>
          </li>
          <li className="wm-island wm-island--bundle">
            <span className="wm-island__index">07</span><h3>标签配置与收回</h3><p>成组配置，按需收回</p>
            <div className="wm-bundle-motion" aria-hidden="true"><span>文档</span><span>协作</span><i>⇄</i><b>目标目录</b></div>
          </li>
          <li className="wm-island wm-island--ai">
            <span className="wm-island__index">08</span><h3>AI 辅助管理</h3><p>建议有依据，待你确认</p>
            <div className="wm-ai-motion" aria-hidden="true"><span>✦</span><b>建议归类</b><i>依据可查</i><em>待确认</em></div>
          </li>
        </ol>

        <svg ref={travelerRef} className="wm-journey__traveler" viewBox="0 0 720 620" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <path id="wm-traveler-path" d={journeyPath} fill="none" stroke="none" />
          <g className="wm-journey__tail">
            <circle r="8" />
            <animateMotion dur="16s" repeatCount="indefinite" begin="-0.45s"><mpath href="#wm-traveler-path" /></animateMotion>
          </g>
          <g className="wm-journey__marker">
            <circle className="wm-journey__marker-aura" r="25" />
            <circle className="wm-journey__marker-ring" r="17" />
            <circle className="wm-journey__marker-core" r="12" />
            <text textAnchor="middle" dominantBaseline="central">S</text>
            <animateMotion dur="16s" repeatCount="indefinite"><mpath href="#wm-traveler-path" /></animateMotion>
          </g>
        </svg>
      </div>
      <p className="wm-journey__caption">导入后发现同名冲突，确认处理方式，再把技能配置到目标并持续治理。AI 只提供可核对的建议。</p>
    </section>
  );
}
