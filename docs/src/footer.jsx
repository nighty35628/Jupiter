// Footer

function Footer() {
  const { lang } = useLang();
  const { version: rxVersion, status: rxStatus } = useVersion();
  const rxLabel =
    rxStatus === "ok" && rxVersion
      ? `v${rxVersion} · stable`
      : rxStatus === "failed"
        ? t({ zh: "版本获取失败", en: "version unavailable" }, lang)
        : t({ zh: "正在获取版本…", en: "fetching version…" }, lang);
  return (
    <footer className="footer">
      <div className="footer-inner">
        <div>
          <a className="brand" href="#top" style={{textDecoration:'none', color:'inherit'}}>
            <span className="brand-mark"></span>
            <span className="brand-name">
              <b>Jupiter</b>
            </span>
          </a>
          <p style={{color:'var(--cream-mute)', fontSize:13, marginTop:14, lineHeight:1.65, maxWidth:340}}>
            {t({
              zh: '省钱缓存优先的 AI 工作台 · 完整工程 agent 能力 · 资料库、本地会话与顶栏标签页。',
              en: 'Cache-first AI workbench with full coding-agent workflows, workspace libraries, local sessions, and top-bar tabs.',
            }, lang)}
          </p>
          <div style={{display:'flex', gap:10, marginTop:18}}>
            <a className="btn btn-ghost btn-sm" href="https://github.com/nighty35628/Jupiter" target="_blank" rel="noreferrer" aria-label="GitHub"><Ic.Github size={14}/></a>
            <a className="btn btn-ghost btn-sm" href="https://github.com/nighty35628/Jupiter/discussions" target="_blank" rel="noreferrer">Discussions</a>
          </div>
        </div>
        <div>
          <h5>Product</h5>
          <ul>
            <li><a href="index.html#install">{t({ zh: 'CLI 安装', en: 'Install CLI' }, lang)}</a></li>
            <li><a href="download.html">{t({ zh: '桌面端', en: 'Desktop' }, lang)}</a></li>
            <li><a href="index.html#agents">{t({ zh: '三大支柱', en: 'Three pillars' }, lang)}</a></li>
            <li><a href="index.html#config">{t({ zh: '配置', en: 'Config' }, lang)}</a></li>
          </ul>
        </div>
        <div>
          <h5>Community</h5>
          <ul>
            <li><a href="https://github.com/nighty35628/Jupiter" target="_blank" rel="noreferrer">GitHub</a></li>
            <li><a href="https://github.com/nighty35628/Jupiter/discussions" target="_blank" rel="noreferrer">Discussions</a></li>
            <li><a href="https://github.com/nighty35628/Jupiter/issues" target="_blank" rel="noreferrer">Issues</a></li>
            <li><a href="https://github.com/nighty35628/Jupiter/blob/main/CONTRIBUTING.md" target="_blank" rel="noreferrer">Contributing</a></li>
          </ul>
        </div>
        <div>
          <h5>Resources</h5>
          <ul>
            <li><a href="https://github.com/nighty35628/Jupiter#readme" target="_blank" rel="noreferrer">README</a></li>
            <li><a href="index.html#roadmap">Roadmap</a></li>
            <li><a href="https://github.com/nighty35628/Jupiter/blob/main/CHANGELOG.md" target="_blank" rel="noreferrer">Changelog</a></li>
            <li><a href="https://platform.deepseek.com" target="_blank" rel="noreferrer">DeepSeek Platform</a></li>
          </ul>
        </div>
      </div>
      <div className="footer-bottom">
        <span>© 2026 nighty35628 · GPLv3+ License</span>
        <span className="spacer"></span>
        <span>{t({
          zh: 'Independent open-source project · 与 DeepSeek 官方无关',
          en: 'Independent open-source project · not affiliated with DeepSeek',
        }, lang)}</span>
        <span style={{marginLeft:18}}>{rxLabel}</span>
      </div>
    </footer>
  );
}

window.Footer = Footer;
