/** 骨架：建表、登入、角色檢查、派遣隔離。 */
module.exports = (test, { assert }) => {
  test('[骨架] setupDatabase 建立全部分頁，每張都有公共欄位；預設設定寫入一次', ({ app, spreadsheet }) => {
    const common = ['id', 'created_at', 'created_by', 'updated_at', 'updated_by', 'is_deleted'];
    Object.keys(app.TABLES).forEach(n => {
      const header = spreadsheet.getSheetByName(n).data[0];
      common.forEach(c => assert.ok(header.includes(c), n + ' 缺 ' + c));
    });
    const before = app.repo_('settings').findAll().length;
    app.setupDatabase();
    assert.strictEqual(app.repo_('settings').findAll().length, before);
  });

  test('[骨架] session.me 回傳帳號中心的身分；憑證無效回 AUTH', ({ call }) => {
    const me = call('hazel', 'session.me');
    assert.strictEqual(me.account, 'hazel');
    assert.strictEqual(me.role, 'staff');
    assert.throws(() => call('nobody', 'session.me'), e => e.code === 'AUTH_ERROR' && e.details.authCode === 'TOKEN');
  });

  test('[骨架] 派遣帳號即使帳號中心填 staff，也一律當 dispatch', ({ call }) => {
    assert.strictEqual(call('pt1', 'session.me').role, 'dispatch');
  });

  test('[骨架] 驗證結果暫存：同一憑證第二次不再問帳號中心', ({ call, fetchCalls }) => {
    call('amy', 'session.me');
    call('amy', 'session.me');
    assert.strictEqual(fetchCalls.filter(c => JSON.parse(c.opts.payload).action === 'verify').length, 1);
  });

  test('[骨架] 未知操作拒絕', ({ call }) => {
    assert.throws(() => call('boss', 'nope.nope'), e => e.code === 'VALIDATION_ERROR');
  });
};
