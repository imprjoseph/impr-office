/** 專案、工作、範本、會議、標案。 */
module.exports = (test, { assert }) => {
  const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const seedTemplates = call => {
    call('boss', 'template.create', { record: { category: '合約行政', title: '確認合約與報價', offset_days: -60, priority: '關鍵', sort: 1 } });
    call('boss', 'template.create', { record: { category: '視覺設計', title: '主視覺提案', offset_days: -30, priority: '高', sort: 2 } });
  };

  test('[專案] 建立編號接年度流水號、套範本產生工作（截止日 = 活動日 + offset）、同名擋下', ({ call }) => {
    seedTemplates(call);
    const r = call('hazel', 'project.create', { record: { name: '2027 醫學年會', start_date: '2027-03-10', end_date: '2027-03-11' }, applyTemplate: true });
    assert.strictEqual(r.project.code, 'EVT-2027-001');
    assert.strictEqual(r.project.pm_account, 'hazel');
    assert.deepStrictEqual(r.tasks.map(t => [t.code, t.due_date, t.owner_account]),
      [['T-001', '2027-01-09', 'hazel'], ['T-002', '2027-02-08', 'hazel']]);
    assert.strictEqual(call('amy', 'project.create', { record: { name: '別的', start_date: '2027-05-01', end_date: '2027-05-01' } }).project.code, 'EVT-2027-002');
    assert.throws(() => call('amy', 'project.create', { record: { name: '2027醫學年會' } }), e => /同名/.test(e.message));
    assert.throws(() => call('amy', 'project.create', { record: { name: 'x', start_date: '2027-05-02', end_date: '2027-05-01' } }), e => /結束日/.test(e.message));
  });

  test('[專案] 燈號：逾期或卡關紅燈、有待確認黃燈；卡關要寫原因；完成記完成時間', ({ call }) => {
    const { project } = call('hazel', 'project.create', { record: { name: '論壇', start_date: day(30), end_date: day(30) } });
    const t1 = call('hazel', 'task.create', { project_id: project.id, record: { title: 'A', due_date: day(10) } });
    assert.strictEqual(call('hazel', 'project.list')[0].light, '綠燈');
    const t1b = call('hazel', 'task.update', { id: t1.id, expectedUpdatedAt: t1.updated_at, patch: { status: '待客戶確認' } });
    assert.strictEqual(call('hazel', 'project.list')[0].light, '黃燈');
    assert.throws(() => call('hazel', 'task.update', { id: t1.id, expectedUpdatedAt: t1b.updated_at, patch: { status: '卡關' } }), e => /卡關原因/.test(e.message));
    const t1c = call('hazel', 'task.update', { id: t1.id, expectedUpdatedAt: t1b.updated_at, patch: { status: '卡關', blocker: '等客戶回簽' } });
    assert.strictEqual(t1c.light, '卡關');
    assert.strictEqual(call('hazel', 'project.list')[0].light, '紅燈');
    const done = call('hazel', 'task.update', { id: t1.id, expectedUpdatedAt: t1c.updated_at, patch: { status: '已完成' } });
    assert.ok(done.done_at);
    assert.strictEqual(call('hazel', 'project.get', { id: project.id }).project.stats.rate, 1);
    assert.throws(() => call('hazel', 'task.update', { id: t1.id, expectedUpdatedAt: done.updated_at, patch: { status: '亂填' } }), e => /未知的狀態/.test(e.message));
  });

  test('[專案] 財務欄位：同仁看不到也不能改合約金額；PM 與會計可以', ({ call }) => {
    const { project } = call('hazel', 'project.create', { record: { name: '尾牙', contract_amount: 500000 } });
    assert.strictEqual(call('hazel', 'project.get', { id: project.id }).project.contract_amount, 500000);
    assert.strictEqual('contract_amount' in call('amy', 'project.get', { id: project.id }).project, false);
    assert.strictEqual(call('acc', 'project.list')[0].contract_amount, 500000);
    assert.throws(() => call('amy', 'project.update', { id: project.id, expectedUpdatedAt: project.updated_at, patch: { contract_amount: 1 } }), e => e.code === 'FORBIDDEN_ERROR');
  });

  test('[會議] 會議連同待辦建立，待辦成為專案工作並帶 meeting_id；待辦缺標題整筆不寫', ({ app, call }) => {
    const { project } = call('hazel', 'project.create', { record: { name: '記者會' } });
    assert.throws(() => call('hazel', 'meeting.create', { meeting: { project_id: project.id, title: '週會', meeting_date: day(0) }, tasks: [{ title: '' }] }));
    assert.strictEqual(app.repo_('meetings').findAll().length, 0);
    const r = call('hazel', 'meeting.create', { meeting: { project_id: project.id, title: '週會', meeting_date: day(0) },
      tasks: [{ title: '確認場地', owner_account: 'amy', due_date: day(3) }] });
    assert.strictEqual(r.tasks[0].meeting_id, r.meeting.id);
    assert.strictEqual(call('amy', 'task.mine')[0].project_name, '記者會');
  });

  test('[標案] 流程不能跳關；同仁不能改別人的；得標轉專案套範本、帶 PM 與合約金額、只能轉一次', ({ call }) => {
    seedTemplates(call);
    const t = call('hazel', 'tender.create', { record: { title: '2027 防詐宣導', agency: '電信協會', award_amount: 1200000 } });
    assert.throws(() => call('hazel', 'tender.setStatus', { id: t.id, expectedUpdatedAt: t.updated_at, status: 'won' }), e => /評估中/.test(e.message));
    assert.throws(() => call('amy', 'tender.update', { id: t.id, expectedUpdatedAt: t.updated_at, patch: { bid_amount: 1 } }), e => e.code === 'FORBIDDEN_ERROR');
    let cur = t;
    ['preparing', 'submitted', 'won'].forEach(s => { cur = call('hazel', 'tender.setStatus', { id: cur.id, expectedUpdatedAt: cur.updated_at, status: s }); });
    const r = call('hazel', 'tender.convertToProject', { id: cur.id, expectedUpdatedAt: cur.updated_at, project: { start_date: '2027-04-01', end_date: '2027-04-01' } });
    assert.strictEqual(r.project.pm_account, 'hazel');
    assert.strictEqual(r.project.contract_amount, 1200000);
    assert.strictEqual(r.taskCount, 2);
    assert.strictEqual(r.tender.project_id, r.project.id);
    assert.throws(() => call('hazel', 'tender.convertToProject', { id: cur.id, expectedUpdatedAt: r.tender.updated_at, project: {} }), e => /已經轉成/.test(e.message));
  });

  test('[範本] 依 sort 數字排序（0 排第一、10 排在 2 後面），工作編號照順序', ({ call }) => {
    [[10, '十'], [0, '零'], [2, '二']].forEach(([sort, title]) => call('boss', 'template.create', { record: { category: '整體時程', title, offset_days: -1, sort } }));
    const r = call('hazel', 'project.create', { record: { name: 'x', start_date: '2027-01-10', end_date: '2027-01-10' }, applyTemplate: true });
    assert.deepStrictEqual(r.tasks.map(t => t.code + t.title), ['T-001零', 'T-002二', 'T-003十']);
  });

  test('[權限] 派遣人員碰不到專案與標案', ({ call }) => {
    assert.throws(() => call('pt1', 'project.list'), e => e.code === 'FORBIDDEN_ERROR');
    assert.throws(() => call('pt1', 'tender.list'), e => e.code === 'FORBIDDEN_ERROR');
  });
  test('[專案] 依活動類型代入參考工作：追蹤表基本事項（依適用類型）＋該類型；頒獎典禮自動改為典禮；類型要在清單內', ({ app, call }) => {
    assert.ok(call('boss', 'template.seedTypes', {}).added > 80);
    const tpl = app.repo_('task_templates').findAll();
    assert.ok(tpl.some(t => t.title === '確認合約、報價與工作範圍' && !t.project_types && t.tip === '追加需求需留存書面紀錄'));

    const { tasks } = call('hazel', 'project.create', { record: { name: '新品記者會', project_type: '記者會', start_date: '2027-03-20' }, applyTemplate: true });
    const titles = tasks.map(t => t.title);
    ['確認合約、報價與工作範圍', '完成第一次場勘', '進度會議（T-14）', '確認舞台、燈光、音響及投影', '燈光、音響進場架設與測試',
      '軟硬體測試與備援（簡報電腦、投影、報到系統）', '完成新聞稿及採訪通知', '擬定記者會流程與發言口徑'].forEach(k => assert.ok(titles.includes(k), k));
    assert.ok(!titles.includes('報名系統上線'));
    assert.ok(!titles.includes('表演節目安排'));
    assert.strictEqual(new Set(titles).size, titles.length);
    const press = tasks.find(t => t.title === '完成新聞稿及採訪通知');
    assert.strictEqual(press.due_date, '2027-03-13');
    assert.match(press.note, /完成判斷：主辦確認\n提醒：需確認媒體聯訪對象/);

    const v = call('hazel', 'project.create', { record: { name: '小琉球訪查', project_type: '訪查', start_date: '2027-04-01' }, applyTemplate: true });
    const vt = v.tasks.map(t => t.title);
    assert.ok(vt.includes('確認合約、報價與工作範圍') && vt.includes('確認航班與接送需求') && vt.includes('訪查成果報告'));
    assert.ok(!vt.includes('完成第一次場勘') && !vt.includes('確認舞台、燈光、音響及投影'));

    const c = call('hazel', 'project.create', { record: { name: '年度頒獎', project_type: '頒獎典禮', start_date: '2027-05-01' }, applyTemplate: true });
    assert.strictEqual(c.project.project_type, '典禮');
    assert.ok(c.tasks.some(t => t.title === '完成進場及總彩排') && c.tasks.some(t => t.title === '表演節目安排'));
    const none = call('hazel', 'project.create', { record: { name: '未分類', start_date: '2027-05-01' }, applyTemplate: true });
    assert.ok(none.tasks.some(t => t.title === '完成第一次場勘'));
    assert.throws(() => call('hazel', 'project.create', { record: { name: '亂填', project_type: '派對' } }), /活動類型只能是/);
    assert.strictEqual(call('boss', 'template.seedTypes', {}).added, 0);
    assert.ok(call('hazel', 'project.types', {}).includes('典禮'));
    assert.ok(!call('hazel', 'project.types', {}).includes('頒獎典禮'));
  });

  test('[範本] 升級：上一版系統加入且沒人改過的基本事項移除、改用追蹤表項目；有人改過的保留', ({ app, properties }) => {
    const repo = app.repo_('task_templates');
    app.withScriptLock_(() => repo.insertMany([
      { category: '場地', title: '場地場勘（動線、電源、網路、卸貨、無障礙）', offset_days: -45 },
      { category: '燈光', title: '燈光需求確認與廠商預約', offset_days: -30 },
      { project_types: '典禮', category: '現場執行', title: '全程彩排', offset_days: -1 },
    ], 'system'));
    const kept = app.withScriptLock_(() => repo.insert({ category: '音響', title: '音響測試與麥克風配置', offset_days: -1 }, 'system'));
    app.withScriptLock_(() => repo.updateMany({ [kept.id]: { tip: '主管加的提醒' } }, 'boss'));
    properties.TEMPLATE_SEED_VERSION = '2';
    app.ensureTemplateSeed_();
    const titles = repo.findAll().map(t => t.title);
    assert.ok(!titles.includes('場地場勘（動線、電源、網路、卸貨、無障礙）'));
    assert.ok(!titles.includes('燈光需求確認與廠商預約'));
    assert.ok(!titles.includes('全程彩排'));
    assert.ok(titles.includes('音響測試與麥克風配置'));
    assert.ok(titles.includes('完成第一次場勘'));
  });
  test('[範本] 參考工作項目自動補：版本變了才補、只補缺的、不重複補主管刪掉以外的', ({ app, properties }) => {
    properties.TEMPLATE_SEED_VERSION = '0';
    app.ensureTemplateSeed_();
    const n = app.repo_('task_templates').findAll().length;
    assert.ok(n > 60);
    assert.strictEqual(properties.TEMPLATE_SEED_VERSION, app.TEMPLATE_SEED_VERSION_);
    app.ensureTemplateSeed_();
    assert.strictEqual(app.repo_('task_templates').findAll().length, n);
    properties.TEMPLATE_SEED_VERSION = '0';
    app.ensureTemplateSeed_();
    assert.strictEqual(app.repo_('task_templates').findAll().length, n);
  });
  test('[專案] 建立後再代入參考工作：先預覽、標出已有的；勾選的加入、重按不重複；沒活動日期擋下', ({ app, call }) => {
    call('boss', 'template.seedTypes', {});
    const { project, tasks } = call('hazel', 'project.create', { record: { name: '先建後補', project_type: '記者會' } });
    assert.strictEqual(tasks.length, 0);
    const p0 = call('hazel', 'task.templatePreview', { project_id: project.id });
    assert.strictEqual(p0.start_date, null);
    assert.ok(p0.items.length > 20 && p0.items.every(i => !i.due_date));
    const ids = p0.items.slice(0, 3).map(i => i.template_id);
    assert.throws(() => call('hazel', 'task.addFromTemplates', { project_id: project.id, template_ids: ids }), /活動日期/);
    const proj = call('hazel', 'project.get', { id: project.id }).project;
    call('hazel', 'project.update', { id: project.id, expectedUpdatedAt: proj.updated_at, patch: { start_date: '2027-06-30' } });
    call('hazel', 'task.create', { project_id: project.id, record: { title: p0.items[0].title } });
    const p1 = call('hazel', 'task.templatePreview', { project_id: project.id });
    assert.strictEqual(p1.items[0].exists, true);
    assert.strictEqual(p1.items[1].due_date, app.addDays_('2027-06-30', p1.items[1].offset_days));
    const added = call('hazel', 'task.addFromTemplates', { project_id: project.id, template_ids: ids });
    assert.strictEqual(added.length, 2);
    assert.strictEqual(call('hazel', 'task.addFromTemplates', { project_id: project.id, template_ids: ids }).length, 0);
    assert.ok(added.every(t => t.owner_account === 'hazel' && t.note));
  });
  test('[專案] PM 不能是管理者：管理者建專案時 PM 空白；指派管理者當 PM 擋下；同仁建的預設自己', ({ call }) => {
    call('boss', 'people.sync');
    const a = call('boss', 'project.create', { record: { name: '管理者建的' } }).project;
    assert.strictEqual(a.pm_account, null);
    assert.throws(() => call('hazel', 'project.create', { record: { name: '指派管理者', pm_account: 'boss' } }), /管理者帳號不能當 PM/);
    const h = call('hazel', 'project.create', { record: { name: '同仁建的' } }).project;
    assert.strictEqual(h.pm_account, 'hazel');
    assert.throws(() => call('hazel', 'project.update', { id: h.id, expectedUpdatedAt: h.updated_at, patch: { pm_account: 'boss' } }), /管理者帳號不能當 PM/);
  });
};
