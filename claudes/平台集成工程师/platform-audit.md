# BOOS 跨平台适配审计报告

> 平台集成工程师 | 2026-07-13 | Task 3

## 概述

BOOS 当前为 **Windows-first** 实现。本报告梳理 `scripts/install.js` 中的 Windows 特定代码，并为 macOS 和 Linux 给出适配方案。

---

## 一、`scripts/install.js` Windows 特定代码分析

当前 `install.js` 是一个 **postinstall 脚本**，负责安装后的 URL 协议注册。以下是每个 Windows 依赖点的分析：

### 1.1 平台守卫（L21-24）

```js
if (process.platform !== 'win32') {
  log('non-Windows · skipping boos:// registration');
  process.exit(0);
}
```

**问题**：macOS/Linux 被完全跳过，缺少等效的协议注册。

### 1.2 VBScript 启动器（L67-90）

```js
function writeLauncherVbs(boosCmd) {
  const home = process.env.LOCALAPPDATA || process.env.APPDATA;
  // ... 生成 launcher.vbs
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${cmdEsc}"" """ & arg & """", 0, False`,
  ].join('\r\n');
}
```

**依赖**：
- `%LOCALAPPDATA%` 环境变量（Windows 专用）
- `wscript.exe` 作为执行宿主（Windows 专用）
- `\r\n` 换行（Windows 约定）
- `CreateObject("WScript.Shell")` COM 调用（Windows 专用）
- `Shell.Run` 隐藏窗口（Windows 专用）

### 1.3 注册表协议注册（L92-109）

```js
function registerProtocol(vbsPath) {
  const command = `wscript.exe "${vbsPath}" "%1"`;
  const root = 'HKCU\\Software\\Classes\\boos';
  const calls = [
    ['add', root, '/ve', '/d', 'URL:boos protocol', '/f'],
    ['add', root, '/v', 'URL Protocol', '/d', '', '/f'],
    ['add', `${root}\\shell\\open\\command`, '/ve', '/d', command, '/f'],
  ];
  // ... spawnSync('reg.exe', args)
}
```

**依赖**：
- `HKCU\Software\Classes` 注册表路径（Windows 专用）
- `reg.exe` 命令行工具（Windows 专用）
- `wscript.exe` 作为协议调度器

### 1.4 Browser 启动（L138-153）

```js
require('node:child_process').spawn(
  'cmd.exe',
  ['/d', '/s', '/c', 'start', '', 'https://...'],
  { detached: true, stdio: 'ignore', windowsHide: true }
).unref();
```

**依赖**：
- `cmd.exe` + `start` 命令（Windows 专用）
- `windowsHide: true` spawn 选项（Windows 专用）

### 1.5 `findCcsmCmd` 路径查找（L37-60）

```js
const candidate = path.join(prefix, 'boos.cmd');
```

**问题**：`.cmd` 扩展名是 Windows 特有的。macOS/Linux 使用无扩展名的可执行文件。

---

## 二、macOS 适配方案

### 2.1 URL 协议注册 — `Info.plist` + Launch Services

macOS 不使用注册表。URL 协议通过应用的 `Info.plist` 注册：

```xml
<!-- ~/Library/boos/boos-helper.app/Contents/Info.plist -->
<key>CFBundleIdentifier</key>
<string>com.mistybridge.boos</string>
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>BOOS Protocol</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>boos</string>
    </array>
  </dict>
</array>
```

**实现方式**：创建最小化的 `.app` bundle：

```
~/Library/boos/boos-helper.app/
├── Contents/
│   ├── Info.plist          ← 协议声明
│   ├── MacOS/
│   │   └── boos-helper     ← Shell 脚本（chmod +x）
│   └── Resources/
│       └── boos.icns       ← 可选图标
```

`boos-helper` 内容：

```bash
#!/bin/bash
# Decode boos://start → spawn boos backend
exec /usr/local/bin/boos "$@" &
```

**激活方式**：
```bash
# 将 helper app 注册到 Launch Services
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f ~/Library/boos/boos-helper.app
```

### 2.2 替换 VBScript 启动器

macOS 使用 shell 脚本替代 VBScript：

```js
function writeLauncherScript(boosCmd) {
  const home = process.env.HOME;
  const dir = path.join(home, 'Library', 'boos');
  fs.mkdirSync(dir, { recursive: true });
  const scriptPath = path.join(dir, 'boos-helper');
  const content = [
    '#!/bin/bash',
    `exec "${boosCmd}" "$@" &`,
  ].join('\n');
  fs.writeFileSync(scriptPath, content, { encoding: 'utf8', mode: 0o755 });
  return scriptPath;
}
```

### 2.3 替换 Browser 启动

```js
// Cross-platform open command
const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
require('child_process').spawn(cmd, [url], {
  detached: true,
  stdio: 'ignore',
}).unref();
```

### 2.4 `node-pty` 差异

| 行为 | Windows | macOS |
|------|---------|-------|
| **PTY 类型** | winpty (conpty) | Unix pseudoterminal (fork + exec) |
| **Shell 默认** | `cmd.exe` | `$SHELL` 或 `/bin/zsh` |
| **参数传递** | `spawn('cmd.exe', ['/c', cmd])` | `spawn('/bin/zsh', ['-c', cmd])` |
| **环境变量** | `%VAR%`，大小写不敏感 | `$VAR`，大小写敏感 |
| **文件权限** | ACL（NTFS） | POSIX `chmod`/`chown` |
| **路径分隔** | `\`（反斜杠） | `/`（正斜杠） |

需要验证的关键场景：
1. `node-pty.spawn()` 的 `cwd` 参数在 macOS 上是否正确传递
2. UTF-8 编码在 Unix PTY 上的兼容性
3. `SIGTERM` / `SIGKILL` 信号与 Windows `taskkill` 的语义差异

---

## 三、Linux 适配方案

### 3.1 URL 协议注册 — `.desktop` + `xdg-utils`

Linux 使用 Desktop Entry 规范：

```ini
# ~/.local/share/applications/boos.desktop
[Desktop Entry]
Type=Application
Name=BOOS
Comment=BOOS Session Manager
Exec=/usr/local/bin/boos %u
Terminal=false
Categories=Utility;
MimeType=x-scheme-handler/boos;
NoDisplay=true
```

**注册命令**：
```bash
xdg-mime default boos.desktop x-scheme-handler/boos
update-desktop-database ~/.local/share/applications/ 2>/dev/null || true
```

### 3.2 Node.js 实现

```js
function writeDesktopEntry(boosCmd) {
  const home = process.env.HOME;
  const appsDir = path.join(home, '.local', 'share', 'applications');
  fs.mkdirSync(appsDir, { recursive: true });

  const desktopPath = path.join(appsDir, 'boos.desktop');
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=BOOS',
    'Comment=BOOS Session Manager',
    `Exec=${boosCmd} %u`,
    'Terminal=false',
    'Categories=Utility;',
    'MimeType=x-scheme-handler/boos;',
    'NoDisplay=true',
  ].join('\n');
  fs.writeFileSync(desktopPath, entry, { encoding: 'utf8' });

  // Register with xdg-utils
  const { spawnSync } = require('child_process');
  spawnSync('xdg-mime', ['default', 'boos.desktop', 'x-scheme-handler/boos']);
  spawnSync('update-desktop-database', [appsDir]);

  return desktopPath;
}
```

### 3.3 `node-pty` 差异

Linux 行为与 macOS 高度一致（都是 Unix-like）。额外注意事项：

1. **systemd user units** — 可作为后台服务的替代启动方式
2. **AppImage/Snap/Flatpak** — 如果未来打包，需处理沙盒中的协议注册
3. **libc 差异** — `node-pty` 的 native 模块需链接不同 libc（glibc vs musl）

---

## 四、PWA 安装流程跨平台

当前 PWA manifest 在 `pages-root/manifest.webmanifest`：

```json
{
  "id": "/boos/",
  "display_override": ["window-controls-overlay", "standalone"],
  ...
}
```

### 4.1 跨平台差异

| 平台 | PWA 安装方式 | WCO 支持 | 注意事项 |
|------|-------------|---------|---------|
| **Windows** | Edge/Chrome `--app=` 模式 + 地址栏 "安装" 按钮 | ✅ 完全支持 | 当前实现 |
| **macOS** | Safari "添加到 Dock" / Chrome "安装 BOOS" | ⚠️ 部分支持 | 需要 `apple-touch-icon`、`apple-mobile-web-app-capable` meta 标签 |
| **Linux** | Chrome/Chromium "安装" 按钮 | ❌ 不支持 | 需要 GNOME/Plasma 集成 |

### 4.2 macOS PWA 增强

需在 `index.html` 中添加：

```html
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="apple-touch-icon" href="/favicon.svg">
```

---

## 五、适配路线图

```
Phase 1: macOS（优先级 P2 → 4 周）
├── Week 1-2: install.js 重构
│   ├── 抽象平台层（registerProtocol / writeLauncher / spawnBrowser）
│   ├── macOS Info.plist + helper app 实现
│   └── node-pty 行为验证
├── Week 3: 集成测试
│   ├── 完整安装 → 协议注册 → 唤醒流程
│   └── PWA 安装验证（Safari + Chrome）
└── Week 4: 文档 + 发布

Phase 2: Linux（优先级 P2 → 3 周）
├── Week 1-2: .desktop + xdg-utils 实现
├── Week 2: node-pty 验证（主流发行版）
└── Week 3: 文档 + 发布

Phase 3: 持续
├── AppImage/Snap 打包研究
├── Windows ARM64 适配
└── CI 多平台矩阵（Windows/macOS/Linux）
```

---

## 六、`install.js` 重构建议

建议将 `install.js` 重构为策略模式：

```js
// scripts/install.js (重构后)
const strategies = {
  win32: require('./platforms/win32'),
  darwin: require('./platforms/darwin'),
  linux: require('./platforms/linux'),
};

const platform = strategies[process.platform];
if (platform) {
  platform.registerProtocol(boosCmd);
  platform.openBrowser(setupUrl);
} else {
  log('unsupported platform · skipping');
}
```

每个平台模块实现统一接口：
- `registerProtocol(boosCmd)` → 注册 `boos://` 协议
- `writeLauncher(boosCmd)` → 生成启动脚本
- `openBrowser(url)` → 打开浏览器
- `findBinary()` → 定位可执行文件

---

## 结论

- Windows 实现已成熟稳定
- macOS 需要约 **200 行新代码**（Info.plist + helper app + `open` 命令）
- Linux 需要约 **150 行新代码**（.desktop + xdg-utils）
- 核心 `node-pty` 差异主要在 shell 和路径处理，不影响协议功能
