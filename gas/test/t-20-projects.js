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
};
