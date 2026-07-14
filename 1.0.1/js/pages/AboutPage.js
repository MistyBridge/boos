import { html } from '../html.js';
import { serverHealth, installPrompt, isInstalledPwa } from '../state.js';
import { setToast } from '../toast.js';
import { Card } from '../components/Card.js';
import { PageTitleBar } from '../components/PageTitleBar.js';
import { BrandMark, IconGithub, IconExternal } from '../icons.js';
import { T } from '../i18n.js';

const REPO_URL = 'https://github.com/MistyBridge/boos';
const NPM_URL  = 'https://www.npmjs.com/package/@MistyBridge/boos';

async function onInstall() {
  const ev = installPrompt.value;
  if (!ev) return setToast('安装提示暂时不可用 · 请尝试在普通 Edge 标签页中打开此 URL', 'error');
  ev.prompt();
  const { outcome } = await ev.userChoice;
  installPrompt.value = null;
  if (outcome === 'accepted') {
    setToast('已安装 · 关闭并通过 npx boos 重新启动以启用窗口控件叠加');
  }
}

function InstallCard() {
  if (isInstalledPwa.value) return null;
  const canPrompt = !!installPrompt.value;
  return html`
    <${Card} title="安装为应用">
      <p class="about-copy" style="margin-bottom: var(--s-3);">
        boos 作为 Chromium PWA 运行时体验最佳 — 标题栏融入页面（窗口控件叠加），启动快捷方式成为独立应用。下方支持的浏览器可一键安装。
      </p>
      <div class="about-links">
        <button class="action ${canPrompt ? 'primary' : 'subtle'}" onClick=${onInstall} disabled=${!canPrompt}>
          ${canPrompt ? '安装 boos' : '安装不可用'}
        </button>
      </div>
      ${!canPrompt ? html`
        <p class="muted-text" style="margin-top: var(--s-3);">
          如果按钮保持灰色：在普通 Edge 标签页中打开 <code>http://localhost:7777</code>，点击地址栏安装图标 (⊕)，然后通过 <code>npx boos</code> 重新启动。
        </p>` : null}
    </${Card}>`;
}

export function AboutPage() {
  const version = serverHealth.value.version;

  return html`
    <${PageTitleBar} title=${T.about.title} />
    <${InstallCard} />
    <${Card} title="boos">
      <div class="about-block">
        <div class="about-hero">
          <span class="about-mark"><${BrandMark} /></span>
          <div>
            <div class="about-name">boos <span class="about-version">${version ? `v${version}` : ''}</span></div>
            <div class="about-tagline">Claude Code 会话管理器 · 一个面板掌控此机器上所有活跃的 <code>claude</code> 会话。</div>
          </div>
        </div>

        <p class="about-copy">
          列出活跃和最近关闭的会话，每分钟快照一次，通过 Windows Terminal 恢复，
          并在隔离的工作空间中启动新会话。专为同时运行 8–10 个并发会话（跨临时仓库克隆）而设计。
        </p>

        <div class="about-links">
          <a class="action" href=${REPO_URL} target="_blank" rel="noopener">
            <${IconGithub} /> GitHub <${IconExternal} />
          </a>
          <a class="action subtle" href=${NPM_URL} target="_blank" rel="noopener">
            npm <${IconExternal} />
          </a>
        </div>

        <dl class="about-meta">
          <dt>安装</dt>
          <dd><code>npx @MistyBridge/boos</code></dd>
          <dt>数据目录</dt>
          <dd><code>~/.boos/</code> (可通过 <code>BOOS_HOME</code> 覆盖)</dd>
          <dt>平台</dt>
          <dd>Windows · Node 18+</dd>
          <dt>许可证</dt>
          <dd>MIT</dd>
        </dl>
      </div>
    </${Card}>
    <p class="muted-text" style="margin-top: var(--s-3); text-align:center;">
      需要升级控制？已移至 <strong>设置 → 通用 → 版本</strong>。
    </p>`;
}
