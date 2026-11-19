/** 搬舊資料：試跑不寫入、正式寫入、重跑不重複、人名對應。 */
module.exports = (test, { assert }) => {
  function seedOld(env) {
    const tracker = env.addSpreadsheet('1Fckp1WwVp8WM7d3tuu-yNyXviDVBn1zr0huhHiJTAP8');
    tracker.insertSheet('活動總表').data = [['活動總表'], [], [], [], ['活動編號', '活動名稱', '客戶／主辦單位', '活動日期', 'PM', '執行階段', '總工作數', '成功經驗'],
      ['EVT-2026-016', '資策會淨零研討會', '資策會數轉院', new Date('2026-12-13T00:00:00Z'), 'Hazel', '執行準備', 3, ''],
      ['EVT-2026-017', '防詐簽署儀式', '電信協會', '', 'Jocelyn', '籌備中', 0, '']];
    tracker.insertSheet('工作進度').data = [['工作進度'], [], [], [], [], ['工作編號', '活動編號', '活動名稱', '工作分類', '工作項目', '負責人', '協辦人', '開始日', '截止日', '重要性', '狀態', '最新進度', '下一步', '卡關原因', '等待對象', '最後更新日', '完成日', '剩餘天數', '追蹤燈號', '提醒項目', '負責人Email'],
      ['T-201', 'EVT-2026-016', '', '視覺設計', '背板設計', 'Steven', 'Hazel', '', new Date('2026-12-01T00:00:00Z'), '高', '進行中', '初稿', '客戶確認', '', '', new Date('2026-11-18T03:00:00Z'), '', '', '', '', 'amy@impr.com.tw'],
      ['T-202', 'EVT-2099-999', '', '', '孤兒工作', 'Amy', '', '', '', '', '亂寫', '', '', '', '', '', '', '', '', '', '']];
    tracker.insertSheet('活動工作範本').data = [['活動工作範本'], [], ['工作分類', '標準工作項目', '期限基準', '預設重要性', '建議負責角色', '完成判斷', '實務提醒'],
      ['合約行政', '確認合約', 'T-60', '關鍵', 'PM', '雙方確認', ''], ['驗收結案', '成果報告', 'T+14', '中', 'PM', '', '']];
    const ev = env.addSpreadsheet('1ys8mvLU44otmToYvjPrAaPWciiRCY_Vpq2reJxQADzM');
    ev.insertSheet('suppliers').data = [['id', 'name', 'category', 'is_deleted'], ['s1', '富立音響', '音響', false], ['s2', '已刪除廠商', '其他', true]];
    ev.insertSheet('tenders').data = [['id', 'title', 'agency', 'owner_email', 'status', 'is_deleted'], ['t1', '防詐宣導', '電信協會', 'hazel@impr.com.tw', 'won', false]];
    const res = env.addSpreadsheet('1k6Hq11F4LUt73e2fSIi1iV4RhHQmFg36N-2TQ3H-S74');
    res.insertSheet('inventory').data = [['id', 'name', 'category', 'manager', 'quantity', 'location'], ['i1', '無線麥克風', '音響', 'Amy', 8, '倉庫']];
    res.insertSheet('personnel').data = [['id', 'name', 'area', 'hourlyRate', 'email'], ['p1', '工讀小陳', '台北', 190, '']];
  }

  test('[搬資料] 沒同步人員時擋下', ({ app }) => {
    assert.throws(() => app.migrateDryRun(), /同步/);
  });

  test('[搬資料] 試跑只計數不寫入；正式寫入；再跑一次全部略過', (env) => {
    const { app, call } = env;
    call('boss', 'people.sync');
    seedOld(env);
    const dry = app.migrateDryRun();
    const step = name => dry.find(r => r.step === name);
    assert.strictEqual(step('專案（活動總表）').insert, 2);
    assert.deepStrictEqual([...step('專案（活動總表）').unresolved], ['Jocelyn']);
    assert.strictEqual(step('工作（工作進度）').insert, 1);
    assert.strictEqual(app.repo_('projects').findAll().length, 0);

    const real = app.migrateAll();
    assert.ok(real.every(r => !/失敗/.test(r.note || '')), JSON.stringify(real.filter(r => r.note)));
    const p = app.repo_('projects').findAll().find(x => x.code === 'EVT-2026-016');
    assert.strictEqual(p.pm_account, 'hazel');
    assert.strictEqual(p.start_date, '2026-12-13');
    const t = app.repo_('project_tasks').findAll()[0];
    assert.strictEqual(t.project_id, p.id);
    assert.strictEqual(t.owner_account, 'amy');
    assert.strictEqual(t.assistant_account, 'hazel');
    assert.strictEqual(t.due_date, '2026-12-01');
    assert.deepStrictEqual([...app.repo_('task_templates').findAll().map(x => x.offset_days)], [-60, 14]);
    assert.deepStrictEqual([...app.repo_('suppliers').findAll().map(s => s.name)], ['富立音響']);
    assert.strictEqual(app.repo_('tenders').findAll()[0].owner_account, 'hazel');
    assert.strictEqual(app.repo_('inventory').findAll()[0].manager_account, 'amy');
    assert.strictEqual(app.PeopleService.byAccount('pt1').hourly_wage, 190);
    assert.ok(real.some(r => /找不到對應的活動編號/.test(r.note || '')));

    const again = app.migrateAll();
    assert.ok(again.filter(r => r.insert !== undefined).every(r => r.insert === 0), JSON.stringify(again));
    assert.strictEqual(app.repo_('projects').findAll().length, 2);
  });
};
