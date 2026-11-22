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
  test('[報價參考] 匯入估算與廠商報價、對到供應商；比價取最低；預算帶入 = 單價 × 數量並重算毛利', ({ call }) => {
    call('boss', 'supplier.create', { record: { name: '酷我舞台工程有限公司', category: '舞台' } });
    const sheets = [
      { name: '估算表', rows: [{ '品項': 'Truss', '類型': 'Truss', '估價': '8000', '單位': '座', '預算': '0' }, { '品項': '折合椅', '類型': '桌椅', '估價': '60', '單位': '張' }] },
      { name: '報價', rows: [
        { '品項': 'Truss', '類型': 'Truss', '廠商': '金馬行', '估價': '38,200', '單位': '座' },
        { '品項': 'Truss', '類型': 'Truss', '廠商': '酷我', '估價': '8000', '單位': '座' },
        { '品項': '紅地毯', '類型': '地毯', '廠商': '金馬行', '單位': '組' },
      ] },
    ];
    const r = call('boss', 'import.priceRefs', { sheets });
    assert.deepStrictEqual([r.inserted, r.updated], [5, 0]);
    sheets[1].rows[0]['估價'] = '36000';
    assert.deepStrictEqual(Object.values(call('boss', 'import.priceRefs', { sheets })).slice(0, 2), [0, 1]);
    const cmp = call('amy', 'priceRef.compare');
    const truss = cmp.find(g => g.item === 'Truss');
    assert.strictEqual(truss.estimate.unit_price, 8000);
    assert.deepStrictEqual(truss.quotes.map(q => q.vendor_name + ':' + q.unit_price), ['酷我:8000', '金馬行:36000']);
    assert.strictEqual(truss.lowest.supplier_name, '酷我舞台工程有限公司');
    assert.strictEqual(cmp.find(g => g.item === '紅地毯').lowest, null);

    const { project } = call('hazel', 'project.create', { record: { name: '展覽案', contract_amount: 100000 } });
    call('hazel', 'budget.addLine', { project_id: project.id, record: { category: '場地', item: '總報價', quote_amount: 100000 } });
    const chair = cmp.find(g => g.item === '折合椅').estimate;
    const lines = call('hazel', 'budget.addFromPrices', { project_id: project.id, category: '硬體設備', items: [
      { price_ref_id: truss.lowest.id, quantity: 2 }, { price_ref_id: chair.id, quantity: 100 } ] });
    assert.deepStrictEqual(lines.map(l => l.cost_estimate), [16000, 6000]);
    assert.strictEqual(lines[0].supplier_id, truss.lowest.supplier_id);
    assert.match(lines[0].note, /酷我 報價：8000 元／座 × 2/);
    const b = call('hazel', 'budget.get', { project_id: project.id });
    assert.strictEqual(b.totals.estimate, 22000);
    assert.throws(() => call('hazel', 'budget.addFromPrices', { project_id: project.id, items: [{ price_ref_id: chair.id, quantity: 0 }] }), /數量/);
    assert.throws(() => call('amy', 'import.priceRefs', { sheets }), /權限/);
  });
  test('[報價參考] 對客戶報價：有填用填的、沒填依加成設定推算；帶入預算時報價與成本一起進來', ({ call, app }) => {
    call('boss', 'import.priceRefs', { sheets: [
      { name: '估算表', rows: [{ '品項': '長桌', '類型': '桌椅', '估價': '400', '單位': '張', '對客戶報價': '600' }, { '品項': '講桌', '類型': '桌椅', '估價': '2000', '單位': '座' }] },
      { name: '報價', rows: [{ '品項': '長桌', '類型': '桌椅', '廠商': '金馬行', '估價': '350', '單位': '張' }] },
    ] });
    let cmp = call('amy', 'priceRef.compare');
    const desk = cmp.find(g => g.item === '長桌');
    assert.deepStrictEqual([desk.quote_price, desk.quote_is_markup], [600, false]);
    assert.strictEqual(cmp.find(g => g.item === '講桌').quote_price, null);
    const s = app.repo_('settings').findAll().find(x => x.key === 'quote_markup');
    call('boss', 'settings.update', { id: s.id, expectedUpdatedAt: s.updated_at, patch: { value: '0.3' } });
    cmp = call('amy', 'priceRef.compare');
    const lectern = cmp.find(g => g.item === '講桌');
    assert.deepStrictEqual([lectern.quote_price, lectern.quote_is_markup], [2600, true]);
    const { project } = call('hazel', 'project.create', { record: { name: '桌椅案' } });
    const lines = call('hazel', 'budget.addFromPrices', { project_id: project.id, items: [
      { price_ref_id: desk.lowest.id, quantity: 10 }, { price_ref_id: lectern.estimate.id, quantity: 1 } ] });
    assert.deepStrictEqual(lines.map(l => [l.quote_amount, l.cost_estimate]), [[6000, 3500], [2600, 2000]]);
    assert.match(lines[0].note, /對客戶報價 600 元／張/);
    const b = call('hazel', 'budget.get', { project_id: project.id });
    assert.strictEqual(b.totals.quote, 8600);
  });
};
