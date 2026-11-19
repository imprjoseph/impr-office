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
call('boss', 'people.update', { id: pt.id, expectedUpdatedAt: pt.updated_at, patch: { hourly_wage: 200, region: '台北' } });
[['合約行政', '確認合約、報價與工作範圍', -60, '關鍵'], ['整體時程', '建立專案總時程及查核點', -60, '關鍵'], ['視覺設計', '主視覺提案', -30, '高'],
 ['講師貴賓', '確認講者名單與行程', -21, '高'], ['輸出物', '背板與指引送印', -7, '中'], ['驗收結案', '成果報告與請款', 14, '中']]
  .forEach(([category, title, offset_days, priority], i) => call('boss', 'template.create', { record: { category, title, offset_days, priority, sort: i } }));
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
call('hazel', 'dispatch.assign', { record: { account: 'pt1', project_id: b.id, start_date: day(0), end_date: day(21), role: '報到台' } });
const item = call('hazel', 'inventory.create', { record: { name: '無線麥克風', quantity: 8, unit: '支', location: '倉庫 A' } });
call('amy', 'loan.borrow', { record: { inventory_id: item.id, quantity: 2, project_id: a.id, due_date: day(6) } });
console.log('示範資料已建立');

const port = Number(process.argv[2] || 8795);
http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const out = req.method === 'POST' ? app.doPost({ postData: { contents: body } }).text : app.doGet().text;
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
    res.end(out);
  });
}).listen(port, () => console.log('dev API on http://localhost:' + port));
