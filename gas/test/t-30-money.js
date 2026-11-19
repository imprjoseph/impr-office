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
