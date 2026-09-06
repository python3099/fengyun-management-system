/* =========================================================
   广东丰云智能科技有限公司管理系统 - 内网共享部署服务
   零依赖（仅用 Node.js 内置模块），用法：
     node server.js            # 默认端口 8080
     PORT=9000 node server.js  # 自定义端口
   功能：
     1. 静态托管项目文件（index.html / css / js）
     2. 数据 API：GET /api/health、GET /api/data、PUT /api/data/:module
        数据以 JSON 文件形式保存在项目 data/ 目录，可随 Git 提交备份
   ========================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PORT = process.env.PORT || 8080;
const VERSION = '1.7.2';

/* 允许通过 API 读写的模块白名单（与前端 MODULES 对应） */
const MODULE_FILES = {
  todos: 'todos.json',
  departments: 'departments.json',
  blockers: 'blockers.json',
  procurement: 'procurement.json'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

/* 原子写入：先写临时文件再改名，避免写入中断导致文件损坏 */
function writeJSON(filePath, obj) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, filePath);
}
function readJSON(filePath) {
  try {
    const txt = fs.readFileSync(filePath, 'utf-8');
    return txt.trim() ? JSON.parse(txt) : null;
  } catch (e) { return null; }   // 文件不存在按无数据处理
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function handleApi(req, res, pathname) {
  if (pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, mode: 'server', version: VERSION });
  }
  if (pathname === '/api/data' && req.method === 'GET') {
    const out = {};
    for (const [name, file] of Object.entries(MODULE_FILES)) {
      out[name] = readJSON(path.join(DATA_DIR, file));
    }
    return sendJSON(res, 200, out);
  }
  const putMatch = pathname.match(/^\/api\/data\/(\w+)$/);
  if (putMatch && req.method === 'PUT') {
    const name = putMatch[1];
    const file = MODULE_FILES[name];
    if (!file) return sendJSON(res, 404, { ok: false, error: '未知数据模块：' + name });
    let body = '';
    let overflow = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) { overflow = true; req.destroy(); }
    });
    req.on('end', () => {
      if (overflow) return;
      try {
        const val = JSON.parse(body);
        writeJSON(path.join(DATA_DIR, file), val);
        sendJSON(res, 200, { ok: true });
      } catch (e) {
        sendJSON(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      }
    });
    return;
  }
  sendJSON(res, 404, { ok: false, error: 'Not Found' });
}

function serveStatic(req, res, pathname) {
  let urlPath;
  try { urlPath = decodeURIComponent(pathname); } catch (e) { res.writeHead(400); return res.end('Bad Request'); }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found: ' + urlPath); }
    // 静态资源禁用缓存：系统更新后用户刷新即得最新版（配合前端登录门逻辑至关重要）
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = req.url.split('?')[0];
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  serveStatic(req, res, pathname);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('==============================================');
  console.log('  丰云管理系统 已启动 (v' + VERSION + ')');
  console.log('  本机访问:   http://localhost:' + PORT + '/');
  /* 打印局域网地址，方便同事直接访问 */
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('  局域网访问: http://' + net.address + ':' + PORT + '/');
      }
    }
  }
  console.log('  数据目录:   ' + DATA_DIR);
  console.log('==============================================');
});
