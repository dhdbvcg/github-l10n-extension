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

## 性能与稳定性（v1.1.3）

- **分片并行翻译**：长文按段切块后并行请求（并发 3），结果按索引拼接，长文等待时间约降为 1/3
- **引擎健康度记忆**：连续失败或硬错误（4xx/5xx/超时）后该引擎冷却 60 秒，冷却中的引擎自动排到最后，避免反复撞已挂的接口；全冷却时仍按顺序尝试，不会放弃翻译
- **请求去重**：同一文本的并发请求（多按钮、重复句式）合并为一次网络请求
- **失败可重试**：失败段落不写负缓存、不锁死，按钮旁出现「重试失败 (n)」只补翻失败部分，成功译文保留
- **跳过无效段落**：纯中文/纯符号/纯数字段落不送翻译，避免白占并发
- **blob 面板幂等**：重复点击不再叠加多份对照面板；失败时保留原文，只在译文位标记「（翻译失败）」
- **界面词条缓存改 LRU**：命中即移到末尾，淘汰时丢最久未用条目（原来是 FIFO 丢掉一半）
- **Service Worker 唤醒重试**：后台休眠后首次 `sendMessage` 失败会自动重试一次

## 人机翻译

点击页面上的「译」按钮即可为当前区域生成机器翻译参考，原文保留、译文以浅色样式插入原文旁：

| 区域 | 按钮位置 |
|---|---|
| 关于简介 | 仓库侧栏「关于」描述下方 |
| 自述文件 | README 正文上方 |
| 发行版简介 | `/releases` 每个发行版说明上方 |
| 文件列表提交信息 | 右下角悬浮「译 提交信息」按钮（最多 40 条） |
| 文件内容 | blob 页（LICENSE / CONTRIBUTING.md / SECURITY.md 等）文件上方，双栏原文↔译文对照 |

- 翻译引擎：**OpenNMT-py**（唯一引擎，需自行部署，见下方「部署 OpenNMT 翻译服务」）。译文为机器结果，仅供参考
- 服务状态：弹窗可查看连接状态（已连接/未连接/检测中）、测试连接、保存服务地址；服务不可用时 30 秒内快速失败并给出可读原因
- 长文按句切分并行翻译（并发 3），按索引拼接保证顺序
- 译文按文本哈希缓存（上限 800 条，存于本机 `chrome.storage`），重复浏览不重复请求
- 弹窗中可单独关闭「人机翻译」；主开关关闭时一同停用

## 部署 OpenNMT 翻译服务

人机翻译依赖 [OpenNMT-py](https://github.com/OpenNMT/OpenNMT-py) 提供的 REST 服务。插件本身不含翻译模型，需先在本机（或局域网/服务器）部署一个英译中服务。

### 1. 安装 OpenNMT-py

```bash
pip install OpenNMT-py
```

### 2. 准备英译中模型

任选一种：

- **训练自己的模型**：用 `train.py` 在英中平行语料上训练，产出 `.pt` 模型文件与对应的 tokenizer（SentencePiece / BPE）。
- **下载现成模型**：从 HuggingFace、OpenNMT 论坛等获取英译中的 `model_step_*.pt` + `.spm`（或对应 BPE 词表）文件，按其 README 放到同一目录。

> 插件通过插件的 `模型 ID`（`conf.json` 里 `id` 字段）选择模型，通常第一个模型用 `0`。

### 3. 写服务配置 `conf.json`

```json
{
  "models_root": "./models",
  "models": [
    {
      "id": 0,
      "name": "en-zh",
      "load": true,
      "timeout": 600
    }
  ]
}
```

其中 `load: true` 表示服务启动即加载该模型（推荐，避免首次请求等待加载）。

### 4. 启动服务

```bash
onmt_server -m conf.json --ip 127.0.0.1 --port 5000
```

启动后应能访问：

- 健康检查：`GET http://127.0.0.1:5000/translator/health` → `{"status":"ok"}`
- 翻译接口：`POST http://127.0.0.1:5000/translator/translate`

### 5. 在插件里连接

打开插件弹窗 → 「OpenNMT 翻译服务」：

- **服务地址**：本机填 `http://127.0.0.1:5000`（局域网填对方 IP）
- **模型 ID**：与 `conf.json` 中的 `id` 对应，默认 `0`
- **URL 前缀**：`/translator`（OpenNMT-py 默认）
- 点「**测试连接**」：先做健康检查，再实际试译一句 `Hello world`，通过则显示「已连接」

保存后回到 GitHub 页面点「译」即可。

### 部署在服务器时的注意事项

- 服务监听地址要能被访问到：若在远程机器，用 `--ip 0.0.0.0` 监听所有网卡
- 若浏览器与服务不在同源，扩展会通过 `optional_host_permissions` 在你保存地址时弹窗请求该地址的访问权限，请点「允许」
- 若仍被拦截（部分环境对 `http://` 有限制），可在 `onmt/bin/server.py` 启动处为 Flask 加上跨域头（`flask_cors`）：

  ```python
  from flask_cors import CORS
  CORS(app)
  ```

  或直接反向代理到 GitHub 同源路径。

## 目录结构

```
github-l10n-extension/
├── manifest.json    # MV3 清单
├── locals.js        # 完整 I18N 词库（约 2MB）
├── extras.js        # 补充词条/正则/文本补丁（Copilot AI + 企业版）
├── dictionary.js    # 自备补充词条
├── content.js       # 翻译引擎（页面检测/遍历/Observer/React 导航）
├── mt.js            # 人机翻译按钮与译文注入（长文对照）
├── background.js    # Service Worker 翻译中继（OpenNMT REST 接口）
├── popup.html/js    # 弹窗开关（含人机翻译开关）
├── icons/           # 扩展图标
├── LICENSE          # GPL-3.0
├── README.md        # 本文件
└── server.js        # 本地调试用静态服务器（可忽略）
```

## 致谢与许可

- 词库与核心算法来自 [maboloshi/github-chinese](https://github.com/maboloshi/github-chinese)（GPL-3.0），原作者：沙漠之子，最初基于楼教主的翻译脚本
- 人机翻译的接口对接参考 [OpenNMT-py](https://github.com/OpenNMT/OpenNMT-py)（Apache-2.0 / MIT 双许可）的 `onmt/bin/server.py` REST 契约（`POST /translator/translate`）
- 本项目以 [GNU GPL-3.0](LICENSE) 许可证开源
