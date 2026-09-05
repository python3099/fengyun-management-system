'use strict';
/* =========================================================
   广东丰云智能科技有限公司管理系统 - 应用脚本
   数据存储适配层支持三种模式（自动检测，可手动绑定）：
     1. server - 服务器共享模式：经 server.js 的 /api/data 读写服务器 data/*.json
     2. file   - 目录绑定模式  ：通过 File System Access API 写入本地项目 data/ 目录
     3. local  - 浏览器本地模式：localStorage（兜底方案，始终作为镜像缓存）
   ========================================================= */

const APP_VERSION = '1.1.0';

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
      id: uid(), name: '城市治理事业部', service: '城市网格化巡查',
      contract: 320, patrol: 1856, problems: 423,
      cats: [
        { name: '环境污染类', count: 156 },
        { name: '违章建筑类', count: 132 },
        { name: '市容秩序类', count: 135 }
      ],
      projects: ['XX区城市网格巡查项目', '中心城区违建排查项目', '重点区域市容巡飞项目']
    },
    {
      id: uid(), name: '生态环境事业部', service: '水域生态监测',
      contract: 280, patrol: 1230, problems: 267,
      cats: [
        { name: '水体污染类', count: 98 },
        { name: '非法排污类', count: 87 },
        { name: '生态破坏类', count: 82 }
      ],
      projects: ['XX河涌水质航拍监测项目', '饮用水源地巡查项目']
    }
  ];
}
function defaultBlockers() {
  return [
    { id: uid(), title: '空域审批流程待明确', department: '城市治理事业部', progress: '已与空管部门初步沟通，等待正式批复意见', person: '李四', help: '需协调局方加快审批进度', status: '进行中', updateTime: '2026-09-03' },
    { id: uid(), title: '巡飞电池组采购到货延迟', department: '生态环境事业部', progress: '供应商已发货，预计 9 月 10 日到货', person: '王五', help: '需采购部跟进物流并协调备机', status: '待推进', updateTime: '2026-09-01' },
    { id: uid(), title: '河涌监测数据接口联调', department: '生态环境事业部', progress: '接口已打通，历史数据校验通过，已交付使用', person: '赵六', help: '', status: '已解决', updateTime: '2026-08-28' }
  ];
}
function defaultProcurement() {
  return [
    { id: uid(), category: '已落地', name: '城市网格化巡查服务', unit: '城市治理事业部', service: '全市建成区网格化航拍巡查，覆盖违建、市容、环卫等问题采集', region: '全市 21 个街道', freq: '每周两次', budget: 320, follow: '', remark: '已签订年度服务合同' },
    { id: uid(), category: '已落地', name: '水域生态监测服务', unit: '生态环境事业部', service: '重点河涌水质航拍监测、排污口排查与蓝藻识别', region: '中心城区及重点流域', freq: '每月一次', budget: 280, follow: '', remark: '含月度数据报告' },
    { id: uid(), category: '潜在合作', name: '应急消防空中侦察支持', unit: '应急管理事业部', service: '火情侦察、灾害现场航拍建模、应急演练空中保障', region: '粤东片区', freq: '季度巡检', budget: null, follow: '方案编制中', remark: '待应急局立项评审' },
    { id: uid(), category: '潜在合作', name: '高标准农田航拍测绘', unit: '农业农村事业部', service: '农田地块航拍建模、作物长势监测与产量预估', region: '2 个试点县区', freq: '每月一次', budget: 150, follow: '初步接触', remark: '已完成现场踏勘' },
    { id: uid(), category: '未对接', name: '森林防火巡查需求', unit: '市林业局', service: '重点林区防火巡飞、烟点识别与热成像监测', region: '北部山区林场', freq: '每周一次', budget: null, follow: '待决策', remark: '需先对接林政科明确巡飞范围' },
    { id: uid(), category: '未对接', name: '城市违建智能识别试点', unit: '市城市综合执法局', service: '违章建筑航拍识别与变化对比分析', region: '主城区 3 个街道', freq: '每月一次', budget: null, follow: '初步接触', remark: '拟结合现有网格巡查数据开展试点' }
  ];
}
const DEFAULT_FACTORIES = { todos: defaultTodos, departments: defaultDepartments, blockers: defaultBlockers, procurement: defaultProcurement };

/* 校验远程数据结构，非法则返回 null（保留本地数据） */
function validateModuleData(name, v) {
  if (v == null) return null;
  if (name === 'todos') {
    if (typeof v !== 'object' || Array.isArray(v)) return null;
    return v;
  }
  if (!Array.isArray(v)) return null;
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
let editTodoDate = '';      // 正在编辑的待办所属日期
let editTodoId = '';        // 正在编辑的待办 id

function bindTodoEvents() {
  $('#cal-prev').addEventListener('click', () => shiftMonth(-1));
  $('#cal-next').addEventListener('click', () => shiftMonth(1));
  $('#cal-today').addEventListener('click', () => {
    const now = new Date();
    calY = now.getFullYear(); calM = now.getMonth();
    selectedDate = fmtDate(now);
    renderCalendar(); renderTodoPanel();
  });
  $('#todo-form').addEventListener('submit', e => { e.preventDefault(); addTodo(); });
  $('#todo-edit-save').addEventListener('click', saveTodoEdit);

  /* 待办列表内编辑/删除（事件委托） */
  $('#todo-list').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit-todo]');
    const delBtn = e.target.closest('[data-del-todo]');
    if (editBtn) openTodoEdit(editBtn.dataset.editTodo);
    if (delBtn) {
      const id = delBtn.dataset.delTodo;
      const t = (todos[selectedDate] || []).find(x => x.id === id);
      confirmDialog('确定要删除「' + ((t && t.content) || '') + '」这条待办吗？删除后不可恢复。', () => {
        todos[selectedDate] = (todos[selectedDate] || []).filter(x => x.id !== id);
        if (!todos[selectedDate].length) delete todos[selectedDate];
        saveTodos(); renderCalendar(); renderTodoPanel();
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

/* 渲染月视图日历（7 列 × 6 行，周一为每周第一天） */
function renderCalendar() {
  $('#cal-title').textContent = calY + '年' + (calM + 1) + '月';
  const grid = $('#cal-grid');
  grid.innerHTML = '';
  const offset = (new Date(calY, calM, 1).getDay() + 6) % 7;   // 当月 1 号相对周一的偏移
  const startDate = new Date(calY, calM, 1 - offset);
  const todayStr = fmtDate(new Date());
  for (let i = 0; i < 42; i++) {
    const d = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + i);
    const key = fmtDate(d);
    const hasTodo = (todos[key] || []).length > 0;
    const cell = document.createElement('div');
    cell.className = 'cal-cell';
    if (d.getMonth() !== calM) cell.classList.add('other-month');
    if (key === todayStr) cell.classList.add('today');
    if (key === selectedDate) cell.classList.add('selected');
    cell.innerHTML = '<span class="cal-day">' + d.getDate() + '</span>' + (hasTodo ? '<span class="cal-dot" title="当日有待办"></span>' : '');
    cell.addEventListener('click', () => {
      selectedDate = key;
      if (d.getMonth() !== calM) { calY = d.getFullYear(); calM = d.getMonth(); }  // 点击相邻月份日期时自动切换月份
      renderCalendar(); renderTodoPanel();
    });
    grid.appendChild(cell);
  }
}

/* 渲染选中日期的待办面板 */
function renderTodoPanel() {
  const parts = selectedDate.split('-').map(Number);
  const week = '日一二三四五六'[new Date(parts[0], parts[1] - 1, parts[2]).getDay()];
  $('#todo-date-title').textContent = selectedDate + '（周' + week + '）待办事项';
  const list = todos[selectedDate] || [];
  $('#todo-count').textContent = list.length + ' 项';
  $('#todo-list').innerHTML = list.length
    ? list.map(todoItemHTML).join('')
    : '<div class="empty-state">该日暂无待办，请在上方表单中添加</div>';
}

function todoItemHTML(t) {
  return '<div class="todo-item">' +
    '<div class="todo-left">' +
      '<span class="tag tag-person">' + esc(t.person) + '</span>' +
      '<div class="todo-texts">' +
        '<div class="todo-content">' + esc(t.content) + '</div>' +
        (t.remark ? '<div class="todo-remark">备注：' + esc(t.remark) + '</div>' : '') +
        '<div class="todo-time">添加时间：' + esc(t.createTime) + '</div>' +
      '</div>' +
    '</div>' +
    '<div class="todo-ops">' +
      '<button class="btn btn-ghost btn-xs" data-edit-todo="' + t.id + '">编辑</button>' +
      '<button class="btn btn-danger-ghost btn-xs" data-del-todo="' + t.id + '">删除</button>' +
    '</div>' +
  '</div>';
}

/* 添加待办（写入当前选中日期） */
function addTodo() {
  const person = $('#todo-person').value.trim();
  const content = $('#todo-content').value.trim();
  const remark = $('#todo-remark').value.trim();
  if (!person) return toast('请填写负责人', 'error');
  if (!content) return toast('请填写工作内容', 'error');
  (todos[selectedDate] = todos[selectedDate] || []).push({
    id: uid(), person: person, content: content, remark: remark, createTime: fmtDateTime(new Date())
  });
  saveTodos();
  $('#todo-person').value = ''; $('#todo-content').value = ''; $('#todo-remark').value = '';
  renderCalendar(); renderTodoPanel();
  toast('待办添加成功');
}

function openTodoEdit(id) {
  const t = (todos[selectedDate] || []).find(x => x.id === id);
  if (!t) return;
  editTodoDate = selectedDate; editTodoId = id;
  $('#e-todo-person').value = t.person;
  $('#e-todo-content').value = t.content;
  $('#e-todo-remark').value = t.remark || '';
  openModal('#modal-todo');
}

function saveTodoEdit() {
  const person = $('#e-todo-person').value.trim();
  const content = $('#e-todo-content').value.trim();
  if (!person) return toast('请填写负责人', 'error');
  if (!content) return toast('请填写工作内容', 'error');
  const t = (todos[editTodoDate] || []).find(x => x.id === editTodoId);
  if (!t) { closeModal('#modal-todo'); return; }
  t.person = person; t.content = content; t.remark = $('#e-todo-remark').value.trim();
  saveTodos(); renderCalendar(); renderTodoPanel();
  closeModal('#modal-todo');
  toast('待办已更新');
}

/* =========================================================
   模块二：运营情况
   ========================================================= */
let editingDeptId = null;
const BASE_DEPTS = ['城市治理事业部', '生态环境事业部', '应急管理事业部', '农业农村事业部', '智慧交通事业部', '低空经济事业部'];

function bindOpsEvents() {
  $('#btn-add-dept').addEventListener('click', () => openDeptModal(null));
  $('#f-dept-addcat').addEventListener('click', () => addCatRow());
  $('#f-dept-save').addEventListener('click', saveDept);

  $('#dept-grid').addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit-dept]');
    const delBtn = e.target.closest('[data-del-dept]');
    if (editBtn) openDeptModal(depts.find(d => d.id === editBtn.dataset.editDept) || null);
    if (delBtn) {
      const d = depts.find(x => x.id === delBtn.dataset.delDept);
      if (!d) return;
      confirmDialog('确定要删除「' + d.name + '」的全部数据吗？相关指标将同步从汇总中移除。', () => {
        depts = depts.filter(x => x.id !== d.id);
        saveDepts(); renderOps(); refreshDeptOptions();
        toast('部门数据已删除');
      });
    }
  });
}

/* 汇总指标 + 部门看板（数据变动后自动重新计算） */
function renderOps() {
  const sum = fn => depts.reduce((s, d) => s + (Number(fn(d)) || 0), 0);
  $('#stat-contract').textContent = formatNum(sum(d => d.contract));
  $('#stat-patrol').textContent   = formatNum(sum(d => d.patrol));
  $('#stat-problem').textContent  = formatNum(sum(d => d.problems));
  $('#stat-project').textContent  = formatNum(sum(d => (d.projects || []).length));
  $('#dept-grid').innerHTML = depts.length
    ? depts.map(deptCardHTML).join('')
    : '<div class="empty-state" style="grid-column:1/-1">暂无部门数据，点击右上角「添加部门数据」开始录入</div>';
}

function deptCardHTML(d) {
  const cats = (d.cats || []).map(c => '<span class="cat-chip">' + esc(c.name) + '<b>' + formatNum(c.count) + '</b></span>').join('');
  const projs = (d.projects || []).map(p => '<span class="proj-chip">' + esc(p) + '</span>').join('');
  return '<div class="card dept-card">' +
    '<div class="dept-head">' +
      '<div class="dept-name">' + esc(d.name) + '</div>' +
      '<div class="card-actions">' +
        '<button class="btn btn-ghost btn-xs" data-edit-dept="' + d.id + '">编辑</button>' +
        '<button class="btn btn-danger-ghost btn-xs" data-del-dept="' + d.id + '">删除</button>' +
      '</div>' +
    '</div>' +
    (d.service ? '<div class="dept-service">📌 ' + esc(d.service) + '</div>' : '') +
    '<div class="dept-stats">' +
      '<div><b>' + formatNum(d.contract) + '</b><span>合同额（万元）</span></div>' +
      '<div><b>' + formatNum(d.patrol) + '</b><span>2026年巡飞次数</span></div>' +
      '<div><b>' + formatNum(d.problems) + '</b><span>发现问题（件）</span></div>' +
    '</div>' +
    (cats ? '<div class="dept-sec-label">问题分类明细</div><div class="chip-row">' + cats + '</div>' : '') +
    (projs ? '<div class="dept-sec-label">运营项目（' + (d.projects || []).length + '个）</div><div class="chip-row">' + projs + '</div>' : '') +
  '</div>';
}

/* 部门名称候选项（datalist + 卡点表单下拉）与运营模块联动 */
function refreshDeptOptions() {
  const names = [...new Set([...BASE_DEPTS, ...depts.map(d => d.name)])];
  $('#dept-name-list').innerHTML = names.map(n => '<option value="' + esc(n) + '"></option>').join('');
  const sel = $('#f-blk-dept');
  const cur = sel.value;
  sel.innerHTML = names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
  if (names.includes(cur)) sel.value = cur;
}

function openDeptModal(dept) {
  editingDeptId = dept ? dept.id : null;
  $('#modal-dept-title').textContent = dept ? '编辑部门数据' : '添加部门数据';
  $('#f-dept-name').value = dept ? dept.name : '';
  $('#f-dept-service').value = dept ? (dept.service || '') : '';
  $('#f-dept-contract').value = dept ? dept.contract : '';
  $('#f-dept-patrol').value = dept ? dept.patrol : '';
  $('#f-dept-problem').value = dept ? dept.problems : '';
  $('#f-dept-cats').innerHTML = '';
  const catList = (dept && dept.cats && dept.cats.length) ? dept.cats : [null];
  catList.forEach(c => addCatRow(c ? c.name : '', c ? c.count : ''));
  $('#f-dept-projects').value = dept && dept.projects ? dept.projects.join('，') : '';
  openModal('#modal-dept');
}

/* 问题分类明细动态行 */
function addCatRow(name = '', count = '') {
  const row = document.createElement('div');
  row.className = 'cat-row';
  row.innerHTML =
    '<input class="cat-name" type="text" placeholder="分类名称，如：环境污染类" value="' + esc(name) + '">' +
    '<input class="cat-count" type="number" placeholder="数量" min="0" value="' + esc(count) + '">' +
    '<button type="button" class="del-cat" title="删除该分类">×</button>';
  row.querySelector('.del-cat').addEventListener('click', () => row.remove());
  $('#f-dept-cats').appendChild(row);
}

function saveDept() {
  const name = $('#f-dept-name').value.trim();
  if (!name) return toast('请填写部门名称', 'error');
  const data = {
    name: name,
    service: $('#f-dept-service').value.trim(),
    contract: toNum($('#f-dept-contract').value),
    patrol: Math.round(toNum($('#f-dept-patrol').value)),
    problems: Math.round(toNum($('#f-dept-problem').value)),
    cats: $$('#f-dept-cats .cat-row')
      .map(r => ({ name: r.querySelector('.cat-name').value.trim(), count: Math.round(toNum(r.querySelector('.cat-count').value)) }))
      .filter(c => c.name),
    projects: $('#f-dept-projects').value.split(/[,，、]/).map(s => s.trim()).filter(Boolean)
  };
  if (editingDeptId) {
    const target = depts.find(x => x.id === editingDeptId);
    if (target) { Object.assign(target, data); toast('部门数据已更新'); }
  } else {
    depts.push(Object.assign({ id: uid() }, data));
    toast('部门数据添加成功');
  }
  saveDepts(); renderOps(); refreshDeptOptions();
  closeModal('#modal-dept');
}

/* =========================================================
   模块三：进度卡点
   ========================================================= */
let editingBlockerId = null;
const BLK_STATUS_CLASS = { '进行中': 'tag-blue', '待推进': 'tag-orange', '已解决': 'tag-green' };

function bindBlockerEvents() {
  $('#btn-add-blocker').addEventListener('click', () => openBlockerModal(null));
  $('#f-blk-save').addEventListener('click', saveBlocker);

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
}

function renderBlockers() {
  const list = [...blockers].sort((a, b) => (b.updateTime || '').localeCompare(a.updateTime || ''));
  $('#blocker-tbody').innerHTML = list.map((b, i) =>
    '<tr>' +
      '<td>' + (i + 1) + '</td>' +
      '<td class="td-title">' + esc(b.title) + '</td>' +
      '<td>' + esc(b.department) + '</td>' +
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
  $('#blocker-empty').style.display = list.length ? 'none' : '';
}

function openBlockerModal(b) {
  editingBlockerId = b ? b.id : null;
  $('#modal-blocker-title').textContent = b ? '编辑卡点' : '添加卡点';
  $('#f-blk-title').value = b ? b.title : '';
  const sel = $('#f-blk-dept');
  $('#f-blk-dept').value = b ? b.department : (sel.options[0] ? sel.options[0].value : '');
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
  if (!title) return toast('请填写问题/事项名称', 'error');
  if (!progress) return toast('请填写进展情况', 'error');
  if (!person) return toast('请填写负责人', 'error');
  const data = {
    title: title,
    department: $('#f-blk-dept').value,
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
    blockers.push(Object.assign({ id: uid() }, data));
    toast('卡点添加成功');
  }
  saveBlockers(); renderBlockers();
  closeModal('#modal-blocker');
}

/* =========================================================
   模块四：来年统采进展
   ========================================================= */
let currentProcTab = '已落地';
let editingProcId = null;
const FOLLOW_CLASS = { '初步接触': 'tag-cyan', '方案编制中': 'tag-blue', '待报价': 'tag-orange', '待决策': 'tag-purple' };

function bindProcEvents() {
  $$('.proc-tab').forEach(t => t.addEventListener('click', () => {
    currentProcTab = t.dataset.tab;
    renderProc();
  }));
  $('#btn-add-proc').addEventListener('click', () => openProcModal(null));
  $('#f-proc-cat').addEventListener('change', toggleProcFollow);
  $('#f-proc-save').addEventListener('click', saveProc);

  $('#proc-grid').addEventListener('click', e => {
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
    }
  });
}

function renderProc() {
  const counts = {};
  procs.forEach(p => { counts[p.category] = (counts[p.category] || 0) + 1; });
  $$('.proc-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === currentProcTab);
    t.querySelector('.tab-count').textContent = counts[t.dataset.tab] || 0;
  });
  const list = procs.filter(p => p.category === currentProcTab);
  $('#proc-grid').innerHTML = list.length
    ? list.map(procCardHTML).join('')
    : '<div class="empty-state" style="grid-column:1/-1">该清单暂无需求记录，点击右上角「添加需求」新建</div>';
}

function procCardHTML(p) {
  const danger = p.category === '未对接';
  return '<div class="card proc-card' + (danger ? ' proc-danger' : '') + '">' +
    '<div class="proc-head">' +
      '<div>' +
        '<div class="proc-name">' + esc(p.name) + (danger ? ' <span class="tag tag-red">重点关注</span>' : '') + '</div>' +
        '<div class="proc-unit">' + esc(p.unit) + '</div>' +
      '</div>' +
      '<div class="card-actions">' +
        '<button class="btn btn-ghost btn-xs" data-edit-proc="' + p.id + '">编辑</button>' +
        '<button class="btn btn-danger-ghost btn-xs" data-del-proc="' + p.id + '">删除</button>' +
      '</div>' +
    '</div>' +
    '<div class="proc-desc">' + esc(p.service) + '</div>' +
    '<div class="proc-fields">' +
      '<div class="proc-field"><span>区域</span><b>' + esc(p.region) + '</b></div>' +
      '<div class="proc-field"><span>频次</span><b>' + esc(p.freq) + '</b></div>' +
      '<div class="proc-field"><span>预算</span><b>' + (p.budget != null ? formatNum(p.budget) + ' 万元' : '待定') + '</b></div>' +
      (p.category !== '已落地'
        ? '<div class="proc-field"><span>跟进状态</span><b><span class="tag ' + (FOLLOW_CLASS[p.follow] || 'tag-gray') + '">' + esc(p.follow || '—') + '</span></b></div>'
        : '') +
    '</div>' +
    (p.remark ? '<div class="proc-remark">备注：' + esc(p.remark) + '</div>' : '') +
  '</div>';
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
  renderTodoPanel();
  renderOps();
  renderBlockers();
  renderProc();
}

async function init() {
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
  $('#login-btn').addEventListener('click', () => toast('当前为内部免登录模式，可直接使用', 'info'));

  const now = new Date();
  calY = now.getFullYear(); calM = now.getMonth();
  selectedDate = fmtDate(now);

  tickClock();
  setInterval(tickClock, 1000);   // 顶栏时钟每秒刷新

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
