// Hero — animated terminal showing a real Jupiter coding session

// Based on the actual jupiter code TUI: cache-first loop, SEARCH/REPLACE edits,
// tool calls sandboxed to launch dir.
const buildTermScript = (version) => [
  { t: 'cmd', text: 'npx jupiter code' },
  { t: 'out', text: `⏺ jupiter ${version} · model: deepseek-v4-flash · workspace: ~/app`, cls: 'term-info', delay: 280 },
  { t: 'out', text: '⏺ cache: 94.2% hit · session: 18m23s · cost: $0.043', cls: 'term-dim', delay: 220 },
  { t: 'blank' },
  { t: 'cmd', text: 'fix the case-sensitivity bug in findByEmail' },
  { t: 'out', text: '▸ tool<search_files>  → src/users.ts, src/users.test.ts', cls: 'term-dim', delay: 260 },
  { t: 'out', text: '▸ tool<read_file>     → src/users.ts (412 chars)', cls: 'term-dim', delay: 220 },
  { t: 'out', text: '▸ thinking …  reasoning on  · /effort high', cls: 'term-info', delay: 280 },
  { t: 'out', text: 'src/users.ts', cls: 'term-warn', delay: 180 },
  { t: 'out', text: '<<<<<<< SEARCH', cls: 'term-dim', delay: 80 },
  { t: 'out', text: '  return users.find(u => u.email === email);', delay: 80 },
  { t: 'out', text: '=======', cls: 'term-dim', delay: 80 },
  { t: 'out', text: '  const needle = email.toLowerCase();', cls: 'term-ok', delay: 80 },
  { t: 'out', text: '  return users.find(u => u.email.toLowerCase() === needle);', cls: 'term-ok', delay: 80 },
  { t: 'out', text: '>>>>>>> REPLACE', cls: 'term-dim', delay: 80 },
  { t: 'out', text: '▸ 1 pending edit · /apply to write · /discard to drop', cls: 'term-info', delay: 240 },
  { t: 'blank' },
  { t: 'cmd', text: '/apply' },
  { t: 'out', text: '✓ wrote src/users.ts · 2 lines changed', cls: 'term-ok', delay: 200 },
  { t: 'out', text: '✓ npm test users  · 14 passed · 0 failed (3.1s)', cls: 'term-ok', delay: 220 },
];

function Terminal() {
  const { version: rxVersion, status: rxStatus } = useVersion();
  const versionLabel = rxStatus === "ok" && rxVersion ? rxVersion : "…";
  const TERM_SCRIPT = React.useMemo(() => buildTermScript(versionLabel), [versionLabel]);
  // Animation closure reads through this ref so a late version arrival
  // updates the next loop without restarting mid-typewriter.
  const scriptRef = React.useRef(TERM_SCRIPT);
  scriptRef.current = TERM_SCRIPT;

  const [lines, setLines] = React.useState([]);
  const [typing, setTyping] = React.useState('');
  const stepRef = React.useRef(0);
  const charRef = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    let timer;

    const run = () => {
      if (cancelled) return;
      const script = scriptRef.current;
      const i = stepRef.current;
      if (i >= script.length) {
        timer = setTimeout(() => {
          if (cancelled) return;
          stepRef.current = 0;
          charRef.current = 0;
          setLines([]);
          run();
        }, 3600);
        return;
      }
      const step = script[i];
      if (step.t === 'cmd') {
        const text = step.text;
        if (charRef.current < text.length) {
          setTyping(text.slice(0, charRef.current + 1));
          charRef.current += 1;
          timer = setTimeout(run, 22 + Math.random() * 28);
        } else {
          setLines(prev => [...prev, { ...step, text }]);
          setTyping('');
          charRef.current = 0;
          stepRef.current += 1;
          timer = setTimeout(run, 380);
        }
      } else if (step.t === 'blank') {
        setLines(prev => [...prev, step]);
        stepRef.current += 1;
        timer = setTimeout(run, 240);
      } else {
        setLines(prev => [...prev, step]);
        stepRef.current += 1;
        timer = setTimeout(run, step.delay || 180);
      }
    };

    timer = setTimeout(run, 600);
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return (
    <div className="terminal" role="presentation" aria-hidden="true">
      <div className="term-head">
        <div className="term-dots"><i></i><i></i><i></i></div>
        <span className="term-title">~/app  ·  jupiter code</span>
        <div className="term-tabs">
          <span className="term-tab on">session</span>
          <span className="term-tab">events</span>
          <span className="term-tab">+</span>
        </div>
      </div>
      <div className="term-body">
        {lines.map((l, i) => {
          if (l.t === 'blank') return <div key={i} className="term-line">&nbsp;</div>;
          if (l.t === 'cmd') {
            return (
              <div key={i} className="term-line">
                <span className="term-prompt-user">›</span>
                <span className="term-cmd">{l.text}</span>
              </div>
            );
          }
          return (
            <div key={i} className={'term-line ' + (l.cls || '')}>{l.text}</div>
          );
        })}
        {typing !== '' ? (
          <div className="term-line">
            <span className="term-prompt-user">›</span>
            <span className="term-cmd">{typing}</span>
            <span className="cursor"></span>
          </div>
        ) : (
          lines.length > 0 && stepRef.current < TERM_SCRIPT.length && (
            <div className="term-line"><span className="term-prompt-user">›</span><span className="cursor"></span></div>
          )
        )}
      </div>
    </div>
  );
}

function Hero() {
  const { lang } = useLang();
  const { version: rxVersion, status: rxStatus } = useVersion();
  const rxBadge =
    rxStatus === "ok" && rxVersion
      ? `v${rxVersion} · open source`
      : t({ zh: "正在获取版本…", en: "fetching version…" }, lang);
  return (
    <section className="hero" id="top">
      <div className="hero-head">
        <span>§00 · Jupiter</span>
        <span className="rule"></span>
        <span className="v">{rxBadge}</span>
      </div>
      <div className="hero-grid">
        <div>
          {lang === 'en' ? (
            <h1>
              A <em>cache-first</em><br/>
              AI workbench,<br/>
              for real coding tasks.
            </h1>
          ) : (
            <h1>
              省钱缓存优先的<br/>
              <em>AI 工作台</em>，<br/>
              面向真实工程任务。
            </h1>
          )}
          <p className="lede">
            {t({
              zh: <>Jupiter 覆盖仓库理解、跨文件编辑、终端执行、测试验证、diff 审查、Git/PR 辅助、MCP 工具、Skills、浏览器验证和远程消息通道，同时加入独特的 DeepSeek 缓存机制、工作区资料库和顶栏标签页。</>,
              en: <>Jupiter covers repository understanding, cross-file edits, terminal execution, test verification, diff review, Git/PR assistance, MCP tools, Skills, browser verification, and remote channels, then adds DeepSeek-aware caching, workspace libraries, and top-bar tabs.</>,
            }, lang)}
          </p>
          <div className="hero-actions">
            <a className="btn btn-primary" href="#install">
              {t({ zh: '立即开始 →', en: 'Get started →' }, lang)}
            </a>
            <a className="btn btn-ghost" href="download.html">
              {t({ zh: '下载桌面端', en: 'Download desktop' }, lang)}
            </a>
          </div>
          <div className="hero-stats">
            <div className="hero-stat"><b>94<span className="metric-unit">%</span></b><span className="metric-label">Cache Hit</span></div>
            <div className="hero-stat"><b>Library</b><span className="metric-label">Local Sources</span></div>
            <div className="hero-stat"><b>Tabs</b><span className="metric-label">Parallel Sessions</span></div>
            <div className="hero-stat"><b>GPLv3+</b><span className="metric-label">License</span></div>
          </div>
        </div>
        <div style={{position:'relative'}}>
          <Terminal/>
        </div>
      </div>
    </section>
  );
}

window.Hero = Hero;
