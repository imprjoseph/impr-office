/** 人員、客戶、供應商。 */
module.exports = (test, { assert }) => {
  test('[人員] 從帳號中心同步：新增、再同步不重複；名單消失的標停用；人員沒有時薪欄；同仁看不到評價', ({ app, call, USERS }) => {
    const r = call('boss', 'people.sync');
    assert.strictEqual(r.added, Object.keys(USERS).length);
    assert.deepStrictEqual({ ...call('boss', 'people.sync') }, { added: 0, updated: 0 });
    const amy = app.PeopleService.byAccount('amy');
    assert.strictEqual(amy.manager_account, 'mgr');
    assert.strictEqual(app.PeopleService.byAccount('pt1').kind, '派遣');
    assert.throws(() => call('boss', 'people.update', { id: amy.id, expectedUpdatedAt: amy.updated_at, patch: { hourly_wage: 200 } }), /hourly_wage|不能修改|不允許/);
    call('boss', 'people.update', { id: amy.id, expectedUpdatedAt: amy.updated_at, patch: { rating: 4 } });
    assert.strictEqual(call('acc', 'people.list').find(p => p.account === 'amy').rating, 4);
    assert.strictEqual('rating' in call('hazel', 'people.list').find(p => p.account === 'amy'), false);
    assert.strictEqual('hourly_wage' in call('acc', 'people.list').find(p => p.account === 'amy'), false);
    delete USERS.amy;
    call('boss', 'people.sync');
    assert.strictEqual(call('boss', 'people.list').some(p => p.account === 'amy'), false);
  });

  test('[人員] staff 不能同步或改人事資料；派遣不能看人員名單', ({ call }) => {
    assert.throws(() => call('hazel', 'people.sync'), e => e.code === 'FORBIDDEN_ERROR');
    assert.throws(() => call('pt1', 'people.list'), e => e.code === 'FORBIDDEN_ERROR');
  });

  test('[客戶] 新增、同名（忽略空白大小寫）擋下、統編格式與重複、樂觀鎖', ({ call }) => {
    const c = call('hazel', 'client.create', { record: { name: '數位發展部', tax_id: '12345678' } });
    assert.throws(() => call('amy', 'client.create', { record: { name: '數位 發展部' } }), e => /同名/.test(e.message));
    assert.throws(() => call('amy', 'client.create', { record: { name: 'NCC', tax_id: '123' } }), e => /8 位/.test(e.message));
    assert.throws(() => call('amy', 'client.create', { record: { name: 'NCC', tax_id: '12345678' } }), e => /已用於/.test(e.message));
    const u = call('amy', 'client.update', { id: c.id, expectedUpdatedAt: c.updated_at, patch: { industry: '政府' } });
    assert.strictEqual(u.updated_by, 'amy');
    assert.throws(() => call('amy', 'client.update', { id: c.id, expectedUpdatedAt: c.updated_at, patch: { industry: 'x' } }), e => e.code === 'CONFLICT_ERROR');
    assert.throws(() => call('amy', 'client.create', { record: { name: 'X', is_deleted: true } }), e => /不接受欄位/.test(e.message));
  });

  test('[供應商] 檔期：同日交接算衝突、取消後釋出；評分重算平均、同專案不能評兩次', ({ app, call }) => {
    const s = call('hazel', 'supplier.create', { record: { name: '富立音響', category: '音響' } });
    const prj = app.withScriptLock_(() => app.repo_('projects').insert({ code: 'EVT-2026-001', name: '年會', stage: '規劃中' }, 'hazel'));
    const b = call('hazel', 'supplier.book', { supplier_id: s.id, project_id: prj.id, start_date: '2026-12-01', end_date: '2026-12-03' });
    assert.throws(() => call('amy', 'supplier.book', { supplier_id: s.id, project_id: prj.id, start_date: '2026-12-03', end_date: '2026-12-04' }),
      e => e.code === 'SCHEDULE_CONFLICT_ERROR' && e.details.conflicts.length === 1);
    call('hazel', 'supplier.cancelBooking', { id: b.id, expectedUpdatedAt: b.updated_at });
    assert.strictEqual(call('amy', 'supplier.checkConflict', { supplier_id: s.id, start_date: '2026-12-03', end_date: '2026-12-04' }).hasConflict, false);
    app.SupplierService.rate(prj.id, [{ supplier_id: s.id, score: 4 }], { account: 'hazel' });
    assert.throws(() => app.SupplierService.rate(prj.id, [{ supplier_id: s.id, score: 5 }], { account: 'hazel' }), e => /評過/.test(e.message));
    const sup = call('hazel', 'supplier.list')[0];
    assert.strictEqual(sup.avg_rating, 4);
    assert.strictEqual(sup.rating_count, 1);
    assert.throws(() => call('hazel', 'supplier.update', { id: sup.id, expectedUpdatedAt: sup.updated_at, patch: { avg_rating: 5 } }), e => /不接受/.test(e.message));
  });
};
