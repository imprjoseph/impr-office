/**
 * 本機預覽用的後端：在 Node 裡跑真正的 gas/src 程式（模擬試算表），灌入示範資料。
 * 執行：node gas/test/dev-server.js 8795，前端用 VITE_API_URL=http://localhost:8795 npm run dev。
 * 憑證是 base64 的 {sub, exp}（前端只檢查 exp），這裡用 sub 當帳號，對應 harness 的測試帳號。
 */
const http = require('http');
const { load } = require('./harness');

const env = load();
const verifyBefore = env.urlFetchHandler;
env.urlFetchHandler = (url, opts) => {
  const body = JSON.parse(opts.payload);
  if (body.token && body.token.includes('.')) {
    try { body.token = JSON.parse(Buffer.from(body.token.split('.')[0], 'base64').toString()).sub; } catch (e) { /* 不是假憑證 */ }
    opts = Object.assign({}, opts, { payload: JSON.stringify(body) });
  }
  return verifyBefore(url, opts);
};
const { app, call } = env;
const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// ---- 示範資料 ----
call('boss', 'people.sync');
const pt = app.PeopleService.byAccount('pt1');
call('boss', 'people.update', { id: pt.id, expectedUpdatedAt: pt.updated_at, patch: { region: '台北' } });
[['合約行政', '確認合約、報價與工作範圍', -60, '關鍵'], ['整體時程', '建立專案總時程及查核點', -60, '關鍵'], ['視覺設計', '主視覺提案', -30, '高'],
 ['講師貴賓', '確認講者名單與行程', -21, '高'], ['輸出物', '背板與指引送印', -7, '中'], ['驗收結案', '成果報告與請款', 14, '中']]
  .forEach(([category, title, offset_days, priority], i) => call('boss', 'template.create', { record: { category, title, offset_days, priority, sort: i } }));
call('boss', 'template.seedTypes', {});
const cli = call('hazel', 'client.create', { record: { name: '資策會數轉院', industry: '法人' } });
const sup = call('hazel', 'supplier.create', { record: { name: '富立音響', category: '音響', contact_name: '林先生', contact_phone: '02-2345-6789' } });
call('hazel', 'supplier.create', { record: { name: '藍鯊攝影', category: '攝影／錄影' } });
const a = call('hazel', 'project.create', { record: { name: '資策會淨零研討會', client_id: cli.id, client_name: '資策會數轉院', venue: '台大醫院國際會議中心', start_date: day(5), end_date: day(5), contract_amount: 850000 }, applyTemplate: true }).project;
const b = call('amy', 'project.create', { record: { name: '台日智慧電桿交流會', client_name: '資策會AI院', venue: '台北晶華', start_date: day(20), end_date: day(21) }, applyTemplate: true }).project;
call('hazel', 'project.create', { record: { name: '2027 醫學年會', client_name: '醫學會', start_date: day(80), end_date: day(81) }, applyTemplate: true });
const tasks = call('hazel', 'project.get', { id: a.id }).tasks;
call('hazel', 'task.update', { id: tasks[0].id, expectedUpdatedAt: tasks[0].updated_at, patch: { status: '已完成' } });
call('hazel', 'task.update', { id: tasks[3].id, expectedUpdatedAt: tasks[3].updated_at, patch: { status: '卡關', blocker: '部長行程未定', next_step: '週三前再確認' } });
call('hazel', 'budget.addLine', { project_id: a.id, record: { category: '場地', item: '國際會議廳', quote_amount: 300000, cost_estimate: 220000 } });
const line = call('hazel', 'budget.addLine', { project_id: a.id, record: { category: '硬體設備', item: '音響燈光', quote_amount: 250000, cost_estimate: 180000, supplier_id: sup.id } });
call('hazel', 'budget.addChange', { project_id: a.id, record: { kind: '增項', description: '加開同步口譯', quote_delta: 60000, cost_delta: 52000 } });
const e1 = call('amy', 'expense.create', { record: { project_id: a.id, budget_line_id: line.id, category: '設備租借', description: '追加無線麥克風', amount: 12000 } });
call('amy', 'expense.submit', { id: e1.id, expectedUpdatedAt: e1.updated_at });
call('hazel', 'tender.create', { record: { title: '2027 防詐宣導整合行銷', agency: '電信協會', budget_amount: 2400000, deadline_date: day(9), opening_date: day(12) } });
call('hazel', 'dispatch.assign', { record: { account: 'pt1', project_id: b.id, start_date: day(0), end_date: day(21), role: '報到台', hourly_wage: 200 } });
const item = call('hazel', 'inventory.create', { record: { name: '無線麥克風', category: '錄音與音響設備', quantity: 8, unit: '支', location: '倉庫 A', manager_account: 'hazel' } });
call('amy', 'loan.borrow', { record: { inventory_id: item.id, quantity: 2, project_id: a.id, due_date: day(6) } });
const nb = call('hazel', 'inventory.create', { record: { name: '華碩筆電', category: '電腦與周邊設備', spec: 'ZenBook 14', quantity: 3, unit: '台', location: '辦公室櫃 B' } });
call('hazel', 'inventory.setMode', { id: nb.id, expectedUpdatedAt: nb.updated_at, kind: '資產', track_mode: '逐台' });
const nbUnits = call('hazel', 'inventory.units', { inventory_id: nb.id });
call('amy', 'loan.borrow', { record: { inventory_id: nb.id, unit_ids: [nbUnits[0].id], project_id: b.id, due_date: day(3) } });
const badge = call('hazel', 'inventory.create', { record: { name: '識別證套', kind: '耗材', category: '識別證與名牌耗材', quantity: 120, unit: '個', safety_stock: 150 } });
call('hazel', 'inventory.create', { record: { name: 'A4 影印紙', kind: '耗材', category: '文具', quantity: 20, unit: '包', safety_stock: 5 } });
call('hazel', 'stock.move', { record: { inventory_id: badge.id, kind: '領用', quantity: 30, project_id: a.id } });
const ptA = call('hazel', 'partTimer.create', { record: { name: '陳同學', mobile: '0911-222-333', region: '台北', school: '政大外語系', skills: '報到接待、貴賓接待', languages: '英文、日文' } });
call('hazel', 'partTimer.addJob', { record: { part_timer_id: ptA.id, project_id: a.id, work_date: day(-30), role: '報到台', rating: 5, comment: '主動、細心，英文流利' } });
call('hazel', 'partTimer.create', { record: { name: '林同學', line_id: 'lin_pt', region: '新北', skills: '會場佈置、搬運' } });
// 政府標案資料庫（示範幾筆）
const gov = env.addSpreadsheet('1vKY27NlrPMpUOyq5mqSWgGRiJSHxaB-eDAJEr49mMVk').insertSheet('符合案件');
gov.data = [['主鍵', '公告日', '機關', '案名', '預算', '截止投標', '公告類型', '案號', '關鍵字群組', '命中關鍵字', '分數', '連結', '首次收錄', '狀態', '負責人', '是否投標', '備註'],
  ['k1', day(-1), '客家委員會客家文化發展中心', '「2027客家飲食研究文化沙龍暨國際研討會」委託專業服務案', '1,480,000', day(4), '公開取得報價單或企劃書公告', '115086', '國際會議論壇/AI推薦0.99', '國際研討會、研討會', 30, '開啟', '', '', '', '', ''],
  ['k2', day(-1), '臺北市政府資訊局', '2027智慧城市成果展示執行委託服務案', '5,300,000', day(12), '經公開評選或公開徵求之限制性招標公告', '11603', '活動執行/AI推薦1.00', '成果展', 18, '開啟', '', '', '', '', ''],
  ['k3', day(-2), '衛生福利部國民健康署', '116年社群媒體維運計畫', '5,200,000', day(2), '經公開評選或公開徵求之限制性招標公告', 'M1151101', '宣導行銷', '媒體、社群', 8, '開啟', '', '評估中', 'Amy', '', ''],
  ['k4', day(-30), '屏東縣政府', '屏東文學館本土語言展覽設計與執行', '700,000', day(-5), '公開取得報價單或企劃書公告', 'B093', '活動執行', '展覽', 4, '開啟', '', '', '', '', '']];
gov.formulas['2,12'] = '=HYPERLINK("https://web.pcc.gov.tw/","開啟")';
// 本機預覽不連真的 AI：文件回一段示範文字，設計回示範提示詞。
env.properties.ANTHROPIC_API_KEY = 'dev';
env.properties.OPENAI_API_KEY = 'dev';
// 1x1 深藍色 PNG，當作示範底圖
const DEMO_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
env.aiHandler = (body, url) => {
  if (/openai/.test(url)) return { data: [{ b64_json: DEMO_PNG }], usage: { input_tokens: 10, output_tokens: 100 } };
  if (body.tools) return { type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 }, content: [{ type: 'text',
    text: '## 單位簡介\n（本機示範）這裡會是 AI 上網查到的單位簡介。\n\n## 近期重點\n- 示範重點一\n\n## 既有新聞稿寫法\n- 標題常用「主題＋活動名稱」\n- 導言先寫首長與活動目的',
    citations: [{ type: 'web_search_result_location', url: 'https://www.hpa.gov.tw/', title: '示範來源：國民健康署' }] }] };
  const text = /只輸出 JSON/.test(body.system)
    ? JSON.stringify({ headline: '早期守護', subheadline: '2027 台灣早期 CKD 國際論壇', copy: '串連國際專家，讓腎臟照護走在病程前面。', concept: '以晨光中的雙手托起抽象腎形，象徵早期守護。',
      prompt: 'Two gentle hands cradling an abstract kidney-shaped form made of soft dawn light, deep navy and warm gold palette, Taiwan island silhouette subtly in the horizon, calm premium medical conference key visual, editorial photography style --ar 16:9 --style raw --v 7 --no text, letters, logos',
      prompt_zh: '晨光中的雙手托著抽象腎形，深藍與暖金，地平線隱約台灣島形。', negative: 'text, letters, logos, syringes, hospital corridor, circuit patterns, lens flare',
      variations: ['Minimal line-art kidney formed by a sunrise path across Taiwan, navy and gold, generous negative space --ar 16:9 --style raw --v 7', 'Warm gold sunrise over layered navy hills shaped like a kidney, calm and hopeful --ar 16:9 --style raw --v 7'] })
    : '# 示範初稿\n\n本機預覽不連真的 AI，這是示範文字。\n\n' + body.messages[0].content;
  return { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } };
};
console.log('示範資料已建立');

const DEMO_ACCOUNTS = ['boss', 'hazel', 'amy', 'mgr', 'acc', 'pt1'];
const fakeToken_ = sub => Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 8 * 3600 })).toString('base64') + '.dev';
function fakeAuth_(b) {
  const subOf = t => { try { return JSON.parse(Buffer.from(String(t).split('.')[0], 'base64').toString()).sub; } catch (e) { return null; } };
  if (b.action === 'login') {
    if (!DEMO_ACCOUNTS.includes(b.account) || b.password !== 'demo') return { ok: false, error: { code: 'LOGIN', message: '帳號或密碼錯誤' } };
    return { ok: true, data: { token: fakeToken_(b.account) } };
  }
  if (b.action === 'changePassword') {
    if (b.oldPassword !== 'demo') return { ok: false, error: { code: 'VALIDATION', message: '目前密碼不正確' } };
    return { ok: true, data: { token: fakeToken_(subOf(b.token)) } };
  }
  return { ok: false, error: { code: 'VALIDATION', message: 'unsupported' } };
}

const port = Number(process.argv[2] || 8795);
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    // /auth 模擬帳號中心：示範帳號（boss、hazel、amy、mgr、acc、pt1）密碼都是 demo。
    if (req.url.startsWith('/auth')) {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
      return res.end(JSON.stringify(fakeAuth_(JSON.parse(body || '{}'))));
    }
    const out = req.method === 'POST' ? app.doPost({ postData: { contents: body } }).text : app.doGet().text;
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    res.end(out);
  });
}).listen(port, () => console.log('dev API on http://localhost:' + port));
