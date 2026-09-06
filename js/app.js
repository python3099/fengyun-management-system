'use strict';
/* =========================================================
   广东丰云智能科技有限公司管理系统 - 应用脚本 v1.2.0
   数据存储适配层支持三种模式（自动检测，可手动绑定）：
     1. server - 服务器共享模式：经 server.js 的 /api/data 读写服务器 data/*.json
     2. file   - 目录绑定模式  ：通过 File System Access API 写入本地项目 data/ 目录
     3. local  - 浏览器本地模式：localStorage（兜底方案，始终作为镜像缓存）
   ========================================================= */

const APP_VERSION = '1.7.1';

/* =========================================================
   工具函数
   ========================================================= */
const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
const pad = n => String(n).padStart(2, '0');
const fmtDate = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const fmtDateTime = d => fmtDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
/* HTML 转义，防止用户输入破坏页面结构 */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const formatNum = n => { const v = Number(n); return Number.isFinite(v) ? v.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '0'; };
const toNum = (v, def = 0) => { const n = parseFloat(v); return (Number.isFinite(n) && n >= 0) ? n : def; };

/* =========================================================
   法定节假日数据（依据国务院办公厅通知）
   type: 'rest' = 放假（显示"休"、淡红底），'work' = 调休上班（显示"班"）
   2027 年及以后的安排待国务院发布后，按同样格式在下方补充即可
   ========================================================= */
const HOLIDAYS = (() => {
  const h = {};
  const mark = (name, type, dates) => dates.forEach(d => { h[d] = { name, type }; });
  const range = (y, m1, d1, m2, d2) => {   // 生成 y 年 m1月d1日 ~ m2月d2日 的日期数组
    const out = [];
    const cur = new Date(y, m1 - 1, d1);
    const end = new Date(y, m2 - 1, d2);
    while (cur <= end) { out.push(fmtDate(cur)); cur.setDate(cur.getDate() + 1); }
    return out;
  };
  /* 2026 年（国办发明电〔2025〕发布） */
  mark('元旦', 'rest', range(2026, 1, 1, 1, 3));
  mark('元旦', 'work', ['2026-01-04']);
  mark('春节', 'rest', range(2026, 2, 15, 2, 23));
  mark('春节', 'work', ['2026-02-14', '2026-02-28']);
  mark('清明节', 'rest', range(2026, 4, 4, 4, 6));
  mark('劳动节', 'rest', range(2026, 5, 1, 5, 5));
  mark('劳动节', 'work', ['2026-05-09']);
  mark('端午节', 'rest', range(2026, 6, 19, 6, 21));
  mark('中秋节', 'rest', range(2026, 9, 25, 9, 27));
  mark('国庆节', 'rest', range(2026, 10, 1, 10, 7));
  mark('国庆节', 'work', ['2026-09-20', '2026-10-10']);
  return h;
})();

/* =========================================================
   数据存储适配层
   四个业务模块 => localStorage key（兼容 v1.0 单文件版）+ 数据文件名
   ========================================================= */
const MODULES = [
  { name: 'todos',       ls: 'fengyun_todos',       file: 'todos.json'       },
  { name: 'departments', ls: 'fengyun_departments', file: 'departments.json' },
  { name: 'blockers',    ls: 'fengyun_blockers',    file: 'blockers.json'    },
  { name: 'procurement', ls: 'fengyun_procurement', file: 'procurement.json' }
];
const moduleDef = name => MODULES.find(m => m.name === name);

/* ========== 内存中的运行数据 ========== */
let todos, depts, blockers, procs;
let storageMode = 'local';        // 'server' | 'file' | 'local'
let pendingReconnect = false;     // 目录绑定权限待用户确认（每次打开页面需点一次允许）
const dirtyModules = new Set();   // 页面加载后已被用户修改过的模块（防止远程合并覆盖刚做的修改）
const pendingRemote = {};         // 待写入远程（服务器/文件）的数据
const flushTimers = {};
const fsWriteQueue = {};          // 文件写入串行队列，避免并发写同一文件

function getModuleVal(name) {
  switch (name) {
    case 'todos': return todos;
    case 'departments': return depts;
    case 'blockers': return blockers;
    case 'procurement': return procs;
  }
}
function setModuleVal(name, v) {
  switch (name) {
    case 'todos': todos = v; break;
    case 'departments': depts = v; break;
    case 'blockers': blockers = v; break;
    case 'procurement': procs = v; break;
  }
}

/* ========== localStorage 镜像（始终同步写入，作为缓存与兜底） ========== */
const LS = {
  get(key) {
    try { const raw = localStorage.getItem(key); return raw === null ? null : JSON.parse(raw); }
    catch (e) { console.error('读取本地数据失败：', e); return null; }
  },
  set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* 存储满时静默，远程模式仍可工作 */ } }
};

/* ========== 部门数据结构与迁移（v1.2 起部门包含多个合同） ========== */
function normCats(cats) {
  if (!Array.isArray(cats)) return [];
  return cats.map(c => ({ name: String(c && c.name || '').trim(), count: Math.round(toNum(c && c.count)) }))
             .filter(c => c.name);
}
/* 旧版部门字段（单合同 contract/patrol/problems/cats + projects）迁移为合同列表 */
function migrateDept(d) {
  const out = {
    id: d.id || uid(),
    name: String(d.name || '').trim() || '未命名部门',
    service: String(d.service || ''),
    contracts: []
  };
  if (Array.isArray(d.contracts)) {
    out.contracts = d.contracts.map(c => ({
      id: (c && c.id) || uid(),
      name: String(c && c.name || '').trim() || '未命名合同',
      content: String(c && c.content || ''),
      amount: toNum(c && c.amount),
      patrol: Math.round(toNum(c && c.patrol)),
      problems: Math.round(toNum(c && c.problems)),
      cats: normCats(c && c.cats)
    }));
  } else if (d.contract != null || d.patrol != null || d.problems != null || Array.isArray(d.cats)) {
    out.contracts = [{
      id: uid(),
      name: (Array.isArray(d.projects) && d.projects[0] && String(d.projects[0])) || '原合同',
      content: '',
      amount: toNum(d.contract),
      patrol: Math.round(toNum(d.patrol)),
      problems: Math.round(toNum(d.problems)),
      cats: normCats(d.cats)
    }];
  }
  return out;
}
/* 部门所有合同聚合（看板展示用） */
function deptTotals(d) {
  const t = { amount: 0, patrol: 0, problems: 0, count: 0, cats: [] };
  (d.contracts || []).forEach(c => {
    t.amount += toNum(c.amount);
    t.patrol += toNum(c.patrol);
    t.problems += toNum(c.problems);
    t.count += 1;
    (c.cats || []).forEach(cat => {
      const hit = t.cats.find(x => x.name === cat.name);
      if (hit) hit.count += cat.count; else t.cats.push({ name: cat.name, count: cat.count });
    });
  });
  return t;
}

/* ========== 默认示例数据（仅对应存储中无数据时使用，可编辑/删除） ========== */
function defaultTodos() {
  const today = fmtDate(new Date());
  return {
    [today]: [
      { id: uid(), person: '张三', content: '编写月度运营分析报告', remark: '下班前提交至工作群', createTime: today + ' 09:12' },
      { id: uid(), person: '李四', content: '跟进空域审批批复进度', remark: '', createTime: today + ' 09:30' }
    ]
  };
}
function defaultDepartments() {
  return [
    {
      id: uid(), name: '住建局', service: '城市网格化巡查与违建治理',
      contracts: [
        { id: uid(), name: '城市网格化巡查服务合同', content: '全市建成区网格化航拍巡查，覆盖市容秩序、环境卫生等问题采集', amount: 180, patrol: 1056, problems: 268, cats: [{ name: '市容秩序类', count: 142 }, { name: '环境卫生类', count: 126 }] },
        { id: uid(), name: '违建排查专项服务合同', content: '重点区域违建航拍比对与变化识别', amount: 140, patrol: 800, problems: 155, cats: [{ name: '违章建筑类', count: 155 }] }
      ]
    },
    {
      id: uid(), name: '水务局', service: '水域生态监测',
      contracts: [
        { id: uid(), name: '水域生态监测服务合同', content: '重点河涌水质航拍监测、排污口排查与蓝藻识别', amount: 280, patrol: 1230, problems: 267, cats: [{ name: '水体污染类', count: 98 }, { name: '非法排污类', count: 87 }, { name: '生态破坏类', count: 82 }] }
      ]
    }
  ];
}
function defaultBlockers() {
  return [
    { id: uid(), title: '2027年度巡飞航线规划', department: '住建局', progress: '待收集各街道巡查需求后统一规划', person: '张三', help: '需各街道提供重点区域清单', status: '未开始', updateTime: '2026-09-04' },
    { id: uid(), title: '空域审批流程待明确', department: '住建局', progress: '已与空管部门初步沟通，等待正式批复意见', person: '李四', help: '需协调局方加快审批进度', status: '进行中', updateTime: '2026-09-03' },
    { id: uid(), title: '巡飞电池组采购到货延迟', department: '水务局', progress: '供应商已发货，预计 9 月 10 日到货', person: '王五', help: '需采购部跟进物流并协调备机', status: '待推进', updateTime: '2026-09-01' },
    { id: uid(), title: '河涌监测数据接口联调', department: '水务局', progress: '接口已打通，历史数据校验通过，已交付使用', person: '赵六', help: '', status: '已解决', updateTime: '2026-08-28' }
  ];
}
function defaultProcurement() {
  return [
    { id: uid(), category: '已落地', name: '城市网格化巡查服务', unit: '住建局', service: '全市建成区网格化航拍巡查，覆盖违建、市容、环卫等问题采集', region: '全市 21 个街道', freq: '每周两次', budget: 320, follow: '', remark: '已签订年度服务合同' },
    { id: uid(), category: '已落地', name: '水域生态监测服务', unit: '水务局', service: '重点河涌水质航拍监测、排污口排查与蓝藻识别', region: '中心城区及重点流域', freq: '每月一次', budget: 280, follow: '', remark: '含月度数据报告' },
    { id: uid(), category: '潜在合作', name: '应急消防空中侦察支持', unit: '应急管理局', service: '火情侦察、灾害现场航拍建模、应急演练空中保障', region: '粤东片区', freq: '季度巡检', budget: null, follow: '方案编制中', remark: '待应急局立项评审' },
    { id: uid(), category: '潜在合作', name: '高标准农田航拍测绘', unit: '农业农村局', service: '农田地块航拍建模、作物长势监测与产量预估', region: '2 个试点县区', freq: '每月一次', budget: 150, follow: '初步接触', remark: '已完成现场踏勘' },
    { id: uid(), category: '未对接', name: '森林防火巡查需求', unit: '市林业局', service: '重点林区防火巡飞、烟点识别与热成像监测', region: '北部山区林场', freq: '每周一次', budget: null, follow: '待决策', remark: '需先对接林政科明确巡飞范围' },
    { id: uid(), category: '未对接', name: '城市违建智能识别试点', unit: '市城管局', service: '违章建筑航拍识别与变化对比分析', region: '主城区 3 个街道', freq: '每月一次', budget: null, follow: '初步接触', remark: '拟结合现有网格巡查数据开展试点' }
  ];
}
const DEFAULT_FACTORIES = { todos: defaultTodos, departments: defaultDepartments, blockers: defaultBlockers, procurement: defaultProcurement };

/* 校验远程数据结构，非法则返回 null（保留本地数据）；部门数据顺带执行合同模型迁移 */
function validateModuleData(name, v) {
  if (v == null) return null;
  if (name === 'todos') {
    if (typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }
  if (!Array.isArray(v)) return null;
  if (name === 'departments') return v.map(migrateDept);
  return v;
}

/* ========== 从 localStorage 加载（无数据时用默认示例初始化） ========== */
function loadLocalAll() {
  MODULES.forEach(m => {
    const v = validateModuleData(m.name, LS.get(m.ls));
    setModuleVal(m.name, v !== null ? v : DEFAULT_FACTORIES[m.name]());
    LS.set(m.ls, getModuleVal(m.name));
  });
}

/* ========== 核心保存入口：所有模块的增删改都调用这里 ========== */
function persistKey(name) {
  const def = moduleDef(name);
  const val = getModuleVal(name);
  LS.set(def.ls, val);            // 1. 本地镜像始终同步
  dirtyModules.add(name);         // 2. 标记已修改（防止启动期远程合并覆盖）
  if (storageMode === 'server' || storageMode === 'file') {
    pendingRemote[name] = val;    // 3. 远程写入防抖调度
    scheduleFlush(name);
  }
}
const saveTodos    = () => persistKey('todos');
const saveDepts    = () => persistKey('departments');
const saveBlockers = () => persistKey('blockers');
const saveProcs    = () => persistKey('procurement');

function scheduleFlush(name) {
  clearTimeout(flushTimers[name]);
  flushTimers[name] = setTimeout(() => flushKey(name), 400);
}
async function flushKey(name) {
  if (!(name in pendingRemote)) return;
  const val = pendingRemote[name];
  delete pendingRemote[name];
  try {
    if (storageMode === 'server') await apiPut(name, val);
    else if (storageMode === 'file') await fsWriteQueued(name, val);
  } catch (e) {
    console.error('远程数据写入失败：', name, e);
    toast('数据写入远程存储失败，已保留本地镜像', 'error');
  }
}
/* 页面隐藏/关闭前立即落盘，避免防抖延迟丢数据 */
function flushAllNow() {
  Object.keys(pendingRemote).forEach(name => {
    clearTimeout(flushTimers[name]);
    flushKey(name);
  });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAllNow(); });
window.addEventListener('pagehide', flushAllNow);

/* ========== 服务器模式 API（配合 server.js） ========== */
async function apiHealth() {
  if (!/^https?:$/.test(location.protocol)) return null;   // file:// 直开时跳过探测
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 1200);
    const r = await fetch('api/health', { signal: c.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}
async function apiGetAll() {
  const r = await fetch('api/data');
  if (!r.ok) throw new Error('读取服务器数据失败：' + r.status);
  return await r.json();
}
async function apiPut(name, val) {
  const r = await fetch('api/data/' + name, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(val)
  });
  if (!r.ok) throw new Error('写入服务器数据失败：' + r.status);
}

/* ========== 目录绑定模式（File System Access API，Chrome/Edge 支持） ========== */
const fsSupported = () => typeof window.showDirectoryPicker === 'function';

/* IndexedDB 用于跨会话记住用户选择的数据目录句柄 */
function idbOpen() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('fengyun-fs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction('kv').objectStore('kv').get(key);
    t.onsuccess = () => res(t.result);
    t.onerror = () => rej(t.error);
  });
}
async function idbSet(key, val) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function idbDel(key) {
  const db = await idbOpen();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite').objectStore('kv').delete(key);
    t.onsuccess = () => res();
    t.onerror = () => rej(t.error);
  });
}

async function fsReadKey(name) {
  const dir = await idbGet('datadir');
  if (!dir) return null;
  try {
    const fh = await dir.getFileHandle(moduleDef(name).file);
    const f = await fh.getFile();
    const txt = await f.text();
    return txt.trim() ? JSON.parse(txt) : null;
  } catch (e) { return null; }   // 文件不存在按无数据处理
}
async function fsWriteKey(name, val) {
  const dir = await idbGet('datadir');
  if (!dir) throw new Error('数据目录未绑定');
  const fh = await dir.getFileHandle(moduleDef(name).file, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(val, null, 2));
  await w.close();
}
/* 同一文件的写操作串行执行 */
function fsWriteQueued(name, val) {
  fsWriteQueue[name] = (fsWriteQueue[name] || Promise.resolve()).catch(() => {}).then(() => fsWriteKey(name, val));
  return fsWriteQueue[name];
}
async function fsReadAll() {
  const out = {};
  for (const m of MODULES) out[m.name] = await fsReadKey(m.name);
  return out;
}

/* 绑定数据目录：文件中已有数据则以文件为准，缺失的用当前数据补齐 */
async function bindDataDir() {
  if (!fsSupported()) { toast('当前浏览器不支持目录绑定，请使用 Chrome / Edge，或改用导出/导入备份', 'error'); return; }
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    if (e && e.name !== 'AbortError') toast('绑定失败：' + e.message, 'error');
    return;   // 用户取消
  }
  try {
    await dir.requestPermission({ mode: 'readwrite' });
    await idbSet('datadir', dir);
    storageMode = 'file';
    dirtyModules.clear();
    const remote = await fsReadAll();
    applyRemoteData(remote);
    renderAllModules();
    updateDataUI();
    toast('数据目录已绑定，数据将实时写入所选文件夹');
  } catch (e) {
    toast('数据目录绑定失败：' + e.message, 'error');
  }
}
/* 每次打开页面后重新连接上次绑定的目录（需要一次用户手势授权） */
async function reconnectDataDir() {
  try {
    const dir = await idbGet('datadir');
    if (!dir) return;
    const p = await dir.requestPermission({ mode: 'readwrite' });
    if (p !== 'granted') { toast('未获得数据目录访问权限', 'error'); return; }
    pendingReconnect = false;
    storageMode = 'file';
    dirtyModules.clear();
    applyRemoteData(await fsReadAll());
    renderAllModules();
    updateDataUI();
    toast('数据目录已重新连接');
  } catch (e) {
    toast('重新连接失败：' + e.message, 'error');
  }
}
async function unbindDataDir() {
  await idbDel('datadir');
  storageMode = 'local';
  pendingReconnect = false;
  updateDataUI();
  toast('已解除目录绑定，数据将仅保存在浏览器中', 'info');
}

/* ========== 启动时的存储模式探测与数据升级 ========== */
async function upgradeStorage() {
  /* 1. 探测服务器共享模式（http/https 访问且 /api/health 可用） */
  const health = await apiHealth();
  if (health && health.ok) {
    try {
      storageMode = 'server';
      applyRemoteData(await apiGetAll());
      return;
    } catch (e) { storageMode = 'local'; }
  }
  /* 2. 恢复上次绑定的数据目录（权限已授予则直接加载，否则提示重连） */
  try {
    const dir = await idbGet('datadir');
    if (dir) {
      const p = await dir.queryPermission({ mode: 'readwrite' });
      if (p === 'granted') {
        storageMode = 'file';
        applyRemoteData(await fsReadAll());
      } else if (p === 'prompt') {
        pendingReconnect = true;
      }
    }
  } catch (e) { /* IndexedDB 不可用时保持本地模式 */ }
}

/* 远程数据合并：远程已有数据则以远程为准；远程缺失的模块用当前数据初始化远程文件 */
function applyRemoteData(remote) {
  MODULES.forEach(m => {
    const v = validateModuleData(m.name, remote[m.name]);
    if (v !== null) {
      if (!dirtyModules.has(m.name)) setModuleVal(m.name, v);
      LS.set(m.ls, getModuleVal(m.name));
    } else {
      persistKey(m.name);   // 远程无此模块 => 建初始文件
    }
  });
  dirtyModules.clear();
}

/* ========== 数据备份导出 / 导入 ========== */
function exportData() {
  const payload = {
    app: 'fengyun-management-system',
    version: APP_VERSION,
    exportedAt: fmtDateTime(new Date()),
    data: { todos, departments: depts, blockers, procurement: procs }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '丰云系统数据备份_' + fmtDate(new Date()) + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  toast('备份文件已生成');
}
function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      const d = payload && payload.data ? payload.data : payload;
      const t = validateModuleData('todos', d.todos);
      const dp = validateModuleData('departments', d.departments);
      const bl = validateModuleData('blockers', d.blockers);
      const pc = validateModuleData('procurement', d.procurement);
      if (t === null && dp === null && bl === null && pc === null) throw new Error('文件中未找到有效数据');
      if (t !== null) { todos = t; persistKey('todos'); }
      if (dp !== null) { depts = dp; persistKey('departments'); }
      if (bl !== null) { blockers = bl; persistKey('blockers'); }
      if (pc !== null) { procs = pc; persistKey('procurement'); }
      renderAllModules();
      toast('数据导入成功');
    } catch (e) {
      toast('导入失败：' + e.message, 'error');
    }
  };
  reader.onerror = () => toast('文件读取失败', 'error');
  reader.readAsText(file, 'utf-8');
}

/* ========== 数据管理弹窗 UI ========== */
const MODE_META = {
  server: { label: '服务器共享模式', cls: 'tag-green', desc: '数据实时写入服务器的 data/ 目录（data/*.json 文件），全团队访问同一份数据。数据文件可随项目提交到 Git 做备份。' },
  file:   { label: '目录绑定模式',   cls: 'tag-blue',  desc: '数据实时写入你选择的本地文件夹（建议选项目的 data/ 目录），可随项目一起提交到 Git。注意：仅当前这台电脑、当前浏览器生效。' },
  local:  { label: '浏览器本地模式', cls: 'tag-gray',  desc: '数据保存在当前浏览器的 localStorage 中，换浏览器或清缓存会丢失。建议定期导出备份，或在 Chrome/Edge 中绑定数据目录。' }
};
function updateDataUI() {
  const meta = MODE_META[storageMode];
  const badge = $('#data-mode-badge');
  badge.textContent = meta.label;
  badge.className = 'tag ' + meta.cls;
  $('#data-mode-desc').textContent = meta.desc;
  $('#btn-bind-dir').style.display = (storageMode === 'local' && fsSupported()) ? '' : 'none';
  $('#btn-reconnect-dir').style.display = (pendingReconnect && fsSupported()) ? '' : 'none';
  $('#btn-unbind-dir').style.display = storageMode === 'file' ? '' : 'none';
  const dataBtn = $('#data-btn');
  dataBtn.title = '数据管理 - 当前：' + meta.label;
  dataBtn.classList.toggle('attn', pendingReconnect);
  if (!$('#app-version').textContent) $('#app-version').textContent = 'v' + APP_VERSION;
}
function bindDataEvents() {
  $('#data-btn').addEventListener('click', () => { updateDataUI(); openModal('#modal-data'); });
  $('#btn-bind-dir').addEventListener('click', bindDataDir);
  $('#btn-reconnect-dir').addEventListener('click', reconnectDataDir);
  $('#btn-unbind-dir').addEventListener('click', unbindDataDir);
  $('#btn-export').addEventListener('click', exportData);
  $('#btn-import').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) importData(f);
    e.target.value = '';
  });
}

/* 调试/测试句柄（不影响功能） */
window.__FENGYUN__ = { get mode() { return storageMode; }, version: APP_VERSION, flushAllNow };

/* =========================================================
   顶部实时时钟
   ========================================================= */
function tickClock() {
  const n = new Date();
  const week = '日一二三四五六'[n.getDay()];
  $('#datetime').textContent = n.getFullYear() + '年' + pad(n.getMonth() + 1) + '月' + pad(n.getDate()) +
    '日 星期' + week + ' ' + pad(n.getHours()) + ':' + pad(n.getMinutes()) + ':' + pad(n.getSeconds());
}

/* =========================================================
   页面导航（侧边菜单切换）
   ========================================================= */
function bindNav() {
  $$('.menu-item').forEach(item => {
    item.addEventListener('click', () => {
      $$('.menu-item').forEach(x => x.classList.toggle('active', x === item));
      $$('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + item.dataset.page));
    });
  });
}

/* =========================================================
   模块一：日常待办
   ========================================================= */
let calY, calM;             // 当前日历显示的年/月
let selectedDate;           // 当前选中的日期（YYYY-MM-DD）
let personFilter = '';      // 本月人员筛选（空 = 不筛选；选中后仅高亮该人的待办）
let editTodoId = '';        // 正在编辑的待办 id

function bindTodoEvents() {
  $('#cal-prev').addEventListener('click', () => shiftMonth(-1));
  $('#cal-next').addEventListener('click', () => shiftMonth(1));
  $('#cal-today').addEventListener('click', () => {
    const now = new Date();
    calY = now.getFullYear(); calM = now.getMonth();
    renderCalendar();
  });

  /* 日历点击（事件委托）：
     - 点击格内的负责人行 => 弹出该人员本月待办
     - 点击日期格其他位置 => 弹出当日待办管理（增/改/删） */
  $('#cal-grid').addEventListener('click', e => {
    const line = e.target.closest('.cal-todo-line');
    const cell = e.target.closest('.cal-cell');
    if (!cell) return;
    const key = cell.dataset.date;
    if (line) { openPersonModal(line.dataset.person); return; }
    selectedDate = key;
    if (key) openDayModal(key);
  });

  /* 当日待办弹窗：添加 + 列表编辑/删除（事件委托） */
  $('#day-form').addEventListener('submit', e => {
    e.preventDefault();
    addDayTodo();
  });
  $('#day-list').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit-todo]');
    const delBtn = e.target.closest('[data-del-todo]');
    const saveBtn = e.target.closest('[data-save-edit]');
    const cancelBtn = e.target.closest('[data-cancel-edit]');
    if (editBtn) { editTodoId = editBtn.dataset.editTodo; renderDayList(); }
    if (cancelBtn) { editTodoId = ''; renderDayList(); }
    if (saveBtn) saveDayTodoEdit(saveBtn.dataset.saveEdit);
    if (delBtn) {
      const id = delBtn.dataset.delTodo;
      const t = (todos[selectedDate] || []).find(x => x.id === id);
      confirmDialog('确定要删除「' + ((t && t.content) || '') + '」这条待办吗？删除后不可恢复。', () => {
        todos[selectedDate] = (todos[selectedDate] || []).filter(x => x.id !== id);
        if (!todos[selectedDate].length) delete todos[selectedDate];
        saveTodos(); renderCalendar(); renderDayList();
        toast('待办已删除');
      });
    }
  });
}

function shiftMonth(delta) {
  calM += delta;
  if (calM < 0) { calM = 11; calY--; }
  else if (calM > 11) { calM = 0; calY++; }
  renderCalendar();
}

/* 渲染月视图日历：周末/法定假日红字，假日淡红底+"休"，调休日"班"；
   格内逐行显示当日待办负责人，行数过多时格子内滚动；
   支持按本月人员筛选：点图例后仅高亮该人的待办，其余淡出 */
function renderCalendar() {
  $('#cal-title').textContent = calY + '年' + (calM + 1) + '月';
  const grid = $('#cal-grid');
  grid.innerHTML = '';
  const offset = (new Date(calY, calM, 1).getDay() + 6) % 7;   // 当月 1 号相对周一的偏移
  const startDate = new Date(calY, calM, 1 - offset);
  const todayStr = fmtDate(new Date());
  const personCounts = {};   // 本月各人员待办数（用于图例）
  for (let i = 0; i < 42; i++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
    const key = fmtDate(d);
    const hol = HOLIDAYS[key];                       // 法定节假日/调休
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const isRest = !!(hol && hol.type === 'rest');
    const isWork = !!(hol && hol.type === 'work');
    const dayList = todos[key] || [];
    if (d.getMonth() === calM) {
      dayList.forEach(t => { personCounts[t.person] = (personCounts[t.person] || 0) + 1; });
    }

    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    cell.dataset.date = key;
    if (d.getMonth() !== calM) cell.classList.add('other-month');
    if (isRest) cell.classList.add('cal-hol');
    if (key === todayStr) cell.classList.add('today');
    cell.title = hol ? hol.name + (isRest ? '（放假）' : '（调休上班）') : '';

    const redDay = (isWeekend || isRest) ? ' day-red' : '';
    const badge = isRest ? '<span class="day-badge badge-rest" title="' + esc(hol.name) + '">休</span>'
                : isWork ? '<span class="day-badge badge-work" title="' + esc(hol.name) + '调休，这天要上班">班</span>'
                : '';
    let hasFiltered = false;
    const lines = dayList.map(t => {
      const hit = personFilter && t.person === personFilter;
      if (hit) hasFiltered = true;
      const cls = personFilter ? (hit ? ' hl' : ' dim') : '';
      return '<div class="cal-todo-line' + cls + '" data-person="' + esc(t.person) +
        '" title="点击查看 ' + esc(t.person) + ' 本月待办">' + esc(t.person) + '</div>';
    }).join('');
    if (hasFiltered) cell.classList.add('cell-hl');

    cell.innerHTML =
      '<div class="cal-cell-head"><span class="cal-day' + redDay + '">' + d.getDate() + '</span>' + badge + '</div>' +
      '<div class="cal-todos">' + lines + '</div>';
    grid.appendChild(cell);
  }

  /* 筛选的人员在本月已无待办时自动取消筛选 */
  if (personFilter && !personCounts[personFilter]) personFilter = '';
  renderPersonLegend(personCounts);
}

/* 渲染本月人员图例（点击筛选，再点取消） */
function renderPersonLegend(personCounts) {
  let row = $('#cal-persons');
  if (!row) {   // 日历卡片内动态创建图例容器
    row = document.createElement('div');
    row.className = 'cal-persons';
    row.id = 'cal-persons';
    $('.calendar-card').insertBefore(row, $('.cal-week-header'));
  }
  const persons = Object.keys(personCounts).sort((a, b) => personCounts[b] - personCounts[a] || a.localeCompare(b, 'zh'));
  row.innerHTML = persons.length
    ? '<span class="cp-label">按人员筛选：</span>' + persons.map(p =>
        '<button type="button" class="person-chip' + (personFilter === p ? ' active' : '') + '" data-person="' + esc(p) + '">' +
          esc(p) + '<b>' + personCounts[p] + '</b></button>'
      ).join('') + (personFilter ? '<button type="button" class="person-chip cp-clear" data-person="">× 取消筛选</button>' : '')
    : '';
}
function bindPersonLegend() {
  /* 事件委托绑定在静态存在的日历卡片上：
     图例容器 #cal-persons 是 renderCalendar 时动态创建的，
     若直接对它绑定会在首次初始化时因元素尚不存在而报错 */
  $('.calendar-card').addEventListener('click', e => {
    const chip = e.target.closest('.person-chip');
    if (!chip) return;
    const p = chip.dataset.person;
    personFilter = (personFilter === p) ? '' : p;
    renderCalendar();
  });
}

/* ========== 当日待办管理弹窗（点击日期格打开） ========== */
function openDayModal(dateKey) {
  selectedDate = dateKey;
  editTodoId = '';
  const parts = dateKey.split('-').map(Number);
  const week = '日一二三四五六'[new Date(parts[0], parts[1] - 1, parts[2]).getDay()];
  const hol = HOLIDAYS[dateKey];
  $('#day-modal-title').textContent =
    dateKey.replace(/-/g, '/') + '（周' + week + '）' + (hol && hol.type === 'rest' ? ' · ' + hol.name : '');
  $('#day-person').value = ''; $('#day-content').value = ''; $('#day-remark').value = '';
  renderDayList();
  openModal('#modal-day');
}

function renderDayList() {
  const list = todos[selectedDate] || [];
  $('#day-list').innerHTML = list.length
    ? list.map(t => t.id === editTodoId ? dayEditItemHTML(t) : dayItemHTML(t)).join('')
    : '<div class="empty-state" style="padding:22px 0">该日暂无待办，在上方填写后点击「添加待办」</div>';
}

function dayItemHTML(t) {
  return '<div class="day-item">' +
    '<div class="day-item-main">' +
      '<div class="day-item-head"><span class="tag tag-person">' + esc(t.person) + '</span>' +
        '<span class="day-item-time">' + esc(t.createTime) + '</span></div>' +
      '<div class="day-item-content">' + esc(t.content) + '</div>' +
      (t.remark ? '<div class="day-item-remark">备注：' + esc(t.remark) + '</div>' : '') +
    '</div>' +
    '<div class="day-item-ops">' +
      '<button class="btn btn-ghost btn-xs" data-edit-todo="' + t.id + '">编辑</button>' +
      '<button class="btn btn-danger-ghost btn-xs" data-del-todo="' + t.id + '">删除</button>' +
    '</div>' +
  '</div>';
}

/* 行内编辑态 */
function dayEditItemHTML(t) {
  return '<div class="day-item day-item-editing">' +
    '<div class="day-edit-form">' +
      '<input type="text" id="edit-person" value="' + esc(t.person) + '" placeholder="负责人（必填）">' +
      '<input type="text" id="edit-content" value="' + esc(t.content) + '" placeholder="工作内容（必填）">' +
      '<input type="text" id="edit-remark" value="' + esc(t.remark || '') + '" placeholder="备注（选填）">' +
    '</div>' +
    '<div class="day-item-ops">' +
      '<button class="btn btn-primary btn-xs" data-save-edit="' + t.id + '">保存</button>' +
      '<button class="btn btn-ghost btn-xs" data-cancel-edit="1">取消</button>' +
    '</div>' +
  '</div>';
}

/* 当日弹窗内添加待办 */
function addDayTodo() {
  const person = $('#day-person').value.trim();
  const content = $('#day-content').value.trim();
  const remark = $('#day-remark').value.trim();
  if (!person) return toast('请填写负责人', 'error');
  if (!content) return toast('请填写工作内容', 'error');
  (todos[selectedDate] = todos[selectedDate] || []).push({
    id: uid(), person: person, content: content, remark: remark, createTime: fmtDateTime(new Date())
  });
  saveTodos();
  $('#day-person').value = ''; $('#day-content').value = ''; $('#day-remark').value = '';
  renderCalendar(); renderDayList();
  toast('待办添加成功');
}

/* 当日弹窗内保存行内编辑 */
function saveDayTodoEdit(id) {
  const person = $('#edit-person').value.trim();
  const content = $('#edit-content').value.trim();
  if (!person) return toast('请填写负责人', 'error');
  if (!content) return toast('请填写工作内容', 'error');
  const t = (todos[selectedDate] || []).find(x => x.id === id);
  if (!t) { editTodoId = ''; renderDayList(); return; }
  t.person = person; t.content = content; t.remark = $('#edit-remark').value.trim();
  editTodoId = '';
  saveTodos(); renderCalendar(); renderDayList();
  toast('待办已更新');
}

/* ========== 人员本月待办弹窗（点击日历中的人名打开） ========== */
function openPersonModal(person) {
  const list = [];
  const last = new Date(calY, calM + 1, 0).getDate();
  for (let d = 1; d <= last; d++) {
    const key = fmtDate(new Date(calY, calM, d));
    (todos[key] || []).forEach(t => { if (t.person === person) list.push({ date: key, t }); });
  }
  $('#person-modal-title').textContent = person + ' · ' + (calM + 1) + '月待办（' + list.length + ' 项）';
  $('#person-todo-body').innerHTML = list.length
    ? list.map(({ date, t }) => {
        const hol = HOLIDAYS[date];
        return '<div class="person-day-group">' +
          '<div class="pdg-date">' + date.slice(5).replace('-', ' / ') +
            '<span class="tag tag-gray">' + '周' + '日一二三四五六'[new Date(date + 'T00:00:00').getDay()] + '</span>' +
            (hol && hol.type === 'rest' ? '<span class="tag tag-red">' + hol.name + '</span>' : '') +
          '</div>' +
          '<div class="day-item"><div class="day-item-main">' +
            '<div class="day-item-content">' + esc(t.content) + '</div>' +
            (t.remark ? '<div class="day-item-remark">备注：' + esc(t.remark) + '</div>' : '') +
          '</div></div>' +
        '</div>';
      }).join('')
    : '<div class="empty-state" style="padding:22px 0">' + esc(person) + ' 本月暂无待办</div>';
  openModal('#modal-person');
}

/* =========================================================
   模块二：运营情况（部门 + 多合同，按合同总额排序）
   ========================================================= */
let editingDeptId = null;
/* 部门名称预设建议（可自由填写任意名称，下拉仅为快捷输入） */
const BASE_DEPTS = ['住建局', '交通局', '水务局', '城管局', '应急管理局', '农业农村局'];

function bindOpsEvents() {
  $('#btn-add-dept').addEventListener('click', () => openDeptModal(null));
  $('#f-dept-addcontract').addEventListener('click', () => { addContractBox(); renumberContractBoxes(); });
  $('#f-dept-save').addEventListener('click', saveDept);

  $('#dept-grid').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit-dept]');
    const delBtn = e.target.closest('[data-del-dept]');
    if (editBtn) openDeptModal(depts.find(d => d.id === editBtn.dataset.editDept) || null);
    if (delBtn) {
      const d = depts.find(x => x.id === delBtn.dataset.delDept);
      if (!d) return;
      confirmDialog('确定要删除「' + d.name + '」的全部数据（含 ' + (d.contracts || []).length + ' 份合同）吗？相关指标将同步从汇总中移除。', () => {
        depts = depts.filter(x => x.id !== d.id);
        saveDepts(); renderOps(); refreshDeptOptions();
        toast('部门数据已删除');
      });
    }
  });
}

/* 汇总指标 + 部门看板（默认按合同总额降序，数据变动后自动重新计算） */
function renderOps() {
  const sumAmount = depts.reduce((s, d) => s + deptTotals(d).amount, 0);
  const sumPatrol = depts.reduce((s, d) => s + deptTotals(d).patrol, 0);
  const sumProblems = depts.reduce((s, d) => s + deptTotals(d).problems, 0);
  $('#stat-depts').textContent = formatNum(depts.length);   // 服务部门数（统计卡首位）
  $('#stat-contract').textContent = formatNum(sumAmount);
  $('#stat-patrol').textContent   = formatNum(sumPatrol);
  $('#stat-problem').textContent  = formatNum(sumProblems);
  const sorted = [...depts].sort((a, b) => deptTotals(b).amount - deptTotals(a).amount);
  $('#dept-grid').innerHTML = sorted.length
    ? sorted.map((d, i) => deptCardHTML(d, i + 1)).join('')
    : '<div class="empty-state" style="grid-column:1/-1">暂无部门数据，点击右上角「添加部门数据」开始录入</div>';
}

function deptCardHTML(d, no) {
  const t = deptTotals(d);
  const contractItems = (d.contracts || []).map((c, ci) => {
    const cats = (c.cats || []).map(cat => '<span class="cat-chip">' + esc(cat.name) + '<b>' + formatNum(cat.count) + '</b></span>').join('');
    return '<div class="contract-item">' +
      '<div class="ci-head"><span class="ci-name"><span class="ci-no">' + (ci + 1) + '.</span>' + esc(c.name) + '</span><span class="ci-amount">' + formatNum(c.amount) + ' 万元</span></div>' +
      (c.content ? '<div class="ci-content">' + esc(c.content) + '</div>' : '') +
      '<div class="ci-meta">' +
        '<span class="cat-chip">巡飞<b>' + formatNum(c.patrol) + '</b></span>' +
        '<span class="cat-chip">问题<b>' + formatNum(c.problems) + '</b></span>' +
        cats +
      '</div>' +
    '</div>';
  }).join('');
  const catChips = t.cats.map(cat => '<span class="cat-chip">' + esc(cat.name) + '<b>' + formatNum(cat.count) + '</b></span>').join('');
  return '<div class="card dept-card">' +
    '<div class="dept-head">' +
      '<div class="dept-name"><span class="dept-no">' + no + '</span>' + esc(d.name) + '</div>' +
      '<div class="card-actions">' +
        '<button class="btn btn-ghost btn-xs" data-edit-dept="' + d.id + '">编辑</button>' +
        '<button class="btn btn-danger-ghost btn-xs" data-del-dept="' + d.id + '">删除</button>' +
      '</div>' +
    '</div>' +
    (d.service ? '<div class="dept-service">📌 ' + esc(d.service) + '</div>' : '') +
    '<div class="dept-stats">' +
      '<div><b>' + formatNum(t.amount) + '</b><span>合同额（万元）</span></div>' +
      '<div><b>' + formatNum(t.patrol) + '</b><span>2026年巡飞次数</span></div>' +
      '<div><b>' + formatNum(t.problems) + '</b><span>发现问题（件）</span></div>' +
    '</div>' +
    '<div class="dept-sec-label">合同列表（' + t.count + ' 份）</div>' + contractItems +
    (catChips ? '<div class="dept-sec-label">问题分类汇总</div><div class="chip-row">' + catChips + '</div>' : '') +
  '</div>';
}

/* 部门名称建议（部门弹窗 datalist + 卡点部门 datalist）与运营模块联动 */
function refreshDeptOptions() {
  const names = [...new Set([...BASE_DEPTS, ...depts.map(d => d.name)])];
  $('#dept-name-list').innerHTML = names.map(n => '<option value="' + esc(n) + '"></option>').join('');
  $('#blk-dept-list').innerHTML = names.map(n => '<option value="' + esc(n) + '"></option>').join('');
}

function openDeptModal(dept) {
  editingDeptId = dept ? dept.id : null;
  $('#modal-dept-title').textContent = dept ? '编辑部门数据' : '添加部门数据';
  $('#f-dept-name').value = dept ? dept.name : '';
  $('#f-dept-service').value = dept ? (dept.service || '') : '';
  const wrap = $('#f-dept-contracts');
  wrap.innerHTML = '';
  const list = (dept && dept.contracts && dept.contracts.length) ? dept.contracts : [null];
  list.forEach(c => addContractBox(c && c.name ? c : null));
  renumberContractBoxes();   // 编辑弹窗内的合同块按序号区分（合同 #1 / #2 / #3）
  openModal('#modal-dept');
}

/* 合同编辑块（动态添加/删除，块内含问题分类明细行） */
function addContractBox(c = null) {
  const box = document.createElement('div');
  box.className = 'contract-box';
  const data = c || { name: '', content: '', amount: '', patrol: '', problems: '', cats: [] };
  box.innerHTML =
    '<div class="cb-head"><span class="cb-title">合同</span>' +
      '<button type="button" class="btn btn-danger-ghost btn-xs cb-del">删除合同</button></div>' +
    '<div class="form-row-2">' +
      '<div><label class="cb-label">合同名称</label><input type="text" class="c-name" placeholder="如：城市网格化巡查服务合同" value="' + esc(data.name) + '"></div>' +
      '<div><label class="cb-label">合同额（万元）</label><input type="number" class="c-amount" min="0" step="0.1" placeholder="0" value="' + esc(data.amount) + '"></div>' +
    '</div>' +
    '<div><label class="cb-label">合同内容（具体服务事项）</label><input type="text" class="c-content" placeholder="简述该合同的具体服务内容" value="' + esc(data.content) + '"></div>' +
    '<div class="form-row-2" style="margin-top:8px">' +
      '<div><label class="cb-label">2026年巡飞次数</label><input type="number" class="c-patrol" min="0" step="1" placeholder="0" value="' + esc(data.patrol) + '"></div>' +
      '<div><label class="cb-label">发现问题数（件）</label><input type="number" class="c-problems" min="0" step="1" placeholder="0" value="' + esc(data.problems) + '"></div>' +
    '</div>' +
    '<div class="cb-cats"><label class="cb-label">问题分类明细（选填）</label><div class="c-cats"></div>' +
      '<button type="button" class="btn btn-ghost btn-xs c-addcat">＋ 添加分类</button></div>';
  box.querySelector('.cb-del').addEventListener('click', () => {
    const all = $$('#f-dept-contracts .contract-box');
    if (all.length <= 1) { box.remove(); addContractBox(); }   // 至少保留一个空块
    else box.remove();
    renumberContractBoxes();
  });
  box.querySelector('.c-addcat').addEventListener('click', () => addCatRow(box.querySelector('.c-cats')));
  const catsWrap = box.querySelector('.c-cats');
  const catList = (data.cats && data.cats.length) ? data.cats : [null];
  catList.forEach(cat => addCatRow(catsWrap, cat ? cat.name : '', cat ? cat.count : ''));
  $('#f-dept-contracts').appendChild(box);
}

/* 合同块编号 */
function renumberContractBoxes() {
  $$('#f-dept-contracts .contract-box .cb-title').forEach((el, i) => { el.textContent = '合同 #' + (i + 1); });
}

/* 问题分类明细动态行（可指定容器，供合同块复用） */
function addCatRow(root = $('#f-dept-cats'), name = '', count = '') {
  const row = document.createElement('div');
  row.className = 'cat-row';
  row.innerHTML =
    '<input class="cat-name" type="text" placeholder="分类名称，如：环境污染类" value="' + esc(name) + '">' +
    '<input class="cat-count" type="number" placeholder="数量" min="0" value="' + esc(count) + '">' +
    '<button type="button" class="del-cat" title="删除该分类">×</button>';
  row.querySelector('.del-cat').addEventListener('click', () => row.remove());
  root.appendChild(row);
}

function saveDept() {
  const name = $('#f-dept-name').value.trim();
  if (!name) return toast('请填写部门名称', 'error');
  const contracts = $$('#f-dept-contracts .contract-box').map(box => {
    const cats = $$('.cat-row', box.querySelector('.c-cats'))
      .map(r => ({ name: r.querySelector('.cat-name').value.trim(), count: Math.round(toNum(r.querySelector('.cat-count').value)) }))
      .filter(c => c.name);
    return {
      id: uid(),
      name: box.querySelector('.c-name').value.trim(),
      content: box.querySelector('.c-content').value.trim(),
      amount: toNum(box.querySelector('.c-amount').value),
      patrol: Math.round(toNum(box.querySelector('.c-patrol').value)),
      problems: Math.round(toNum(box.querySelector('.c-problems').value)),
      cats: cats
    };
  }).filter(c => c.name || c.amount > 0 || c.patrol > 0 || c.problems > 0 || c.cats.length);   // 空白合同块丢弃
  if (!contracts.length) return toast('请至少填写一份合同信息', 'error');

  if (editingDeptId) {
    const target = depts.find(x => x.id === editingDeptId);
    if (target) {
      target.name = name;
      target.service = $('#f-dept-service').value.trim();
      target.contracts = contracts.map((c, i) => {
        const old = (target.contracts || [])[i];
        if (old) c.id = old.id;
        return c;
      });
      toast('部门数据已更新');
    }
  } else {
    depts.push({ id: uid(), name: name, service: $('#f-dept-service').value.trim(), contracts: contracts });
    toast('部门数据添加成功');
  }
  saveDepts(); renderOps(); refreshDeptOptions();
  closeModal('#modal-dept');
}

/* =========================================================
   模块三：进度卡点（拖拽排序 + 未开始/进行中/待推进/已解决）
   ========================================================= */
let editingBlockerId = null;
let fBlkDept = '', fBlkPerson = '', fBlkStatus = '';   // 卡点三项筛选（空 = 全部）
const BLK_STATUS_CLASS = { '未开始': 'tag-gray', '进行中': 'tag-blue', '待推进': 'tag-orange', '已解决': 'tag-green' };

function bindBlockerEvents() {
  $('#btn-add-blocker').addEventListener('click', () => openBlockerModal(null));
  $('#f-blk-save').addEventListener('click', saveBlocker);

  ['dept', 'person', 'status'].forEach(key => {
    $('#filter-blk-' + key).addEventListener('change', e => {
      if (key === 'dept') fBlkDept = e.target.value;
      if (key === 'person') fBlkPerson = e.target.value;
      if (key === 'status') fBlkStatus = e.target.value;
      renderBlockers();
    });
  });

  $('#blocker-tbody').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit-blk]');
    const delBtn = e.target.closest('[data-del-blk]');
    if (editBtn) openBlockerModal(blockers.find(b => b.id === editBtn.dataset.editBlk) || null);
    if (delBtn) {
      const b = blockers.find(x => x.id === delBtn.dataset.delBlk);
      if (!b) return;
      confirmDialog('确定要删除卡点「' + b.title + '」吗？删除后不可恢复。', () => {
        blockers = blockers.filter(x => x.id !== b.id);
        saveBlockers(); renderBlockers();
        toast('卡点已删除');
      });
    }
  });

  /* 自定义指针拖拽：按住行首 ⋮⋮ 上下拖动，行实时跟随，松手即保存 */
  enableRowDrag('#blocker-tbody', () => {
    blockers = commitDomOrder($('#blocker-tbody'), blockers, isBlockerVisible);
    saveBlockers(); renderBlockers();
    toast('排序已保存');
  });
}

/* 当前筛选条件下该卡点是否可见 */
function isBlockerVisible(b) {
  return (!fBlkDept || b.department === fBlkDept) &&
         (!fBlkPerson || b.person === fBlkPerson) &&
         (!fBlkStatus || b.status === fBlkStatus);
}

/* 刷新三个筛选下拉的选项（保留当前选中值） */
function refreshBlockerFilters() {
  fillFilter('#filter-blk-dept', blockers.map(b => b.department), fBlkDept);
  fillFilter('#filter-blk-person', blockers.map(b => b.person), fBlkPerson);
  fillFilter('#filter-blk-status', ['未开始', '进行中', '待推进', '已解决'], fBlkStatus);
}
function fillFilter(sel, items, cur) {
  const el = $(sel);
  const uniq = [...new Set(items.filter(Boolean))];
  el.innerHTML = '<option value="">全部</option>' + uniq.map(v =>
    '<option value="' + esc(v) + '"' + (v === cur ? ' selected' : '') + '>' + esc(v) + '</option>'
  ).join('');
}

/* 自定义表格行拖拽（指针实现，替代原生 HTML5 拖拽，不会被文本选择干扰） */
/* 仅可从行首 ⋮⋮ 把手发起；移动中行实时跟随；松手后按 DOM 顺序回调落库 */
function enableRowDrag(tbodySel, onCommit) {
  const tbody = $(tbodySel);
  let st = null;   // { tr, startY, moved }
  tbody.addEventListener('mousedown', e => {
    const handle = e.target.closest('.drag-handle');
    if (!handle || e.button !== 0) return;
    const tr = handle.closest('tr[data-id]');
    if (!tr) return;
    st = { tr, startY: e.clientY, moved: false };
    e.preventDefault();   // 防止触发文本选择
  });
  document.addEventListener('mousemove', e => {
    if (!st) return;
    /* 拖拽中的行已被移出表格（如中途被重新渲染）时放弃本次拖拽 */
    if (!tbody.contains(st.tr)) { st = null; return; }
    if (!st.moved && Math.abs(e.clientY - st.startY) < 4) return;
    if (!st.moved) { st.moved = true; st.tr.classList.add('dragging', 'drag-floating'); document.body.style.cursor = 'grabbing'; }
    const rect = tbody.getBoundingClientRect();
    if (e.clientY < rect.top - 16 || e.clientY > rect.bottom + 16) return;
    const others = [...tbody.querySelectorAll('tr[data-id]')].filter(r => r !== st.tr);
    const target = others.find(r => {
      const rc = r.getBoundingClientRect();
      return e.clientY >= rc.top && e.clientY <= rc.bottom;
    });
    if (target) {
      const rc = target.getBoundingClientRect();
      tbody.insertBefore(st.tr, e.clientY < rc.top + rc.height / 2 ? target : target.nextSibling);
    }
  });
  document.addEventListener('mouseup', () => {
    if (!st) return;
    const { tr, moved } = st;
    st = null;
    document.body.style.cursor = '';
    tr.classList.remove('dragging', 'drag-floating');
    if (moved) onCommit();
  });
}

/* 按当前 DOM 行顺序重排数组：可见行以 DOM 顺序为准，被筛选隐藏的行保持原相对位置。
   任何不一致（行数不符、id 重复、缺失）都直接放弃本次排序，避免数据被破坏 */
function commitDomOrder(tbody, arr, isVisible) {
  const domIds = [...tbody.querySelectorAll('tr[data-id]')].map(r => r.dataset.id);
  const visibleItems = arr.filter(isVisible);
  const consistent = domIds.length === visibleItems.length &&
    new Set(domIds).size === domIds.length &&
    domIds.every(id => visibleItems.some(x => x.id === id));
  if (!consistent) return arr;
  const orderedVisible = domIds.map(id => visibleItems.find(x => x.id === id));
  const result = [];
  let di = 0;
  arr.forEach(item => { result.push(isVisible(item) ? orderedVisible[di++] : item); });
  return result;
}

function renderBlockers() {
  refreshBlockerFilters();
  const list = blockers.filter(isBlockerVisible);
  $('#blocker-tbody').innerHTML = list.map((b, i) =>
    '<tr data-id="' + b.id + '">' +
      '<td>' + (i + 1) + '</td>' +
      '<td class="drag-handle" title="按住拖动调整顺序">⋮⋮</td>' +
      '<td>' + esc(b.department) + '</td>' +
      '<td class="td-title">' + esc(b.title) + '</td>' +
      '<td class="td-wrap">' + esc(b.progress) + '</td>' +
      '<td>' + esc(b.person) + '</td>' +
      '<td class="td-wrap">' + (b.help ? esc(b.help) : '—') + '</td>' +
      '<td><span class="tag ' + (BLK_STATUS_CLASS[b.status] || 'tag-gray') + '">' + esc(b.status) + '</span></td>' +
      '<td class="td-time">' + esc(b.updateTime) + '</td>' +
      '<td class="td-ops">' +
        '<button class="btn btn-ghost btn-xs" data-edit-blk="' + b.id + '">编辑</button>' +
        '<button class="btn btn-danger-ghost btn-xs" data-del-blk="' + b.id + '">删除</button>' +
      '</td>' +
    '</tr>'
  ).join('');
  const empty = $('#blocker-empty');
  if (!blockers.length) {
    empty.textContent = '暂无卡点记录，点击右上角「添加卡点」开始记录';
    empty.style.display = '';
  } else if (!list.length) {
    empty.textContent = '没有符合筛选条件的卡点';
    empty.style.display = '';
  } else {
    empty.style.display = 'none';
  }
}

function openBlockerModal(b) {
  editingBlockerId = b ? b.id : null;
  $('#modal-blocker-title').textContent = b ? '编辑卡点' : '添加卡点';
  $('#f-blk-title').value = b ? b.title : '';
  $('#f-blk-dept').value = b ? b.department : '';
  $('#f-blk-progress').value = b ? b.progress : '';
  $('#f-blk-person').value = b ? b.person : '';
  $('#f-blk-help').value = b ? (b.help || '') : '';
  $('#f-blk-status').value = b ? b.status : '进行中';
  openModal('#modal-blocker');
}

function saveBlocker() {
  const title = $('#f-blk-title').value.trim();
  const progress = $('#f-blk-progress').value.trim();
  const person = $('#f-blk-person').value.trim();
  const department = $('#f-blk-dept').value.trim();
  if (!title) return toast('请填写问题/事项名称', 'error');
  if (!department) return toast('请填写所属部门', 'error');
  if (!progress) return toast('请填写进展情况', 'error');
  if (!person) return toast('请填写负责人', 'error');
  const data = {
    title: title,
    department: department,
    progress: progress,
    person: person,
    help: $('#f-blk-help').value.trim(),
    status: $('#f-blk-status').value,
    updateTime: fmtDate(new Date())
  };
  if (editingBlockerId) {
    const target = blockers.find(x => x.id === editingBlockerId);
    if (target) { Object.assign(target, data); toast('卡点已更新'); }
  } else {
    /* 新增：同部门归类——已有该部门的卡点时插入到该部门分组的最前面 */
    const idx = blockers.findIndex(b => b.department === department);
    const item = Object.assign({ id: uid() }, data);
    if (idx > -1) blockers.splice(idx, 0, item);
    else blockers.push(item);
    toast('卡点添加成功' + (idx > -1 ? '（已归类到「' + department + '」分组）' : ''));
  }
  saveBlockers(); renderBlockers();
  closeModal('#modal-blocker');
}

/* =========================================================
   模块四：来年统采（表格 + 拖拽排序）
   ========================================================= */
let currentProcTab = '已落地';
let editingProcId = null;
const expandedProcIds = new Set();      // 当前展开详情的需求行（点击行展开/收缩）
const collapsedProcUnits = new Set();   // 收起的需求分组（按单位/部门）
const FOLLOW_CLASS = { '初步接触': 'tag-cyan', '方案编制中': 'tag-blue', '待报价': 'tag-orange', '待决策': 'tag-purple' };

function bindProcEvents() {
  $$('.proc-tab').forEach(t => t.addEventListener('click', () => {
    currentProcTab = t.dataset.tab;
    renderProc();
  }));
  $('#btn-add-proc').addEventListener('click', () => openProcModal(null));
  $('#f-proc-cat').addEventListener('change', toggleProcFollow);
  $('#f-proc-save').addEventListener('click', saveProc);

  $('#proc-tbody').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit-proc]');
    const delBtn = e.target.closest('[data-del-proc]');
    if (editBtn) openProcModal(procs.find(p => p.id === editBtn.dataset.editProc) || null);
    if (delBtn) {
      const p = procs.find(x => x.id === delBtn.dataset.delProc);
      if (!p) return;
      confirmDialog('确定要删除需求「' + p.name + '」吗？删除后不可恢复。', () => {
        procs = procs.filter(x => x.id !== p.id);
        saveProcs(); renderProc();
        toast('需求已删除');
      });
      return;
    }
    /* 部门分组行：添加子需求 / 重命名部门 / 展开收起 */
    const groupHead = e.target.closest('.proc-group');
    if (groupHead) {
      const unit = groupHead.dataset.unit;
      if (e.target.closest('[data-g-add]')) { openProcModalForUnit(unit); return; }
      if (e.target.closest('[data-g-rename]')) { openUnitRename(unit); return; }
      if (collapsedProcUnits.has(unit)) collapsedProcUnits.delete(unit); else collapsedProcUnits.add(unit);
      renderProc();
      return;
    }
    /* 点击需求行其他位置：展开/收缩该条需求的详情（服务需求描述与备注） */
    if (e.target.closest('.drag-handle')) return;
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const id = tr.dataset.id;
    if (expandedProcIds.has(id)) expandedProcIds.delete(id); else expandedProcIds.add(id);
    renderProc();
  });

  /* 部门重命名弹窗保存 */
  $('#f-unit-save').addEventListener('click', saveUnitRename);
  $('#f-unit-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveUnitRename(); });

  /* 自定义指针拖拽：在当前分类清单内部调整顺序（收起的分组不参与） */
  enableRowDrag('#proc-tbody', () => {
    procs = commitDomOrder($('#proc-tbody'), procs, isProcVisible);
    saveProcs(); renderProc();
    toast('排序已保存');
  });
}

/* 该需求当前是否显示在表格中（分类匹配且所在分组未收起） */
function isProcVisible(p) {
  return p.category === currentProcTab && !collapsedProcUnits.has(p.unit);
}

/* 在指定部门下新增子需求（打开需求弹窗并锁定单位） */
function openProcModalForUnit(unit) {
  openProcModal(null);
  const input = $('#f-proc-unit');
  input.value = unit;
  input.readOnly = true;
  input.style.background = '#F1F5F9';
  input.title = '单位已锁定为该部门（组内添加）';
  toast('正在为「' + unit + '」添加子需求，单位已锁定', 'info');
}

/* 重命名部门：该部门下所有需求（含其他清单分类）同步更新 */
let renamingUnit = '';
function openUnitRename(unit) {
  renamingUnit = unit;
  $('#f-unit-name').value = unit;
  openModal('#modal-unit');
  setTimeout(() => $('#f-unit-name').select(), 60);
}
function saveUnitRename() {
  const name = $('#f-unit-name').value.trim();
  if (!name) return toast('请填写部门名称', 'error');
  if (name === renamingUnit) { closeModal('#modal-unit'); return; }
  let n = 0;
  procs.forEach(p => { if (p.unit === renamingUnit) { p.unit = name; n++; } });
  if (collapsedProcUnits.has(renamingUnit)) {
    collapsedProcUnits.delete(renamingUnit);
    collapsedProcUnits.add(name);
  }
  saveProcs(); renderProc();
  closeModal('#modal-unit');
  toast('已重命名为「' + name + '」，同步更新 ' + n + ' 项需求');
}

function renderProc() {
  const counts = {};
  procs.forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });
  $$('.proc-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === currentProcTab);
    t.querySelector('.tab-count').textContent = counts[t.dataset.tab] || 0;
  });
  /* 按单位/部门分组展示：分组头（可添加子需求/重命名）+ 组内子需求；子需求全部删除后分组自动消失 */
  const list = procs.filter(p => p.category === currentProcTab);
  const groups = [];
  list.forEach(p => {
    let g = groups.find(x => x.unit === p.unit);
    if (!g) { g = { unit: p.unit, items: [] }; groups.push(g); }
    g.items.push(p);
  });
  let html = '';
  let seq = 0;
  groups.forEach(g => {
    const collapsed = collapsedProcUnits.has(g.unit);
    /* 预算合计：组内所有子需求预算求和（未填预算的子需求不计入） */
    const budgetSum = g.items.reduce((s, p) => s + (p.budget != null ? Number(p.budget) || 0 : 0), 0);
    const budgetText = budgetSum > 0 ? '合计 ' + formatNum(budgetSum) + ' 万' : '待定';
    html += '<tr class="proc-group" data-unit="' + esc(g.unit) + '">' +
      '<td colspan="2"><div class="g-row">' +
          '<span class="expand-caret">' + (collapsed ? '▸' : '▾') + '</span> ' +
          '<span class="g-unit">' + esc(g.unit) + '</span>' +
      '</div></td>' +
      '<td class="g-count-cell"><span class="g-count">' + g.items.length + ' 项需求</span></td>' +
      '<td colspan="3"></td>' +
      '<td class="g-budget-cell">' + budgetText + '</td>' +
      '<td colspan="2"><div class="g-ops">' +
          '<button type="button" class="btn btn-ghost btn-xs" data-g-add title="在该部门下新增子需求">＋ 子需求</button>' +
          '<button type="button" class="btn btn-ghost btn-xs" data-g-rename title="重命名该部门">重命名</button>' +
      '</div></td>' +
    '</tr>';
    if (!collapsed) {
      g.items.forEach(p => { html += procRowHTML(p, ++seq); });
    }
  });
  $('#proc-tbody').innerHTML = html;
  $('#proc-empty').style.display = list.length ? 'none' : '';
}

function procRowHTML(p, seq) {
  const danger = p.category === '未对接';
  const expanded = expandedProcIds.has(p.id);
  return '<tr data-id="' + p.id + '" class="' + (danger ? 'row-danger' : '') + (expanded ? ' tr-expanded' : '') + '">' +
    '<td>' + seq + '</td>' +
    '<td class="drag-handle" title="按住拖动调整顺序（组内）">⋮⋮</td>' +
    '<td class="td-title"><span class="expand-caret">' + (expanded ? '▾' : '▸') + '</span> ' + esc(p.name) +
      (danger ? ' <span class="tag tag-red">重点关注</span>' : '') +
      (p.category !== '已落地' && p.follow ? ' <span class="tag ' + (FOLLOW_CLASS[p.follow] || 'tag-gray') + '">' + esc(p.follow) + '</span>' : '') + '</td>' +
    '<td class="td-wrap td-clamp">' + esc(p.service) + '</td>' +
    '<td>' + esc(p.region) + '</td>' +
    '<td>' + esc(p.freq) + '</td>' +
    '<td>' + (p.budget != null ? formatNum(p.budget) : '待定') + '</td>' +
    '<td class="td-wrap td-clamp">' + (p.remark ? esc(p.remark) : '—') + '</td>' +
    '<td class="td-ops">' +
      '<button class="btn btn-ghost btn-xs" data-edit-proc="' + p.id + '">编辑</button>' +
      '<button class="btn btn-danger-ghost btn-xs" data-del-proc="' + p.id + '">删除</button>' +
    '</td>' +
  '</tr>';
}

/* 跟进状态仅"潜在合作 / 未对接"显示 */
function toggleProcFollow() {
  $('#f-proc-follow-item').style.display = $('#f-proc-cat').value === '已落地' ? 'none' : '';
}

function openProcModal(p) {
  editingProcId = p ? p.id : null;
  $('#modal-proc-title').textContent = p ? '编辑需求' : '添加需求';
  $('#f-proc-cat').value = p ? p.category : currentProcTab;
  $('#f-proc-name').value = p ? p.name : '';
  $('#f-proc-unit').value = p ? p.unit : '';
  $('#f-proc-unit').readOnly = false;          // 解除组内添加的单位锁定
  $('#f-proc-unit').style.background = '';
  $('#f-proc-unit').title = '';
  $('#f-proc-service').value = p ? p.service : '';
  $('#f-proc-region').value = p ? p.region : '';
  $('#f-proc-freq').value = p ? p.freq : '';
  $('#f-proc-budget').value = (p && p.budget != null) ? p.budget : '';
  $('#f-proc-follow').value = p ? (p.follow || '初步接触') : '初步接触';
  $('#f-proc-remark').value = p ? (p.remark || '') : '';
  toggleProcFollow();
  openModal('#modal-proc');
}

function saveProc() {
  const cat = $('#f-proc-cat').value;
  const name = $('#f-proc-name').value.trim();
  const unit = $('#f-proc-unit').value.trim();
  const service = $('#f-proc-service').value.trim();
  const region = $('#f-proc-region').value.trim();
  const freq = $('#f-proc-freq').value.trim();
  if (!name) return toast('请填写需求名称', 'error');
  if (!unit) return toast('请填写对应单位', 'error');
  if (!service) return toast('请填写服务需求描述', 'error');
  if (!region) return toast('请填写服务区域', 'error');
  if (!freq) return toast('请填写服务频次', 'error');
  const rawBudget = $('#f-proc-budget').value.trim();
  const data = {
    category: cat, name: name, unit: unit, service: service, region: region, freq: freq,
    budget: rawBudget === '' ? null : toNum(rawBudget, null),
    follow: cat === '已落地' ? '' : $('#f-proc-follow').value,
    remark: $('#f-proc-remark').value.trim()
  };
  if (editingProcId) {
    const target = procs.find(x => x.id === editingProcId);
    if (target) { Object.assign(target, data); toast('需求已更新'); }
  } else {
    procs.push(Object.assign({ id: uid() }, data));
    toast('需求添加成功');
  }
  saveProcs();
  currentProcTab = cat;   // 保存后自动切换到该需求所属清单
  renderProc();
  closeModal('#modal-proc');
}

/* =========================================================
   通用弹窗 / 二次确认 / 轻提示
   ========================================================= */
function openModal(sel) {
  const m = $(sel);
  if (m) { m.classList.add('show'); document.body.style.overflow = 'hidden'; }
}
function closeModal(sel) {
  const m = typeof sel === 'string' ? $(sel) : sel;
  if (m) m.classList.remove('show');
  if (!$$('.modal-overlay.show').length) document.body.style.overflow = '';
}
function bindModalEvents() {
  $$('.modal-overlay').forEach(ov => ov.addEventListener('click', e => {
    if (e.target === ov) closeModal(ov);   // 点击遮罩关闭
  }));
  $$('.modal-close, [data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.closest('.modal-overlay'))));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') $$('.modal-overlay.show').forEach(m => closeModal(m));
  });
}

let confirmCallback = null;
function confirmDialog(msg, cb) {
  $('#confirm-msg').textContent = msg;
  confirmCallback = cb;
  openModal('#modal-confirm');
}

let toastTimer = null;
function toast(msg, type = 'success') {
  let box = $('#toast');
  if (!box) { box = document.createElement('div'); box.id = 'toast'; document.body.appendChild(box); }
  box.textContent = msg;
  box.className = 'toast show toast-' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('show'), 2200);
}

/* =========================================================
   初始化入口
   ========================================================= */
function renderAllModules() {
  renderCalendar();
  renderOps();
  renderBlockers();
  renderProc();
}

/* =========================================================
   登录门（登录码访问控制）
   ========================================================= */
const ACCESS_CODE = 'fy2026';
const AUTH_KEY = 'fengyun_auth';
const isAuthed = () => localStorage.getItem(AUTH_KEY) === '1';

function bindLogin() {
  document.body.classList.add('not-authed');
  $('#login-form').addEventListener('submit', e => {
    e.preventDefault();
    const code = $('#login-code').value.trim();
    const card = document.querySelector('.login-card');
    if (code === ACCESS_CODE) {
      localStorage.setItem(AUTH_KEY, '1');
      document.body.classList.remove('not-authed');
      const screen = $('#login-screen');
      screen.classList.add('login-out');   // 淡出过渡
      setTimeout(() => screen.remove(), 350);
      initApp();
      toast('欢迎回来', 'success');
    } else {
      $('#login-error').textContent = '登录码不正确，请重新输入';
      card.classList.remove('shake');
      void card.offsetWidth;                            // 重触发抖动动画
      card.classList.add('shake');
      $('#login-code').value = '';
      $('#login-code').focus();
    }
  });
}

/* 退出登录：清除标识并回到登录页 */
function logout() {
  localStorage.removeItem(AUTH_KEY);
  location.reload();
}

async function init() {
  /* 登录门：未通过登录码时不初始化、不显示系统内容 */
  if (!isAuthed()) { bindLogin(); return; }
  const loginOverlay = document.querySelector('#login-screen');
  if (loginOverlay) loginOverlay.remove();   // 已登录：直接移除登录遮罩

  initApp();
}

async function initApp() {
  loadLocalAll();     // 先从 localStorage 恢复（无数据用默认示例），保证首屏即时渲染
  bindNav();
  bindModalEvents();
  bindTodoEvents();
  bindOpsEvents();
  bindBlockerEvents();
  bindProcEvents();
  bindDataEvents();
  $('#confirm-ok').addEventListener('click', () => {
    const cb = confirmCallback; confirmCallback = null;
    closeModal('#modal-confirm');
    if (cb) cb();
  });
  $('#login-btn').addEventListener('click', logout);   // 退出登录

  const now = new Date();
  calY = now.getFullYear(); calM = now.getMonth();
  selectedDate = fmtDate(now);

  tickClock();
  setInterval(tickClock, 1000);   // 顶栏时钟每秒刷新

  bindPersonLegend();
  refreshDeptOptions();
  renderAllModules();
  updateDataUI();

  /* 异步探测存储模式（服务器共享 / 目录绑定），完成后以远程数据为准重绘 */
  try {
    await upgradeStorage();
  } catch (e) {
    console.error('存储模式探测失败：', e);
  }
  renderAllModules();
  updateDataUI();
}
init();
