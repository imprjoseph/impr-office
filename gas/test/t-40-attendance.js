/** 考勤。日期用 2026-11-18（週三）、2026-11-21（週六）。 */
module.exports = (test, { assert }) => {
  const at = (app, iso) => app.setNowForTest_(iso);
  function setup(app, call) {
    call('boss', 'people.sync');
    app.withScriptLock_(() => {
      app.repo_('devices').insert({ device_key: 'desk-1', name: '櫃台桌機', active: true }, 'boss');
      const s = app.repo_('settings').findAll().find(x => x.key === 'office_ips');
      app.repo_('settings').updateMany({ [s.id]: { value: '1.2.3.4' } }, 'boss');
    });
  }

  test('[考勤] 純判定：彈性內不算遲到、超過算；未申請延時；核准加班依單位捨去', ({ app }) => {
    const s = { work_start: '09:00', work_end: '18:30', lunch_start: '12:00', lunch_end: '13:30', flex_min: '30', ot_threshold_min: '30', ot_unit_hours: '0.5' };
    assert.deepStrictEqual([...app.evalDay_({ date: '2026-11-18', inTime: '09:25:00', outTime: '18:56:00', s, hol: {} }).inFlags], []);
    const late = app.evalDay_({ date: '2026-11-18', inTime: '09:31:00', outTime: '19:45:00', s, hol: {} });
    assert.deepStrictEqual([...late.inFlags], ['LATE']);
    assert.deepStrictEqual([...late.outFlags], ['UNAPPROVED_OT']);
    const ot = app.evalDay_({ date: '2026-11-18', inTime: '09:00:00', outTime: '20:10:00', s, hol: {}, ots: [{ id: 'o1', plan_start: '18:30', plan_end: '21:00' }] });
    assert.strictEqual(ot.otHours.o1, 1.5);
    assert.strictEqual(app.leaveHours_('2026-11-18', '09:00', '2026-11-18', '18:30', s, {}), 8);
    assert.strictEqual(app.leaveHours_('2026-11-20', '09:00', '2026-11-23', '12:00', s, {}), 11);
  });

  test('[考勤] 辦公室打卡要 IP 與設備都符合；否則出差卡要地點事由、待主管確認；上班卡一天一次', ({ app, call }) => {
    setup(app, call);
    at(app, '2026-11-18T09:40:00Z');
    const r = call('amy', 'attendance.punch', { punch: 'IN', ip: '1.2.3.4', device_key: 'desk-1' });
    assert.strictEqual(r.record.mode, 'OFFICE');
    assert.deepStrictEqual([...r.flags], ['遲到']);
    assert.throws(() => call('amy', 'attendance.punch', { punch: 'IN', ip: '1.2.3.4', device_key: 'desk-1' }), e => /打過上班卡/.test(e.message));
    assert.throws(() => call('hazel', 'attendance.punch', { punch: 'IN', ip: '9.9.9.9' }), e => /地點/.test(e.message));
    const trip = call('hazel', 'attendance.punch', { punch: 'IN', ip: '9.9.9.9', location: '南港展覽館', reason: '活動現場', lat: 25.05, lng: 121.6 });
    assert.strictEqual(trip.record.status, '待主管確認');
    assert.strictEqual(call('mgr', 'attendance.pending').trips.length, 1);
    assert.strictEqual(call('mgr', 'attendance.reviewTrips', { ids: [trip.record.id], approve: true }), 1);
  });

  test('[考勤] 加班事前申請 → 主管核准 → 下班打卡算時數 → 可請補休，不能超額', ({ app, call }) => {
    setup(app, call);
    at(app, '2026-11-18T08:50:00Z');
    call('amy', 'attendance.punch', { punch: 'IN', ip: '1.2.3.4', device_key: 'desk-1' });
    const o = call('amy', 'attendance.applyOvertime', { record: { work_date: '2026-11-18', plan_start: '18:30', plan_end: '21:00', reason: '佈場' } });
    assert.throws(() => call('mgr', 'attendance.review', { kind: 'overtime', id: o.id, expectedUpdatedAt: o.updated_at, approve: true, note: '好' }), e => /至少 5/.test(e.message));
    assert.throws(() => call('hazel', 'attendance.review', { kind: 'overtime', id: o.id, expectedUpdatedAt: o.updated_at, approve: true, note: '同意加班佈場' }), e => e.code === 'FORBIDDEN_ERROR');
    call('mgr', 'attendance.review', { kind: 'overtime', id: o.id, expectedUpdatedAt: o.updated_at, approve: true, note: '同意加班佈場' });
    at(app, '2026-11-18T20:45:00Z');
    call('amy', 'attendance.punch', { punch: 'OUT', ip: '1.2.3.4', device_key: 'desk-1' });
    const mine = call('amy', 'attendance.mine', { month: '2026-11' });
    assert.strictEqual(mine.compBalance, 2);
    assert.throws(() => call('amy', 'attendance.applyLeave', { record: { leave_type: '補休', start_date: '2026-11-19', start_time: '09:00', end_date: '2026-11-19', end_time: '13:30', reason: '補休' } }), e => /補休時數不足/.test(e.message));
    const l = call('amy', 'attendance.applyLeave', { record: { leave_type: '補休', start_date: '2026-11-19', start_time: '09:00', end_date: '2026-11-19', end_time: '11:00', reason: '補休' } });
    assert.strictEqual(l.hours, 2);
    assert.throws(() => call('amy', 'attendance.applyLeave', { record: { leave_type: '事假', start_date: '2026-11-19', start_time: '10:00', end_date: '2026-11-19', end_time: '12:00', reason: '私事' } }), e => /重疊/.test(e.message));
    assert.throws(() => call('amy', 'attendance.applyLeave', { record: { leave_type: '事假', start_date: '2026-11-21', start_time: '09:00', end_date: '2026-11-21', end_time: '18:30', reason: '週六' } }), e => /不必請假/.test(e.message));
    at(app, '2026-11-18T22:00:00Z');
    assert.throws(() => call('amy', 'attendance.applyOvertime', { record: { work_date: '2026-11-18', plan_start: '18:30', plan_end: '19:00', reason: '補申請' } }), e => /事前/.test(e.message));
  });

  test('[考勤] 補卡核准後產生打卡紀錄並重算；月報統計遲到', ({ app, call }) => {
    setup(app, call);
    at(app, '2026-11-18T18:40:00Z');
    const c = call('amy', 'attendance.applyCorrection', { record: { work_date: '2026-11-18', punch: 'IN', request_time: '09:45', reason: '忘記打卡' } });
    call('mgr', 'attendance.review', { kind: 'correction', id: c.id, expectedUpdatedAt: c.updated_at, approve: true, note: '確認有到班' });
    const rec = call('amy', 'attendance.mine', { month: '2026-11' }).attendance[0];
    assert.strictEqual(rec.mode, 'FIX');
    assert.strictEqual(rec.flag, 'LATE');
    const report = call('mgr', 'attendance.monthly', { month: '2026-11' });
    assert.strictEqual(report.find(r => r.account === 'amy').late, 1);
    assert.strictEqual(report.some(r => r.account === 'boss'), false);
  });
};
