/**
 * 測試與本機預覽共用：用模擬的 GAS 環境載入 gas/src 的真實程式碼。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createGasGlobals } = require('./gas-mock');

const SRC = path.join(__dirname, '..', 'src');
// 與 GAS 相同：所有檔案共用同一個全域範圍。基礎檔先載，Controller 最後。
const FIRST = ['Util.js', 'Config.js', 'Schema.js', 'Repository.js', 'ServiceSupport.js', 'Auth.js', 'Setup.js'];
const LAST = ['Controller.js'];
function srcFiles() {
  const all = fs.readdirSync(SRC).filter(f => f.endsWith('.js'));
  const middle = all.filter(f => FIRST.indexOf(f) === -1 && LAST.indexOf(f) === -1).sort();
  return FIRST.concat(middle, LAST).filter(f => all.indexOf(f) !== -1);
}

// 測試用帳號：token 就是帳號名稱，帳號中心的 verify 回應由這裡決定。
const USERS = {
  boss: { user: { account: 'boss', name: '老闆', email: 'boss@impr.com.tw', dept: '管理', manager: '', type: '正職' }, role: 'admin' },
  hazel: { user: { account: 'hazel', name: 'Hazel', email: 'hazel@impr.com.tw', dept: '專案', manager: 'mgr', type: '正職' }, role: 'staff' },
  amy: { user: { account: 'amy', name: 'Amy', email: 'amy@impr.com.tw', dept: '專案', manager: 'mgr', type: '正職' }, role: 'staff' },
  mgr: { user: { account: 'mgr', name: '主管', email: 'mgr@impr.com.tw', dept: '專案', manager: 'boss', type: '正職' }, role: 'manager' },
  acc: { user: { account: 'acc', name: '會計', email: 'acc@impr.com.tw', dept: '財務', manager: 'boss', type: '正職' }, role: 'accountant' },
  pt1: { user: { account: 'pt1', name: '工讀小陳', email: '', dept: '', manager: 'mgr', type: '派遣' }, role: 'staff' },
};

function load() {
  const env = createGasGlobals();
  env.properties.SHEET_ID = 'mock';
  // 每個測試一份帳號表：測試可以刪改帳號（模擬帳號中心停用），不影響其他測試。
  const users = JSON.parse(JSON.stringify(USERS));
  // AI 服務的回應由 env.aiHandler 決定；預設回一段固定文字。
  env.aiCalls = [];
  env.aiHandler = body => ({ type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: '# 標題\n內文' }], usage: { input_tokens: 100, output_tokens: 50 } });
  env.urlFetchHandler = (url, opts) => {
    const body = JSON.parse(opts.payload);
    if (/anthropic\.com|openai\.com/.test(url)) {
      env.aiCalls.push({ url, headers: opts.headers, body });
      return env.aiHandler(body, url);
    }
    if (body.action === 'verify') {
      const u = users[body.token];
      return u ? { ok: true, data: u } : { ok: false, error: { code: 'TOKEN', message: '登入已失效' } };
    }
    if (body.action === 'directory') {
      return { ok: true, data: { system: 'office', users: Object.values(users).map(u => Object.assign({ role: u.role }, u.user)) } };
    }
    return { ok: false, error: { code: 'VALIDATION', message: 'unsupported' } };
  };
  const quietConsole = { log() {}, warn: console.warn, error: console.error };
  const context = vm.createContext(Object.assign({}, env.globals, { console: quietConsole }));
  const code = srcFiles().map(f => fs.readFileSync(path.join(SRC, f), 'utf8')).join('\n;\n')
    // eval 在同一個範圍內，連 const / class 都拿得到：app.TABLES、app.ProjectService…
    + '\n;new Proxy({}, { get: (_, name) => eval(String(name)) })';
  const app = vm.runInContext(code, context);
  app.setupDatabase();
  // 呼叫 API：as 是測試帳號（也就是 token）。回傳 data，失敗丟出帶 code 的錯誤，方便 assert.throws。
  const call = (as, action, payload) => {
    const res = JSON.parse(app.doPost({ postData: { contents: JSON.stringify({ action, token: as, payload }) } }).text);
    if (res.ok) return res.data;
    const err = new Error(res.error.message);
    err.code = res.error.code;
    err.details = res.error.details;
    throw err;
  };
  return Object.assign(env, { app, call, USERS: users });
}

module.exports = { load, USERS };
