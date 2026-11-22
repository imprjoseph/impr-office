/** 公開標案：讀政府標案資料庫、篩選、追蹤後建立標案並回寫原表；網頁搬資料。 */
module.exports = (test, { assert }) => {
  const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const HEAD = ['主鍵', '公告日', '機關', '案名', '預算', '截止投標', '公告類型', '案號', '關鍵字群組', '命中關鍵字', '分數', '連結', '首次收錄', '狀態', '負責人', '是否投標', '備註'];
  function seed(env) {
    const ss = env.addSpreadsheet('1vKY27NlrPMpUOyq5mqSWgGRiJSHxaB-eDAJEr49mMVk');
    const sh = ss.insertSheet('符合案件');
    sh.data = [HEAD,
      ['A|1', day(-1), '臺北市政府', '2027 城市論壇', '1,247,200', day(10), '公開招標公告', 'T-001', '國際會議論壇/AI推薦1.00', '論壇', 20, '開啟', '', '', '', '', ''],
      ['B|2', day(-2), '新竹縣政府', '社群平台經營案', '1,700,000', day(5), '公開取得報價單', 'T-002', '宣導行銷', '社群', 8, '開啟', '', '', '', '', ''],
      ['C|3', day(-20), '屏東縣政府', '已截標的展覽', '700,000', day(-3), '公開取得報價單', 'T-003', '活動執行', '展覽', 4, '開啟', '', '', '', '', ''],
    ];
    sh.formulas['2,12'] = '=HYPERLINK("https://web.pcc.gov.tw/a","開啟")';
    return sh;
  }

  test('[公開標案] 只列未截標；關鍵字、群組、分數篩選；連結取自 HYPERLINK', (env) => {
    seed(env);
    const r = env.call('hazel', 'publicTender.list', {});
    assert.strictEqual(r.totalAll, 3);
    assert.deepStrictEqual(r.rows.map(t => t.tender_no), ['T-001', 'T-002']);
    assert.strictEqual(r.rows[0].url, 'https://web.pcc.gov.tw/a');
    assert.strictEqual(r.rows[0].budget, 1247200);
    assert.ok(r.groups.includes('國際會議論壇') && r.groups.includes('AI推薦'));
    assert.strictEqual(env.call('hazel', 'publicTender.list', { includeClosed: true }).total, 3);
    assert.deepStrictEqual(env.call('hazel', 'publicTender.list', { q: '社群' }).rows.map(t => t.tender_no), ['T-002']);
    assert.deepStrictEqual(env.call('hazel', 'publicTender.list', { group: '國際會議論壇' }).rows.map(t => t.tender_no), ['T-001']);
    assert.deepStrictEqual(env.call('hazel', 'publicTender.list', { minScore: 10 }).rows.map(t => t.tender_no), ['T-001']);
    assert.throws(() => env.call('pt1', 'publicTender.list', {}), /權限/);
  });

  test('[公開標案] 讀過一次會暫存，第二次不重讀試算表；連結只讀連結欄', (env) => {
    const sh = seed(env);
    let reads = 0;
    const orig = sh.getDataRange.bind(sh);
    sh.getDataRange = () => { reads++; return orig(); };
    env.call('hazel', 'publicTender.list', {});
    const r2 = env.call('hazel', 'publicTender.list', { q: '社群' });
    assert.strictEqual(reads, 1);
    assert.deepStrictEqual(r2.rows.map(t => t.tender_no), ['T-002']);
    assert.strictEqual(env.call('hazel', 'publicTender.list', {}).rows[0].url, 'https://web.pcc.gov.tw/a');
    env.call('hazel', 'publicTender.track', { key: 'B|2' });
    env.call('hazel', 'publicTender.list', {});
    assert.strictEqual(reads, 2); // 追蹤時用暫存，回寫原表後清掉暫存，下一次才重讀
  });

  test('[公開標案] 追蹤：建立標案、回寫原表狀態與負責人；重按不重複', (env) => {
    const sh = seed(env);
    const a = env.call('hazel', 'publicTender.track', { key: 'A|1' });
    assert.strictEqual(a.created, true);
    assert.strictEqual(a.tender.title, '2027 城市論壇');
    assert.strictEqual(a.tender.agency, '臺北市政府');
    assert.strictEqual(a.tender.budget_amount, 1247200);
    assert.strictEqual(a.tender.source_url, 'https://web.pcc.gov.tw/a');
    assert.strictEqual(a.tender.owner_account, 'hazel');
    assert.strictEqual(sh.data[1][13], '評估中');
    assert.ok(sh.data[1][14]);
    const again = env.call('amy', 'publicTender.track', { key: 'A|1' });
    assert.strictEqual(again.created, false);
    assert.strictEqual(env.app.repo_('tenders').findAll().length, 1);
    assert.strictEqual(env.call('hazel', 'publicTender.list', {}).rows[0].tracked_id, a.tender.id);
  });

  test('[搬資料] 網頁執行：只有 admin；沒人員時先自動同步；預設試跑', (env) => {
    assert.throws(() => env.call('hazel', 'migration.run', {}), /權限/);
    const st = env.call('boss', 'migration.status', {});
    assert.strictEqual(st.people, 0);
    assert.ok(st.sources.find(s => s.key === 'attendance').id);
    const r = env.call('boss', 'migration.run', {});
    assert.strictEqual(r.dry, true);
    assert.ok(r.synced);
    assert.ok(env.app.repo_('people').findAll().length > 0);
    assert.match(r.text, /派遣勤務/);
  });
};
