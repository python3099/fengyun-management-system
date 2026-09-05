# 广东丰云智能科技有限公司管理系统

面向公司内部使用的综合管理平台：日常办公管理、项目运营监控、任务进度跟踪和业务拓展管理。

纯前端技术（HTML5 + CSS3 + JavaScript ES6+），无任何第三方框架；可选配一个零依赖的 Node.js 静态/数据服务用于团队共享部署。

## 功能模块

| 模块 | 说明 |
|------|------|
| 日常待办 | 日历月视图管理每日待办，支持增删改查 |
| 运营情况 | 公司运营四项核心指标自动汇总 + 各部门数据看板 |
| 进度卡点 | 部门卡点问题表格化跟踪（进行中/待推进/已解决） |
| 来年统采进展 | 已落地 / 潜在合作 / 未对接三级清单，未对接重点高亮 |

## 快速开始

### 方式一：个人使用（无需安装任何东西）

直接双击 `index.html` 在浏览器打开即可（推荐 Chrome / Edge）。

### 方式二：团队共享（内网部署，推荐）

```bash
node server.js        # 或 npm start，默认端口 8080
```

启动后按控制台提示访问，例如 `http://localhost:8080/`（同事用局域网地址访问）。
此模式下所有人在同一份数据上操作，数据实时保存到服务器的 `data/` 目录。

自定义端口：`PORT=9000 node server.js`（Windows PowerShell 用 `$env:PORT=9000; node server.js`）。

## 数据存储说明

系统有三种存储模式，页面右上角「💾 数据」可查看当前模式：

1. **服务器共享模式**（自动启用）：通过 `http://` 访问且检测到 `server.js` 的 API 时自动生效。所有增删改实时写入服务器 `data/` 目录下的 JSON 文件：
   - `data/todos.json` — 日常待办
   - `data/departments.json` — 运营情况
   - `data/blockers.json` — 进度卡点
   - `data/procurement.json` — 来年统采进展
2. **目录绑定模式**：双击打开（file://）或静态托管时，可在「💾 数据」中绑定本地文件夹（建议选本项目 `data/` 目录），数据实时写入该文件夹，可随 Git 一起提交。仅 Chrome / Edge 支持；每次重新打开页面需点击一次「重新连接」授权。
3. **浏览器本地模式**（兜底）：数据保存在浏览器 localStorage（key：`fengyun_todos` 等，与 v1.0 单文件版兼容）。换浏览器/清缓存会丢失，建议定期「导出数据备份」。

数据文件首次运行时自动初始化（含示例数据，可编辑删除）。多人同时编辑同一模块时按"最后保存优先"覆盖，重要操作建议错峰或约定分工。

## 目录结构

```
fengyun-management-system/
├── index.html          # 入口页面
├── css/style.css       # 全部样式
├── js/app.js           # 全部逻辑（含数据存储适配层）
├── server.js           # 零依赖 Node 服务：静态托管 + 数据 API（团队共享时使用）
├── data/               # 数据文件目录（运行时自动生成 *.json，可提交 Git 备份）
├── package.json
├── CHANGELOG.md        # 版本变更记录
└── README.md
```

## 发布到 GitHub 与更新流程

### 首次发布

```bash
cd fengyun-management-system
git init
git add .
git commit -m "feat: v1.1.0 工程化版本"
git branch -M main
git remote add origin https://github.com/<公司组织或账号>/fengyun-management-system.git
git push -u origin main
```

### 后续迭代更新

```bash
# 修改代码后：
git add .
git commit -m "fix: 修复xxx / feat: 新增xxx"
git push
```

内网服务器的更新：登录服务器执行 `git pull` 即可完成升级（`data/` 目录如已提交会自动合并；若服务器数据不想被覆盖，可将 `data/*.json` 加入 `.gitignore`，改为在服务器本地保留）。

### GitHub Pages 静态托管（仅演示/个人模式）

仓库 Settings → Pages → 选择 main 分支根目录即可通过 `https://<账号>.github.io/fengyun-management-system/` 访问。
注意：GitHub Pages 为纯静态托管，数据只存在各访问者浏览器中（可导出/导入迁移），不适合多人共享数据；团队共享请用方式二。

## 迭代规范

- 版本号同步修改三处：`package.json`、`js/app.js` 顶部 `APP_VERSION`、`CHANGELOG.md` 追加记录。
- 功能改动建议先在个人模式（双击 index.html）自测，再发布服务器。
- 修改数据结构时（模块字段增删），注意同步 `js/app.js` 中 `validateModuleData` 校验逻辑，并在 `CHANGELOG.md` 注明数据迁移说明。
