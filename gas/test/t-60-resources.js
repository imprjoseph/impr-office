/** 資材、SOP、帳密、工時。 */
module.exports = (test, { assert }) => {
  test('[資材] 整批資產：借用不能超過可借數量；歸還後釋出；逾期標示；總數不能少於借出數；中項要在清單內', ({ call, app }) => {
    const item = call('hazel', 'inventory.create', { record: { name: '無線麥克風', category: '錄音設備', quantity: 4, unit: '支' } });
    assert.strictEqual(item.kind, '資產');
    assert.throws(() => call('hazel', 'inventory.create', { record: { name: '沒分類的', quantity: 1 } }), /分類/);
    assert.throws(() => call('hazel', 'inventory.create', { record: { name: '亂分類', category: '外星設備', quantity: 1 } }), /不在清單內/);
    assert.ok(call('hazel', 'inventory.options').categories.includes('展架'));
    assert.strictEqual(app.mapInventoryCategory_('展示與輸出器材'), '展架');
    assert.strictEqual(item.track_mode, '整批');
    const l = call('amy', 'loan.borrow', { record: { inventory_id: item.id, quantity: 3 } });
    assert.throws(() => call('hazel', 'loan.borrow', { record: { inventory_id: item.id, quantity: 2 } }), e => /只剩 1 支/.test(e.message));
    assert.strictEqual(call('hazel', 'inventory.withStock')[0].available, 1);
    assert.throws(() => call('hazel', 'inventory.update', { id: item.id, expectedUpdatedAt: item.updated_at, patch: { quantity: 2 } }), /不能少於借出/);
    call('amy', 'loan.return', { id: l.id, expectedUpdatedAt: l.updated_at });
    assert.strictEqual(call('hazel', 'inventory.withStock')[0].available, 4);
    assert.throws(() => call('amy', 'loan.borrow', { record: { inventory_id: item.id, quantity: 1, due_date: '2000-01-01' } }), e => /歸還日/.test(e.message));
  });

  test('[資材] 逐台資產：轉換時依數量建單台；借用要指定哪幾台；借出狀態只能由借還改；損壞歸還改維修；報廢不算總數', ({ call, app }) => {
    let item = call('hazel', 'inventory.create', { record: { name: '華碩筆電', quantity: 3, unit: '台', category: '3C' } });
    item = call('hazel', 'inventory.setMode', { id: item.id, expectedUpdatedAt: item.updated_at, kind: '資產', track_mode: '逐台' });
    let units = call('hazel', 'inventory.units', { inventory_id: item.id });
    assert.deepStrictEqual(units.map(u => u.asset_tag), ['A-0001', 'A-0002', 'A-0003']);
    const extra = call('hazel', 'inventory.addUnit', { inventory_id: item.id, record: { serial_no: 'SN-9', custodian_account: 'amy' } });
    assert.strictEqual(extra.custodian_account, 'amy');
    assert.strictEqual(extra.asset_tag, 'A-0004');
    assert.throws(() => call('hazel', 'inventory.addUnit', { inventory_id: item.id, record: { asset_tag: 'a-0001' } }), /已經用過/);
    assert.throws(() => call('amy', 'loan.borrow', { record: { inventory_id: item.id, quantity: 1 } }), /勾選要借哪幾台/);
    const loan = call('amy', 'loan.borrow', { record: { inventory_id: item.id, unit_ids: [units[0].id, units[1].id], due_date: '2099-01-01' } });
    assert.strictEqual(loan.quantity, 2);
    assert.throws(() => call('hazel', 'loan.borrow', { record: { inventory_id: item.id, unit_ids: [units[0].id] } }), /A-0001 目前是「借出」/);
    units = call('hazel', 'inventory.units', { inventory_id: item.id });
    assert.strictEqual(units[0].borrower_account, 'amy');
    assert.throws(() => call('hazel', 'inventory.updateUnit', { id: units[0].id, expectedUpdatedAt: units[0].updated_at, patch: { status: '可用' } }), /借還功能/);
    assert.throws(() => call('hazel', 'inventory.setMode', { id: item.id, expectedUpdatedAt: app.repo_('inventory').findById(item.id).updated_at, kind: '資產', track_mode: '整批' }), /先歸還/);
    const row = call('hazel', 'inventory.withStock').find(i => i.id === item.id);
    assert.deepStrictEqual([row.total, row.available, row.on_loan], [4, 2, 2]);
    assert.deepStrictEqual([...call('hazel', 'loan.list')[0].unit_tags], ['A-0001', 'A-0002']);
    call('amy', 'loan.return', { id: loan.id, expectedUpdatedAt: loan.updated_at, damaged_unit_ids: [units[1].id] });
    units = call('hazel', 'inventory.units', { inventory_id: item.id });
    assert.deepStrictEqual(units.map(u => u.status), ['可用', '維修', '可用', '可用']);
    assert.strictEqual(call('hazel', 'inventory.withStock').find(i => i.id === item.id).repair, 1);
    call('hazel', 'inventory.updateUnit', { id: units[3].id, expectedUpdatedAt: units[3].updated_at, patch: { status: '報廢' } });
    const after = call('hazel', 'inventory.withStock').find(i => i.id === item.id);
    assert.deepStrictEqual([after.total, after.available], [3, 2]);
    const back = call('hazel', 'inventory.setMode', { id: item.id, expectedUpdatedAt: app.repo_('inventory').findById(item.id).updated_at, kind: '資產', track_mode: '整批' });
    assert.strictEqual(back.quantity, 3);
    assert.strictEqual(call('hazel', 'inventory.units', { inventory_id: item.id }).length, 0);
  });

  test('[資材] 耗材：固定整批、不能借；入庫加、領用扣（不能扣到負）、盤點調差額；低於安全存量標示；庫存不能直接改', ({ call }) => {
    const item = call('hazel', 'inventory.create', { record: { name: '識別證套', kind: '耗材', category: '報到設備', track_mode: '逐台', quantity: 100, unit: '個', safety_stock: 30 } });
    assert.strictEqual(item.track_mode, '整批');
    assert.throws(() => call('amy', 'loan.borrow', { record: { inventory_id: item.id, quantity: 1 } }), /領用/);
    call('amy', 'stock.move', { record: { inventory_id: item.id, kind: '領用', quantity: 80, project_id: null } });
    let row = call('amy', 'inventory.withStock').find(i => i.id === item.id);
    assert.deepStrictEqual([row.total, row.low_stock], [20, true]);
    assert.throws(() => call('amy', 'stock.move', { record: { inventory_id: item.id, kind: '領用', quantity: 21 } }), /不夠領用/);
    call('hazel', 'stock.move', { record: { inventory_id: item.id, kind: '入庫', quantity: 50 } });
    const adj = call('hazel', 'stock.move', { record: { inventory_id: item.id, kind: '盤點調整', quantity: 65 } });
    assert.deepStrictEqual([adj.quantity, adj.balance], [-5, 65]);
    row = call('amy', 'inventory.withStock').find(i => i.id === item.id);
    assert.deepStrictEqual([row.total, row.low_stock], [65, false]);
    assert.deepStrictEqual(call('amy', 'stock.moves', { inventory_id: item.id }).map(m => m.kind), ['盤點調整', '入庫', '領用', '入庫']);
    assert.throws(() => call('hazel', 'inventory.update', { id: item.id, expectedUpdatedAt: row.updated_at, patch: { quantity: 999 } }), /入庫、領用或盤點/);
    assert.throws(() => call('hazel', 'inventory.update', { id: item.id, expectedUpdatedAt: row.updated_at, patch: { kind: '資產' } }), /轉換管理方式/);
  });

  test('[工讀生] 至少一種聯絡方式；合作紀錄與評分 1–5；名冊顯示平均分、次數、最近一次', ({ call }) => {
    assert.throws(() => call('hazel', 'partTimer.create', { record: { name: '陳同學' } }), /聯絡方式/);
    const p = call('hazel', 'partTimer.create', { record: { name: '陳同學', mobile: '0911-222-333', skills: '報到接待、攝影', languages: '英文' } });
    const { project } = call('hazel', 'project.create', { record: { name: '年會' } });
    call('hazel', 'partTimer.addJob', { record: { part_timer_id: p.id, project_id: project.id, work_date: '2026-10-01', role: '報到台', rating: 5, comment: '主動、細心' } });
    call('amy', 'partTimer.addJob', { record: { part_timer_id: p.id, work_date: '2026-11-01', role: '引導', rating: 4 } });
    assert.throws(() => call('amy', 'partTimer.addJob', { record: { part_timer_id: p.id, work_date: '2026-11-02', rating: 6 } }), /1 到 5/);
    const row = call('amy', 'partTimer.list').find(x => x.id === p.id);
    assert.deepStrictEqual([row.avg_rating, row.job_count, row.last_work_date, row.status], [4.5, 2, '2026-11-01', '可合作']);
    const jobs = call('amy', 'partTimer.jobs', { part_timer_id: p.id });
    assert.strictEqual(jobs[1].project_name, '年會');
    assert.strictEqual(jobs[1].rated_by, 'hazel');
    assert.throws(() => call('pt1', 'partTimer.list'), /權限/);
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
