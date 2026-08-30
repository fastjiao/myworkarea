# jiao公台（my-workbench）

一个基于 Electron 的桌面效率工具，集成软件快捷启动、文件/文件夹打开、日历与待办（Todo）、技能库查找。

## 项目简介

打开应用即可通过紧凑的卡片式界面快速启动本地软件、打开本地文件或文件夹，并在日历中管理事件与待办。界面简洁现代，支持亮色/暗色主题切换。

## 功能特性

- 🚀 软件快捷启动：紧凑卡片横向滚动浏览（支持 Shift + 滚轮），点击启动本地 `.exe`
- 📂 文件/文件夹打开：添加文件或文件夹快捷方式，用系统默认程序打开，支持手动输入或系统对话框选择
- 📅 日历与 Todo：日 / 周 / 月三种视图；日期格子显示当日事件数量角标；点击日期弹出事件面板（标题、时间、提醒、分类标签），支持勾选完成、编辑、删除
- 🔍 Find Skills 技能库：展示可用技能，支持搜索与分类浏览，可增删改
- 🌙 主题切换：亮色 / 暗色一键切换，偏好持久化

## 技术栈

- Electron（最新稳定版）
- 原生 HTML + CSS + JavaScript（不使用前端框架）
- 图标：内联 SVG（`modules/icons.js`），装饰性 UI 不再使用 Emoji
- 主进程：`child_process.exec` 启动软件、`shell.openPath` 打开文件/文件夹、`dialog` 选择路径
- 数据持久化：本地 JSON 文件

## 项目结构

```
my-workbench/
├── main.js              # 主进程：窗口创建、IPC、启动软件、打开文件、文件选择、JSON 读写
├── preload.js           # 预加载脚本：contextBridge 安全桥接
├── index.html           # 主页面框架（侧边栏 + 三页面容器 + 通用模态框 + 右键菜单）
├── styles.css           # 全局样式（主题变量、Toast、紧凑快捷栏、日历、技能库等）
├── renderer.js          # 主控制器（Store 数据仓库、UI 工具、DateUtil、导航/主题）
├── modules/
│   ├── icons.js         # 内联 SVG 图标库
│   ├── home.js          # 首页模块（软件 / 文件快捷启动）
│   ├── calendar.js      # 日历模块（含 Todo：日/周/月视图 + 事件面板）
│   └── skills.js        # 技能库模块（搜索 + 分类 + 增删）
├── data/                # 用户数据目录（运行时自动创建）
│   ├── apps.json        # 自定义快捷方式（软件 / 文件 / 文件夹）
│   ├── events.json      # 日历事件 / Todo
│   ├── skills.json      # 技能列表
│   └── settings.json    # 应用设置（主题偏好）
└── package.json
```

## 快速开始

```bash
cd my-workbench
npm install     # 安装 Electron（package.json 已配置）
npm start
```

> 无需 `npm init`，`package.json` 已就绪。

## 数据存储说明

- 所有用户数据保存在 `data/` 目录，各模块独立 JSON 文件
- `apps.json`：快捷方式，格式 `{ id, type, name, icon, path }`，`type` 为 `app`/`file`/`folder`
- `events.json`：事件 / Todo，格式 `{ id, title, date, time, reminder, category, done }`
- `skills.json`：技能，格式 `{ id, name, category, level, desc }`
- `settings.json`：设置，如 `{ "theme": "light" | "dark" }`
- 数据启动时读取，变更时自动保存

## 架构设计

### 进程通信与安全

- `contextIsolation: true` + `nodeIntegration: false`
- 渲染进程经 `preload.js` 的 `contextBridge`（`window.workbench`）调用主进程
- 渲染进程 `ipcRenderer.invoke`，主进程 `ipcMain.handle` 响应

### 数据流

- `renderer.js` 的 `Store` 集中管理数据与读写
- 各模块 `Store.onChange(render)` 订阅变更，`Store.notify()` 触发全模块刷新

### 系统能力

- 软件启动：`exec('start "" "路径"')`（处理空格、避免阻塞）
- 文件/文件夹打开：`shell.openPath`
- 路径选择：`dialog.showOpenDialog`，按类型传入 `openFile` 或 `openDirectory`（Windows 不可共存）

### 模块化

- 普通 `<script>` 顺序加载 + 全局命名空间（`window.Home` / `window.Calendar` / `window.Skills`）
- 因 `loadFile` 走 `file://` 协议，ES `import` 会被 CORS 拦截，故不用 ES Module

## 使用说明

| 功能 | 操作 |
|------|------|
| 添加快捷方式 | 首页「添加软件」/「添加文件/文件夹」，填写名称、图标（可选）、路径 |
| 启动 / 打开 | 点击对应卡片；数量超出可视区时 Shift+滚轮横向浏览 |
| 删除快捷方式 | 悬停卡片右上角 ×，或右键卡片选「删除」 |
| 查看日历 | 「日历」页，用「月/周/日」切换视图，箭头切换前后 |
| 添加事件/Todo | 日历中点击某一天，在面板中填写标题、时间、提醒、分类 |
| 查找技能 | 「Find Skills」页，搜索框过滤 + 分类标签筛选 |

## 常见问题

- **无法选择文件（只能选文件夹）**：Windows 限制，已按类型分流 `openFile`/`openDirectory`
- **默认快捷方式被移除**：内置软件列表在 `renderer.js` 的 `DEFAULT_APPS`（已清空），取消注释可恢复
- **数据丢失**：手动编辑 `data/*.json` 时保持 JSON 格式合法，否则该文件按默认值加载