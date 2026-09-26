# GitHub 中文化（Chrome 扩展）

将 GitHub 网页界面（含 Copilot / AI 聊天界面、企业版流程）翻译为中文的 Chrome 扩展（Manifest V3），并附**人机翻译**长文对照。

仓库地址：https://github.com/dhdbvcg/github-l10n-extension

## 安装

1. 打开 Chrome，访问 `chrome://extensions/`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本仓库目录
4. 打开或刷新 github.com 即可生效

修改本仓库任何文件后，到 `chrome://extensions/` 点击本扩展的「刷新」按钮，再刷新 GitHub 页面。

## 功能

- **全站 UI 汉化**：导航、仓库页、议题、拉取请求、设置、仪表盘等 275 类页面的界面文字
- **Copilot / AI 界面汉化**：聊天输入框、优化目标下拉（效率/均衡/智能）、模式切换、回答反馈、编码智能体等
- **企业版流程汉化**：企业类型选择页、按量计费（metered）说明、试用与账单表单
- **相对时间**：`16 hours ago` → `16 小时前`、`Yesterday` → `昨天`
- **页面标题翻译**（可在弹窗中开关）
- **动态内容**：MutationObserver + Turbo 事件监听，SPA 导航后自动继续翻译；输入框占位符有定时/聚焦多重兜底
- **人机翻译**：仓库「关于」简介、自述文件、发行版简介、文件列表提交信息、许可证/贡献指南等文件内容，可点「译」按钮生成**机翻参考**，与原文对照展示（默认开启，可在弹窗关闭；译文按内容哈希缓存）
- **弹窗开关**：一键启用/禁用翻译（切换后自动刷新页面）

## 翻译层级

词条按优先级合并（前者优先）：

1. `locals.js` — 完整词库（275 类页面，来自 github-chinese 项目）
2. `extras.js` — 参考脚本的补充词条、正则规则、文本补丁 + Copilot AI / 企业版补充
3. `dictionary.js` — 本插件自备补充词条

只翻译界面文字；用户内容（README、许可证等）不做自动替换，仅通过人机翻译提供对照参考。

## 人机翻译

点击页面上的「译」按钮即可为当前区域生成机器翻译参考，原文保留、译文以浅色样式插入原文旁：

| 区域 | 按钮位置 |
|---|---|
| 关于简介 | 仓库侧栏「关于」描述下方 |
| 自述文件 | README 正文上方 |
| 发行版简介 | `/releases` 每个发行版说明上方 |
| 文件列表提交信息 | 右下角悬浮「译 提交信息」按钮（最多 40 条） |
| 文件内容 | blob 页（LICENSE / CONTRIBUTING.md / SECURITY.md 等）文件上方，双栏原文↔译文对照 |

- 引擎：Google 翻译公开端点（主）+ MyMemory（备），无需任何密钥；译文为机器结果，仅供参考
- 译文按文本哈希缓存（上限 800 条，存于本机 `chrome.storage`），重复浏览不重复请求
- 弹窗中可单独关闭「人机翻译」；主开关关闭时一同停用

## 目录结构

```
github-l10n-extension/
├── manifest.json    # MV3 清单
├── locals.js        # 完整 I18N 词库（约 2MB）
├── extras.js        # 补充词条/正则/文本补丁（Copilot AI + 企业版）
├── dictionary.js    # 自备补充词条
├── content.js       # 翻译引擎（页面检测/遍历/Observer/React 导航）
├── mt.js            # 人机翻译按钮与译文注入（长文对照）
├── background.js    # Service Worker 翻译中继（Google/MyMemory 引擎）
├── popup.html/js    # 弹窗开关（含人机翻译开关）
├── icons/           # 扩展图标
├── LICENSE          # GPL-3.0
├── README.md        # 本文件
└── server.js        # 本地调试用静态服务器（可忽略）
```

## 致谢与许可

- 词库与核心算法来自 [maboloshi/github-chinese](https://github.com/maboloshi/github-chinese)（GPL-3.0），原作者：沙漠之子，最初基于楼教主的翻译脚本
- 本扩展仅将其适配为 Chrome 扩展形态，未包含其远程机器翻译功能
- 本项目以 [GNU GPL-3.0](LICENSE) 许可证开源
