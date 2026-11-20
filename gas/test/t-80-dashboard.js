/** 工作台與管理設定。 */
module.exports = (test, { assert }) => {
  const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  test('[工作台] 同仁：我的工作、我是 PM 的專案；主管多待審數；會計多待付款與毛利警示；派遣人員不能用工作台', ({ call }) => {
    call('boss', 'people.sync');
    const { project } = call('hazel', 'project.create', { record: { name: '論壇', start_date: day(3), end_date: day(3) } });
    call('hazel', 'task.create', { project_id: project.id, record: { title: '確認講者', owner_account: 'hazel', due_date: day(1) } });
    call('hazel', 'budget.addLine', { project_id: project.id, record: { category: '場地', item: '會場', quote_amount: 100, cost_estimate: 95 } });
    const d = call('amy', 'expense.create', { record: { category: '交通', description: '計程車', amount: 300 } });
    call('amy', 'expense.submit', { id: d.id, expectedUpdatedAt: d.updated_at });
    const me = call('hazel', 'dashboard.me');
    assert.strictEqual(me.myTasks[0].title, '確認講者');
    assert.strictEqual(me.myProjects[0].name, '論壇');
    assert.strictEqual(me.thisWeek.length, 1);
    assert.strictEqual(me.approvals, null);
    assert.strictEqual(me.finance, null);
    assert.strictEqual(call('mgr', 'dashboard.me').approvals.expenses, 1);
    const acc = call('acc', 'dashboard.me');
    assert.strictEqual(acc.finance.marginAlerts.length, 1);
    assert.strictEqual(acc.finance.toPay, 0);
    assert.throws(() => call('pt1', 'dashboard.me'), /權限/);
  });

  test('[管理] 只有 admin 能改設定、看稽核；假日類型檢查', ({ call }) => {
    const s = call('boss', 'settings.list').find(x => x.key === 'margin_threshold');
    assert.strictEqual(call('boss', 'settings.update', { id: s.id, expectedUpdatedAt: s.updated_at, patch: { value: '0.25' } }).value, '0.25');
    assert.throws(() => call('mgr', 'settings.list'), e => e.code === 'FORBIDDEN_ERROR');
    assert.throws(() => call('boss', 'holiday.create', { record: { holiday_date: '2027-01-02', name: '補班', kind: 'X' } }), e => /HOLIDAY/.test(e.message));
    call('boss', 'holiday.create', { record: { holiday_date: '2027-01-02', name: '補班', kind: 'WORKDAY' } });
  });
};
