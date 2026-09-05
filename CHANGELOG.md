# 更新日志

## v1.1.0 - 2026-09-05

- 工程化重构：单文件拆分为 `index.html` + `css/style.css` + `js/app.js`，便于持续迭代
- 新增数据存储适配层，支持三种模式：
  - 服务器共享模式（`server.js` 的 `/api/data` 读写 `data/*.json`，全团队同一份数据）
  - 目录绑定模式（File System Access API，数据写入本地项目文件夹，可随 Git 提交）
  - 浏览器本地模式（localStorage，与 v1.0 单文件版数据兼容）
- 新增「💾 数据」管理面板：模式查看、目录绑定/重连/解绑、数据备份导出/导入
- 新增 `server.js`（零依赖 Node 服务）：静态托管 + 数据 API，支持内网共享部署
- 新增 `README.md`、`CHANGELOG.md`、`package.json`、`.gitignore`

## v1.0.0 - 2026-09-05

- 单文件版本（`丰云管理系统.html`）：四大模块（日常待办 / 运营情况 / 进度卡点 / 来年统采进展）+ localStorage 存储
