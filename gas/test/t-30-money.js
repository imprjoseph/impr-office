/** 預算毛利、費用請款。 */
module.exports = (test, { assert }) => {
  function setup(call) {
    call('boss', 'people.sync');
    const { project } = call('hazel', 'project.create', { record: { name: '年會' } });
    const line = call('hazel', 'budget.addLine', { project_id: project.id, record: { category: '場地', item: '會議廳', quote_amount: 100000, cost_estimate: 60000 } });
    return { project, line };
  }

  test('[毛利] 純計算：科目取預估與實際較大者；增減項、未掛科目費用、人力都算進去', ({ app }) => {
    const r = app.computeMargin_(
      [{ id: 'a', quote_amount: 100, cost_estimate: 60, cost_actual: 0 }, { id: 'b', quote_amount: 50, cost_estimate: 20, cost_actual: 30 }],
      [{ quote_delta: 50, cost_delta: 10 }],
      [{ budget_line_id: 'a', amount: 70 }, { budget_line_id: null, amount: 5 }],
      { cost: 15 }).totals;
    assert.strictEqual(r.quote, 200);
    assert.strictEqual(r.current, 70 + 30 + 10 + 5 + 15);
    assert.strictEqual(r.marginRate, 0.35);
  });

  test('[毛利] 新增科目、增減項即時重算專案毛利；低於門檻標警示；同仁看不到預算', ({ call }) => {
    const { project } = setup(call);
    let p = call('hazel', 'project.get', { id: project.id }).project;
    assert.strictEqual(p.margin_rate, 0.4);
    assert.strictEqual(p.margin_alert, false);
    call('hazel', 'budget.addChange', { project_id: project.id, record: { kind: '增項', description: '加一場晚宴', quote_delta: 0, cost_delta: 25000 } });
    p = call('hazel', 'project.get', { id: project.id }).project;
    assert.strictEqual(p.margin_rate, 0.15);
    assert.strictEqual(p.margin_alert, true);
    assert.throws(() => call('amy', 'budget.get', { project_id: project.id }), e => e.code === 'FORBIDDEN_ERROR');
    assert.throws(() => call('amy', 'budget.addLine', { project_id: project.id, record: { category: 'x', item: 'y' } }), e => e.code === 'FORBIDDEN_ERROR');
    assert.throws(() => call('hazel', 'budget.addChange', { project_id: project.id, record: { kind: '亂', description: 'x' } }), e => /增項或減項/.test(e.message));
  });

  test('[請款] 申請 → 主管核准 → 會計付款；核准後計入專案實際成本並重算毛利', ({ call }) => {
    const { project, line } = setup(call);
    const d = call('amy', 'expense.create', { record: { project_id: project.id, budget_line_id: line.id, category: '設備租借', description: '投影機', amount: 70000 } });
    assert.strictEqual(d.status, 'draft');
    const s = call('amy', 'expense.submit', { id: d.id, expectedUpdatedAt: d.updated_at });
    assert.strictEqual(s.approver_account, 'mgr');
    assert.strictEqual(call('mgr', 'expense.list', { scope: 'approve' }).length, 1);
    assert.strictEqual(call('hazel', 'project.get', { id: project.id }).project.cost_actual_total, 0);
    const a = call('mgr', 'expense.approve', { id: s.id, expectedUpdatedAt: s.updated_at });
    const p = call('hazel', 'project.get', { id: project.id }).project;
    assert.strictEqual(p.cost_actual_total, 70000);
    assert.strictEqual(p.margin_rate, 0.3);
    assert.strictEqual(call('acc', 'expense.list', { scope: 'pay' }).length, 1);
    const paid = call('acc', 'expense.pay', { id: a.id, expectedUpdatedAt: a.updated_at, note: '已匯款' });
    assert.strictEqual(paid.status, 'paid');
    assert.strictEqual(call('hazel', 'budget.get', { project_id: project.id }).lines[0].expense_actual, 70000);
  });

  test('[請款] 對沖成本：同仁看得到科目名稱（看不到金額）；PM 或財務可事後改對沖科目並重算；同仁不行；科目要屬於該專案', ({ call }) => {
    const { project, line } = setup(call);
    const opts = call('amy', 'budget.lineOptions', { project_id: project.id });
    assert.deepStrictEqual(Object.keys(opts[0]).sort(), ['category', 'id', 'item']);
    assert.strictEqual(call('hazel', 'budget.lineOptions', { project_id: project.id })[0].remaining, 60000);
    const d = call('amy', 'expense.create', { record: { project_id: project.id, category: '設備租借', description: '音響', amount: 30000 } });
    const s = call('amy', 'expense.submit', { id: d.id, expectedUpdatedAt: d.updated_at });
    const a = call('mgr', 'expense.approve', { id: s.id, expectedUpdatedAt: s.updated_at });
    assert.strictEqual(call('hazel', 'budget.get', { project_id: project.id }).unlinkedExpenses.length, 1);
    assert.throws(() => call('amy', 'expense.setBudgetLine', { id: a.id, budget_line_id: line.id }), /PM 或財務/);
    call('hazel', 'expense.setBudgetLine', { id: a.id, budget_line_id: line.id });
    const b = call('hazel', 'budget.get', { project_id: project.id });
    assert.strictEqual(b.unlinkedExpenses.length, 0);
    assert.strictEqual(b.lines[0].expense_actual, 30000);
    assert.strictEqual(b.expenses.length, 1);
    assert.strictEqual(call('amy', 'expense.list', { scope: 'mine' })[0].budget_line_label, line.category + '／' + line.item);
    const other = call('hazel', 'project.create', { record: { name: '別的案子' } }).project;
    const otherLine = call('hazel', 'budget.addLine', { project_id: other.id, record: { category: line.category, item: '別的' } });
    assert.throws(() => call('acc', 'expense.setBudgetLine', { id: a.id, budget_line_id: otherLine.id }), /不屬於/);
    call('acc', 'expense.setBudgetLine', { id: a.id, budget_line_id: null });
    assert.strictEqual(call('hazel', 'budget.get', { project_id: project.id }).unlinkedExpenses.length, 1);
  });

  test('[報價單] 總價＝單價×數量、優惠價優先；送審後鎖住；主管核定後同仁只能填實際成本；主管退回才能改', ({ call }) => {
    const { project } = setup(call);
    const l = call('hazel', 'budget.addLine', { project_id: project.id, record: { category: '硬體設備', item: 'LED 螢幕', spec: '4x3m', description: '含架設', unit_price: 50000, quantity: 2, discount_price: 90000, cost_estimate: 70000 } });
    assert.strictEqual(l.quote_amount, 90000);
    const l2 = call('hazel', 'budget.updateLine', { id: l.id, expectedUpdatedAt: l.updated_at, patch: { discount_price: null } });
    assert.strictEqual(l2.quote_amount, 100000);
    let b = call('hazel', 'budget.get', { project_id: project.id });
    assert.strictEqual(b.lines.find(x => x.id === l.id).list_total, 100000);
    assert.strictEqual(b.quote.status, '草稿');
    assert.throws(() => call('hazel', 'quote.approve', { project_id: project.id }), /權限|主管/);
    call('hazel', 'quote.submit', { project_id: project.id });
    assert.throws(() => call('hazel', 'budget.updateLine', { id: l.id, expectedUpdatedAt: l2.updated_at, patch: { unit_price: 1 } }), /送審中/);
    assert.throws(() => call('mgr', 'quote.approve', { project_id: 'nope' }), /找不到/);
    const q = call('mgr', 'quote.approve', { project_id: project.id });
    assert.strictEqual(q.status, '已核定');
    assert.strictEqual(q.approved_total, 200000);
    assert.throws(() => call('hazel', 'budget.addLine', { project_id: project.id, record: { category: '雜支', item: '加一項' } }), /已經主管核定/);
    assert.throws(() => call('hazel', 'budget.updateLine', { id: l.id, expectedUpdatedAt: l2.updated_at, patch: { cost_estimate: 1 } }), /已經主管核定/);
    call('hazel', 'budget.updateLine', { id: l.id, expectedUpdatedAt: l2.updated_at, patch: { cost_actual: 5000, note: '訂金發票' } });
    assert.throws(() => call('mgr', 'quote.return', { project_id: project.id }), /原因/);
    call('mgr', 'quote.return', { project_id: project.id, note: '客戶要加場' });
    b = call('hazel', 'budget.get', { project_id: project.id });
    assert.deepStrictEqual([b.quote.status, b.quote.review_note], ['退回修改', '客戶要加場']);
    call('hazel', 'budget.addLine', { project_id: project.id, record: { category: '雜支', item: '加一項' } });
  });

  test('[請款] 分次申請累加到科目；超過核定金額標示（草稿先預告）；同仁看不到數字；付款對象新增廠商、公司卡不用對象', ({ call, app }) => {
    const { project, line } = setup(call); // 核定（預估成本）60000
    const mk = (amount, extra) => call('amy', 'expense.create', { record: Object.assign({ project_id: project.id, budget_line_id: line.id, category: '設備租借', description: '第' + amount, amount }, extra || {}) });
    const send = e => call('amy', 'expense.submit', { id: e.id, expectedUpdatedAt: e.updated_at });
    const e1 = send(mk(40000, { payee: '公司卡支付' }));
    assert.strictEqual(e1.supplier_id, null);
    const d2 = mk(30000, { payee: '付給廠商' });
    assert.throws(() => send(d2), /付款對象/);
    const d2b = call('amy', 'expense.update', { id: d2.id, expectedUpdatedAt: d2.updated_at, patch: { payee_name: '新廠商音響行', payee_bank: '台銀 123' } });
    let mine = call('amy', 'expense.list', { scope: 'mine' });
    assert.deepStrictEqual(mine.find(x => x.id === d2.id).over_budget, { hidden: true, draft: true });
    assert.strictEqual(mine.find(x => x.id === e1.id).over_budget, undefined);
    const e2 = send(d2b);
    const sup = app.repo_('suppliers').findById(e2.supplier_id);
    assert.strictEqual(sup.name, '新廠商音響行');
    assert.match(sup.note, /台銀 123/);
    const pending = call('mgr', 'expense.list', { scope: 'approve' });
    assert.deepStrictEqual(pending.find(x => x.id === e2.id).over_budget, { approved: 60000, claimed: 70000, over: 10000 });
    assert.ok(!pending.find(x => x.id === e1.id).over_budget);
    call('mgr', 'expense.approve', { id: e1.id, expectedUpdatedAt: e1.updated_at });
    const b = call('hazel', 'budget.get', { project_id: project.id });
    assert.strictEqual(b.lines[0].claimed, 70000);
    assert.strictEqual(b.lines[0].expense_actual, 40000);
    assert.strictEqual(b.pendingExpenses[0].over_budget.over, 10000);
    // 同名的付款對象對到既有廠商，不重複新增
    const d3 = send(mk(100, { payee: '付給廠商', payee_name: '新廠商 音響行' }));
    assert.strictEqual(d3.supplier_id, e2.supplier_id);
    assert.throws(() => mk(1, { payee: '亂填' }), /付款方式/);
  });

  test('[專案] 客戶窗口：從客戶主要窗口或聯絡人選，自動帶職稱與聯絡方式；也可以直接填', ({ call }) => {
    const c = call('hazel', 'client.create', { record: { name: '衛福部', contact_name: '王科長', contact_title: '科長', contact_phone: '02-1234' } });
    assert.deepStrictEqual(call('hazel', 'project.clientContacts', { client_id: c.id }).map(x => x.name), ['王科長']);
    const p = call('hazel', 'project.create', { record: { name: '衛福論壇', client_id: c.id, client_contact: '王科長' } }).project;
    assert.deepStrictEqual([p.client_contact_title, p.client_contact_info], ['科長', '02-1234']);
    const p2 = call('hazel', 'project.create', { record: { name: '衛福論壇二', client_id: c.id, client_contact: '李小姐', client_contact_info: 'li@x.tw' } }).project;
    assert.deepStrictEqual([p2.client_contact, p2.client_contact_info], ['李小姐', 'li@x.tw']);
  });

  test('[請款] 規則：不能核自己的、只有直屬主管能核、退回要寫原因、送出後不能改、會計以外不能付款', ({ call }) => {
    const { project } = setup(call);
    const d = call('mgr', 'expense.create', { record: { project_id: project.id, category: '餐費', description: '便當', amount: 1500 } });
    const s = call('mgr', 'expense.submit', { id: d.id, expectedUpdatedAt: d.updated_at });
    assert.throws(() => call('mgr', 'expense.approve', { id: s.id, expectedUpdatedAt: s.updated_at }), e => /自己/.test(e.message));
    const d2 = call('amy', 'expense.create', { record: { category: '交通', description: '計程車', amount: 300 } });
    const s2 = call('amy', 'expense.submit', { id: d2.id, expectedUpdatedAt: d2.updated_at });
    assert.throws(() => call('amy', 'expense.update', { id: s2.id, expectedUpdatedAt: s2.updated_at, patch: { amount: 3000 } }), e => /已送出/.test(e.message));
    assert.throws(() => call('mgr', 'expense.reject', { id: s2.id, expectedUpdatedAt: s2.updated_at }), e => /原因/.test(e.message));
    const r = call('mgr', 'expense.reject', { id: s2.id, expectedUpdatedAt: s2.updated_at, note: '缺收據' });
    const fixed = call('amy', 'expense.update', { id: r.id, expectedUpdatedAt: r.updated_at, patch: { receipt_no: 'AB12345678' } });
    const s3 = call('amy', 'expense.submit', { id: fixed.id, expectedUpdatedAt: fixed.updated_at });
    const a3 = call('boss', 'expense.approve', { id: s3.id, expectedUpdatedAt: s3.updated_at });
    assert.throws(() => call('mgr', 'expense.pay', { id: a3.id, expectedUpdatedAt: a3.updated_at }), e => e.code === 'FORBIDDEN_ERROR');
    assert.throws(() => call('amy', 'expense.create', { record: { category: '交通', description: 'x', amount: 0 } }), e => /大於 0/.test(e.message));
  });
};
