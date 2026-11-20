/** 派遣。 */
module.exports = (test, { assert }) => {
  function setup(app, call) {
    call('boss', 'people.sync');
    const { project } = call('hazel', 'project.create', { record: { name: '國防 AI 論壇', venue: '南港展覽館' } });
    call('hazel', 'budget.addLine', { project_id: project.id, record: { category: '人力', item: '總報價', quote_amount: 100000, cost_estimate: 0 } });
    return project;
  }

  test('[派遣] 排班時填時薪；同人同期間不能排兩個專案；正職不能排', ({ app, call }) => {
    const project = setup(app, call);
    const a = call('hazel', 'dispatch.assign', { record: { account: 'pt1', project_id: project.id, start_date: '2026-11-18', end_date: '2026-11-19', role: '報到', hourly_wage: 200 } });
    assert.strictEqual(a.hourly_wage, 200);
    assert.throws(() => call('hazel', 'dispatch.assign', { record: { account: 'pt1', project_id: project.id, start_date: '2026-11-19', end_date: '2026-11-20' } }), e => e.code === 'SCHEDULE_CONFLICT_ERROR');
    assert.throws(() => call('hazel', 'dispatch.assign', { record: { account: 'amy', project_id: project.id, start_date: '2026-11-25', end_date: '2026-11-25' } }), e => /派遣人員/.test(e.message));
    assert.strictEqual('hourly_wage' in call('amy', 'dispatch.list')[0], false);
  });

  test('[派遣] 沒排班不能打卡；打完上下班卡，工時 × 時薪計入專案成本並重算毛利', ({ app, call }) => {
    const project = setup(app, call);
    app.setNowForTest_('2026-11-17T08:00:00Z');
    assert.throws(() => call('pt1', 'dispatch.punch', { punch: 'IN' }), e => /沒有你的派遣排班/.test(e.message));
    call('hazel', 'dispatch.assign', { record: { account: 'pt1', project_id: project.id, start_date: '2026-11-18', end_date: '2026-11-18', hourly_wage: 200 } });
    app.setNowForTest_('2026-11-18T08:00:00Z');
    call('pt1', 'dispatch.punch', { punch: 'IN', location: '南港' });
    app.setNowForTest_('2026-11-18T18:10:00Z');
    call('pt1', 'dispatch.punch', { punch: 'OUT' });
    // 08:00–18:10 扣午休 1.5 小時 = 8h40m → 以 0.5 小時捨去 8.5 小時 × 200
    const labor = call('acc', 'dispatch.laborCost', { project_id: project.id });
    assert.strictEqual(labor.hours, 8.5);
    assert.strictEqual(labor.cost, 1700);
    const p = call('hazel', 'project.get', { id: project.id }).project;
    assert.strictEqual(p.cost_actual_total, 1700);
    assert.strictEqual(p.margin_rate, 0.983);
    const mine = call('pt1', 'dispatch.mine');
    assert.strictEqual(mine.todayAssignment.venue, '南港展覽館');
    assert.strictEqual(mine.punches.length, 2);
  });

  test('[派遣] 派遣人員只能用自己的功能：回報、問題；同仁回覆問題', ({ app, call }) => {
    const project = setup(app, call);
    call('pt1', 'dispatch.report', { record: { project_id: project.id, content: '報到台協助 120 人', hours: 8 } });
    const i = call('pt1', 'dispatch.raiseIssue', { record: { project_id: project.id, title: '名牌不夠' } });
    const r = call('hazel', 'dispatch.replyIssue', { id: i.id, expectedUpdatedAt: i.updated_at, reply: '已補印 50 張' });
    assert.strictEqual(r.status, '已處理');
    assert.throws(() => call('pt1', 'dispatch.list'), e => e.code === 'FORBIDDEN_ERROR');
    assert.throws(() => call('pt1', 'expense.list', { scope: 'mine' }), e => e.code === 'FORBIDDEN_ERROR');
    assert.throws(() => call('pt1', 'attendance.punch', { punch: 'IN' }), e => e.code === 'FORBIDDEN_ERROR');
    assert.throws(() => call('hazel', 'dispatch.punch', { punch: 'IN' }), e => e.code === 'FORBIDDEN_ERROR');
  });
  test('[派遣] 權限邊界：派遣人員只能用 session.me 與 dispatch.*，其他每條路由都擋', ({ app, call }) => {
    const routes = app.allRoutes_();
    const open = Object.keys(routes).filter(k => routes[k].roles.indexOf('dispatch') !== -1).sort();
    assert.deepStrictEqual(open.filter(k => k !== 'session.me' && k.indexOf('dispatch.') !== 0), []);
    // 實際呼叫幾個內部功能都被擋
    ['dashboard.me', 'attendance.mine', 'attendance.options', 'holiday.list', 'project.list', 'client.list', 'people.list',
      'inventory.withStock', 'partTimer.list', 'media.list', 'ai.forms', 'publicTender.list'].forEach(action => {
      assert.throws(() => call('pt1', action, { month: '2026-11' }), e => e.code === 'FORBIDDEN_ERROR' || /權限/.test(e.message), action);
    });
    // 內部同仁也不能用派遣人員的自助功能（避免用錯入口）
    assert.throws(() => call('amy', 'dispatch.attendanceMine', { month: '2026-11' }), /權限/);
  });

  test('[派遣] 派遣人員在「我的派遣」裡請假、加班、補卡、看自己的出勤', ({ call }) => {
    call('boss', 'people.sync');
    const opts = call('pt1', 'dispatch.attendanceOptions', {});
    assert.ok(opts.leaveTypes.length > 0);
    const leave = call('pt1', 'dispatch.applyLeave', { record: { leave_type: opts.leaveTypes[0], start_date: '2099-01-05', start_time: '09:00', end_date: '2099-01-05', end_time: '18:30', reason: '家中有事' } });
    assert.strictEqual(leave.account, 'pt1');
    const mine = call('pt1', 'dispatch.attendanceMine', { month: '2099-01' });
    assert.strictEqual(mine.leaves.length, 1);
    call('pt1', 'dispatch.cancelLeave', { id: leave.id, expectedUpdatedAt: leave.updated_at });
  });
};
