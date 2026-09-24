# GitHub 中文化（Chrome 扩展）

将 GitHub 网页界面（含 Copilot / AI 聊天界面、企业版流程）翻译为中文的 Chrome 扩展（Manifest V3）。

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
- **弹窗开关**：一键启用/禁用翻译（切换后自动刷新页面）

## 翻译层级

词条按优先级合并（前者优先）：

1. `locals.js` — 完整词库（275 类页面，来自 github-chinese 项目）
2. `extras.js` — 参考脚本的补充词条、正则规则、文本补丁 + Copilot AI / 企业版补充
3. `dictionary.js` — 本插件自备补充词条

只翻译界面文字，不翻译代码、Markdown 正文、文件名、提交信息等用户内容。

## 目录结构

```
github-l10n-extension/
├── manifest.json    # MV3 清单
├── locals.js        # 完整 I18N 词库（约 2MB）
├── extras.js        # 补充词条/正则/文本补丁（Copilot AI + 企业版）
├── dictionary.js    # 自备补充词条
├── content.js       # 翻译引擎（页面检测/遍历/Observer/React 导航）
├── popup.html/js    # 弹窗开关
├── icons/           # 扩展图标
├── LICENSE          # GPL-3.0
├── README.md        # 本文件
└── server.js        # 本地调试用静态服务器（可忽略）
```

## 致谢与许可

- 词库与核心算法来自 [maboloshi/github-chinese](https://github.com/maboloshi/github-chinese)（GPL-3.0），原作者：沙漠之子，最初基于楼教主的翻译脚本
- 本扩展仅将其适配为 Chrome 扩展形态，未包含其远程机器翻译功能
- 本项目以 [GNU GPL-3.0](LICENSE) 许可证开源
