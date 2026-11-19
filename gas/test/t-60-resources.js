/** 資材、SOP、帳密、工時。 */
module.exports = (test, { assert }) => {
  test('[資材] 借用不能超過可借數量；歸還後釋出；逾期標示', ({ call }) => {
    const item = call('hazel', 'inventory.create', { record: { name: '無線麥克風', quantity: 4, unit: '支' } });
    const l = call('amy', 'loan.borrow', { record: { inventory_id: item.id, quantity: 3 } });
    assert.throws(() => call('hazel', 'loan.borrow', { record: { inventory_id: item.id, quantity: 2 } }), e => /只剩 1 支/.test(e.message));
    assert.strictEqual(call('hazel', 'inventory.withStock')[0].available, 1);
    call('amy', 'loan.return', { id: l.id, expectedUpdatedAt: l.updated_at });
    assert.strictEqual(call('hazel', 'inventory.withStock')[0].available, 4);
    assert.throws(() => call('amy', 'loan.borrow', { record: { inventory_id: item.id, quantity: 1, due_date: '2000-01-01' } }), e => /歸還日/.test(e.message));
  });

  test('[SOP] 新增是草稿；發布新版時舊版自動失效；依專案類型篩選', ({ call }) => {
    const v1 = call('boss', 'sop.create', { record: { title: '報到流程', version: '1', project_types: '論壇、研討會' } });
    assert.strictEqual(v1.status, 'draft');
    call('boss', 'sop.publish', { id: v1.id, expectedUpdatedAt: v1.updated_at });
    const v2 = call('boss', 'sop.create', { record: { title: '報到流程', version: '2', project_types: '論壇' } });
    call('boss', 'sop.publish', { id: v2.id, expectedUpdatedAt: v2.updated_at });
    const all = call('amy', 'sop.list');
    assert.deepStrictEqual(all.map(s => s.version + ':' + s.status).sort(), ['1:superseded', '2:active']);
    assert.strictEqual(call('amy', 'sop.forProjectType', { project_type: '研討會' }).length, 0);
    assert.strictEqual(call('amy', 'sop.forProjectType', { project_type: '論壇' }).length, 1);
    assert.throws(() => call('amy', 'sop.create', { record: { title: 'x' } }), e => e.code === 'FORBIDDEN_ERROR');
  });

  test('[帳密] 只有 admin 看得到，每次查看留紀錄', ({ app, call }) => {
    call('boss', 'credential.create', { record: { service: '官網後台', username: 'admin', password: 'p@ss' } });
    assert.throws(() => call('mgr', 'credential.list'), e => e.code === 'FORBIDDEN_ERROR');
    assert.strictEqual(call('boss', 'credential.list')[0].password, 'p@ss');
    assert.strictEqual(app.repo_('audit_log').findWhere(a => a.action === 'credential.view').length, 1);
  });

  test('[工時] 一週重填整週取代；週別要週一；主管看到誰還沒填', ({ call }) => {
    call('boss', 'people.sync');
    const { project } = call('hazel', 'project.create', { record: { name: '年會' } });
    call('amy', 'timesheet.save', { week_start: '2026-11-16', entries: [{ project_id: project.id, hours: 20 }, { hours: 10 }] });
    call('amy', 'timesheet.save', { week_start: '2026-11-16', entries: [{ project_id: project.id, hours: 30 }] });
    assert.strictEqual(call('amy', 'timesheet.mine').length, 1);
    assert.throws(() => call('amy', 'timesheet.save', { week_start: '2026-11-17', entries: [] }), e => /週一/.test(e.message));
    const week = call('mgr', 'timesheet.week', { week_start: '2026-11-16' });
    assert.strictEqual(week.find(w => w.account === 'amy').hours, 30);
    assert.strictEqual(week.find(w => w.account === 'hazel').missing, true);
  });
};
