/** 從 Excel 匯入：供應商依分頁對類別、補電話的 0、同名只補空白；帳密只有 admin、同項目＋帳號更新。 */
module.exports = (test, { assert }) => {
  test('[匯入] 供應商：分頁名稱對應類別；電話補 0；LINE 放備註；同名只補空白欄位；重匯不重複', ({ call, app }) => {
    const sheets = [
      { name: '攝影', rows: [{ '廠商名稱': '晨光影像', '專業項目': '活動攝影', '電話': '223456789', '業務承辦人': '張先生', '業務電話': '912345678', '電子郵件': 'a@x.tw', '備註': '週末加價' }] },
      { name: '主持人', rows: [{ '廠商名稱': '王主持', '專業項目': '中英主持', '電話': '0922000111', '語言': '中英', '電子郵件或line': 'host_wang' }] },
      { name: '神秘分頁', rows: [{ '廠商名稱': '其他公司' }, { '專業項目': '沒有名稱的列' }] },
    ];
    const r = call('boss', 'import.suppliers', { sheets });
    assert.deepStrictEqual([r.inserted, r.updated, r.skipped], [3, 0, 1]);
    const all = call('amy', 'supplier.list');
    const a = all.find(s => s.name === '晨光影像');
    assert.deepStrictEqual([a.category, a.phone, a.contact_phone, a.contact_email], ['攝影／錄影', '0223456789', '0912345678', 'a@x.tw']);
    assert.match(a.note, /週末加價/);
    const h = all.find(s => s.name === '王主持');
    assert.strictEqual(h.category, '主持／表演');
    assert.strictEqual(h.contact_email, null);
    assert.match(h.note, /LINE：host_wang/);
    assert.match(h.note, /語言：中英/);
    assert.strictEqual(all.find(s => s.name === '其他公司').category, '其他');
    // 同仁改過的欄位不被覆蓋，空白的補上
    app.withScriptLock_(() => app.repo_('suppliers').updateMany({ [a.id]: { contact_name: '李小姐', address: null } }, 'amy'));
    sheets[0].rows[0]['地址'] = '台北市';
    const again = call('boss', 'import.suppliers', { sheets });
    assert.deepStrictEqual([again.inserted, again.updated], [0, 1]);
    const a2 = call('amy', 'supplier.list').find(s => s.name === '晨光影像');
    assert.deepStrictEqual([a2.contact_name, a2.address], ['李小姐', '台北市']);
    assert.throws(() => call('amy', 'import.suppliers', { sheets }), /權限/);
  });

  test('[匯入] 帳密：只有 admin；同項目＋帳號更新密碼，新的新增；稽核只記筆數不記內容', ({ call, app }) => {
    const sheets = [{ name: '工作表1', rows: [
      { '類別': '社群', '項目': 'Facebook 粉專', '帳號': 'impr', '密碼': 'old-pw', '備註': '' },
      { '類別': '雲端', '項目': 'Google Drive', '帳號': 'admin', '密碼': 'gd-pw' },
    ] }];
    assert.throws(() => call('mgr', 'import.credentials', { sheets }), /權限/);
    assert.deepStrictEqual(Object.values(call('boss', 'import.credentials', { sheets })).slice(0, 2), [2, 0]);
    sheets[0].rows[0]['密碼'] = 'new-pw';
    const r = call('boss', 'import.credentials', { sheets });
    assert.deepStrictEqual([r.inserted, r.updated, r.skipped], [0, 1, 1]);
    const fb = call('boss', 'credential.list').find(c => c.service === 'Facebook 粉專');
    assert.deepStrictEqual([fb.category, fb.password], ['社群', 'new-pw']);
    const log = app.repo_('audit_log').findAll().filter(x => x.action === 'credential.import');
    assert.strictEqual(log.length, 2);
    assert.doesNotMatch(log[1].detail, /pw/);
  });
};
