/**
 * 考勤：打卡、請假、加班、補卡與主管審核。規則沿用舊出勤系統（impr-attendance）：
 * - 辦公室 IP 與登記設備都符合才算辦公室打卡；否則是出差打卡，要填地點與事由、主管確認。
 * - 彈性上班：晚到幾分鐘就晚走幾分鐘（最多 flex_min），超過才算遲到。
 * - 加班須事前申請；超時但沒核准的加班單標「未申請延時」、不計時數。
 * - 補休可用時數 = 核准加班實際時數 − 待審與已核准的補休。
 * 派遣人員的打卡在 DispatchService，要對應當天的派遣排班。
 */

const REVIEW_STATUS = { PENDING: '待審', APPROVED: '核准', REJECTED: '駁回', CANCELLED: '已取消' };
const PUNCH = { IN: 'IN', OUT: 'OUT' };
const PUNCH_MODES_ = { OFFICE: 'OFFICE', TRIP: 'TRIP', FIX: 'FIX', SITE: 'SITE' };
const TRIP_REASONS = ['客戶會議', '活動現場', '場勘', '政府機關洽公', '其他'];
const LEAVE_TYPES = ['特休', '補休', '病假', '事假', '婚假', '喪假', '公假', '生理假', '產假', '陪產假'];
const COMP_LEAVE_ = '補休';
const MAX_LEAVE_DAYS_ = 31;
const MIN_REASON_LEN_ = 5;
const HM_RE_ = /^([01]\d|2[0-3]):[0-5]\d$/;
const FLAG_LABELS = { LATE: '遲到', EARLY: '早退', UNAPPROVED_OT: '未申請延時' };

// 測試用：固定「現在」。正式環境永遠是 null。
let NOW_OVERRIDE_ = null;
function setNowForTest_(iso) { NOW_OVERRIDE_ = iso; }
function now_() { return NOW_OVERRIDE_ ? new Date(NOW_OVERRIDE_) : new Date(); }
function nowParts_() {
  const d = now_();
  const tz = Session.getScriptTimeZone();
  return { date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), time: Utilities.formatDate(d, tz, 'HH:mm:ss'), iso: d.toISOString() };
}

const AttendanceService = {
  /**
   * 打卡。上班卡一天一次；下班卡可重打，以最後一次為準（覆寫同一筆，舊值留稽核紀錄）。
   * input：{ punch, ip, device_key, location, reason, reason_note, lat, lng }
   */
  punch(input, ctx) {
    const n = nowParts_();
    const mode = judgeMode_(input.device_key, input.ip);
    const rec = {
      account: ctx.account, work_date: n.date, punch: input.punch, punch_time: n.time, mode,
      ip: input.ip || null, device_key: input.device_key || null, status: '正常',
    };
    if (input.punch !== PUNCH.IN && input.punch !== PUNCH.OUT) throw new AppError(ERROR_CODES.VALIDATION, '請選擇上班或下班');
    if (mode === PUNCH_MODES_.TRIP) Object.assign(rec, tripFields_(input));
    return withScriptLock_(() => {
      const repo = repo_('attendance');
      const exist = repo.findWhere(r => r.account === ctx.account && r.work_date === n.date && r.punch === input.punch)[0];
      let saved;
      if (exist && input.punch === PUNCH.IN) throw new AppError(ERROR_CODES.VALIDATION, '今天已在 ' + exist.punch_time.slice(0, 5) + ' 打過上班卡');
      if (exist) {
        audit_(ctx, 'attendance.overwrite', 'attendance', exist.id, { old: exist.punch_time, oldMode: exist.mode });
        saved = repo.updateMany({ [exist.id]: rec }, ctx.account)[0];
      } else {
        saved = repo.insert(rec, ctx.account);
      }
      const day = recalcDay_(ctx.account, n.date, ctx.account);
      const flags = input.punch === PUNCH.IN ? day.inFlags : day.outFlags;
      return { record: saved, flags: flags.map(f => FLAG_LABELS[f]), dueOut: day.dueOut, overMin: day.overMin };
    });
  },

  applyLeave(input, ctx) {
    if (LEAVE_TYPES.indexOf(input.leave_type) === -1) throw new AppError(ERROR_CODES.VALIDATION, '請選擇假別');
    if (!HM_RE_.test(String(input.start_time)) || !HM_RE_.test(String(input.end_time))) throw new AppError(ERROR_CODES.VALIDATION, '請填寫正確的時間');
    if (toMin_(input.start_time) % 30 || toMin_(input.end_time) % 30) throw new AppError(ERROR_CODES.VALIDATION, '請假時間以 30 分鐘為單位（例如 09:00、13:30）');
    const from = input.start_date + ' ' + input.start_time;
    const to = input.end_date + ' ' + input.end_time;
    if (to <= from) throw new AppError(ERROR_CODES.VALIDATION, '結束時間須晚於開始時間');
    if (daysBetween_(input.start_date, input.end_date) >= MAX_LEAVE_DAYS_) throw new AppError(ERROR_CODES.VALIDATION, '單次請假最多 ' + MAX_LEAVE_DAYS_ + ' 天，請分開申請');
    if (!input.reason) throw new AppError(ERROR_CODES.VALIDATION, '請填寫請假事由');
    const hours = leaveHours_(input.start_date, input.start_time, input.end_date, input.end_time, workSettings_(), holidayMap_());
    if (!(hours > 0)) throw new AppError(ERROR_CODES.VALIDATION, '請假時段沒有涵蓋任何上班時間（假日或下班時間不必請假）');
    return withScriptLock_(() => {
      const dup = repo_('leaves').findWhere(l => l.account === ctx.account && isActiveLeave_(l) &&
        l.start_date + ' ' + l.start_time < to && from < l.end_date + ' ' + l.end_time)[0];
      if (dup) throw new AppError(ERROR_CODES.VALIDATION, '與已申請的' + dup.leave_type + '時段重疊（' + dup.start_date + ' ' + dup.start_time + '～' + dup.end_date + ' ' + dup.end_time + '）');
      if (input.leave_type === COMP_LEAVE_) {
        const bal = compBalance_(ctx.account);
        if (hours > bal) throw new AppError(ERROR_CODES.VALIDATION, '補休時數不足：本次需 ' + hours + ' 小時，目前可用 ' + bal + ' 小時');
      }
      return repo_('leaves').insert(Object.assign({}, input, { account: ctx.account, hours, status: REVIEW_STATUS.PENDING,
        approver_account: managerOf_(ctx.account) }), ctx.account);
    });
  },

  /** 只能取消自己還在待審的假單；已核准的要請主管處理，避免假單在主管不知情下消失。 */
  cancelLeave(id, expected, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('leaves');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      if (snapshot.record.account !== ctx.account) throw new AppError(ERROR_CODES.FORBIDDEN, '只能取消自己的假單');
      if (snapshot.record.status !== REVIEW_STATUS.PENDING) throw new AppError(ERROR_CODES.VALIDATION, '只能取消待審中的假單，已核准的請洽主管');
      return repo.writeSnapshot(snapshot, { status: REVIEW_STATUS.CANCELLED }, ctx.account);
    });
  },

  applyOvertime(input, ctx) {
    if (!HM_RE_.test(String(input.plan_start)) || !HM_RE_.test(String(input.plan_end))) throw new AppError(ERROR_CODES.VALIDATION, '請填寫正確的時間');
    if (toMin_(input.plan_end) <= toMin_(input.plan_start)) throw new AppError(ERROR_CODES.VALIDATION, '結束時間須晚於開始時間（不支援跨日）');
    if (!input.reason) throw new AppError(ERROR_CODES.VALIDATION, '請填寫加班事由');
    const n = nowParts_();
    // 事前申請：加班開始前才能送，事後補申請等於讓延時自動變成加班。
    if (!(n.date + ' ' + n.time < input.work_date + ' ' + input.plan_start + ':00')) throw new AppError(ERROR_CODES.VALIDATION, '加班須事前申請');
    return withScriptLock_(() => {
      const dup = repo_('overtime').findWhere(o => o.account === ctx.account && o.work_date === input.work_date &&
        o.status !== REVIEW_STATUS.REJECTED && o.status !== REVIEW_STATUS.CANCELLED &&
        toMin_(o.plan_start) < toMin_(input.plan_end) && toMin_(input.plan_start) < toMin_(o.plan_end))[0];
      if (dup) throw new AppError(ERROR_CODES.VALIDATION, '該時段已有加班申請（' + dup.plan_start + '–' + dup.plan_end + '，' + dup.status + '）');
      return repo_('overtime').insert(Object.assign({}, input, { account: ctx.account, status: REVIEW_STATUS.PENDING,
        approver_account: managerOf_(ctx.account) }), ctx.account);
    });
  },

  applyCorrection(input, ctx) {
    if (input.punch !== PUNCH.IN && input.punch !== PUNCH.OUT) throw new AppError(ERROR_CODES.VALIDATION, '請選擇補上班卡或下班卡');
    if (!HM_RE_.test(String(input.request_time))) throw new AppError(ERROR_CODES.VALIDATION, '請填寫正確的時間');
    if (!input.reason) throw new AppError(ERROR_CODES.VALIDATION, '請填寫補卡原因');
    const n = nowParts_();
    if (input.work_date + ' ' + input.request_time + ':00' > n.date + ' ' + n.time) throw new AppError(ERROR_CODES.VALIDATION, '補卡時間不可晚於現在');
    return withScriptLock_(() => {
      if (repo_('attendance').findWhere(r => r.account === ctx.account && r.work_date === input.work_date && r.punch === input.punch).length) {
        throw new AppError(ERROR_CODES.VALIDATION, '該日已有打卡紀錄，無須補卡');
      }
      if (repo_('corrections').findWhere(c => c.account === ctx.account && c.work_date === input.work_date &&
        c.punch === input.punch && c.status === REVIEW_STATUS.PENDING).length) {
        throw new AppError(ERROR_CODES.VALIDATION, '該日已有待審的補卡申請');
      }
      return repo_('corrections').insert(Object.assign({}, input, { account: ctx.account, status: REVIEW_STATUS.PENDING,
        approver_account: managerOf_(ctx.account) }), ctx.account);
    });
  },

  /**
   * 審核假單、加班、補卡：申請人的直屬主管或 admin；核定理由至少 5 個字，事後才查得到為什麼准或不准。
   * kind：leave / overtime / correction
   */
  review(kind, id, expected, approve, note, ctx) {
    const table = { leave: 'leaves', overtime: 'overtime', correction: 'corrections' }[kind];
    if (!table) throw new AppError(ERROR_CODES.VALIDATION, '未知的審核類型');
    if (String(note || '').trim().length < MIN_REASON_LEN_) throw new AppError(ERROR_CODES.VALIDATION, '請填寫核定理由（至少 ' + MIN_REASON_LEN_ + ' 字）');
    return withScriptLock_(() => {
      const repo = repo_(table);
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      const r = snapshot.record;
      if (r.status !== REVIEW_STATUS.PENDING) throw new AppError(ERROR_CODES.VALIDATION, '這筆申請已處理（' + r.status + '）');
      assertCanReview_(ctx, r.account);
      if (approve && kind === 'correction') {
        if (repo_('attendance').findWhere(a => a.account === r.account && a.work_date === r.work_date && a.punch === r.punch).length) {
          throw new AppError(ERROR_CODES.VALIDATION, '該日已有打卡紀錄，請駁回這筆補卡');
        }
        repo_('attendance').insert({ account: r.account, work_date: r.work_date, punch: r.punch, punch_time: r.request_time + ':00',
          mode: PUNCH_MODES_.FIX, reason: '補卡：' + r.reason, status: '補卡', reviewer_account: ctx.account, review_note: note,
          reviewed_at: nowIso_() }, ctx.account);
      }
      const saved = repo.writeSnapshot(snapshot, { status: approve ? REVIEW_STATUS.APPROVED : REVIEW_STATUS.REJECTED,
        approver_account: ctx.account, review_note: note, reviewed_at: nowIso_() }, ctx.account);
      // 核准假單、加班、補卡都會改變那幾天的遲到早退與加班時數，回頭重算。
      if (approve) {
        const dates = kind === 'leave' ? datesBetween_(r.start_date, r.end_date) : [r.work_date];
        dates.forEach(d => recalcDay_(r.account, d, ctx.account));
      }
      audit_(ctx, kind + (approve ? '.approve' : '.reject'), table, id, { account: r.account });
      return saved;
    });
  },

  /** 出差打卡確認：主管批次確認或退回。 */
  reviewTrips(ids, approve, note, ctx) {
    if (!approve && String(note || '').trim().length < MIN_REASON_LEN_) throw new AppError(ERROR_CODES.VALIDATION, '退回須填寫理由（至少 ' + MIN_REASON_LEN_ + ' 字）');
    return withScriptLock_(() => {
      const rows = repo_('attendance').findWhere(r => ids.indexOf(r.id) !== -1 && r.mode === PUNCH_MODES_.TRIP && r.status === '待主管確認');
      rows.forEach(r => assertCanReview_(ctx, r.account));
      const patches = {};
      rows.forEach(r => { patches[r.id] = { status: approve ? '已確認' : '退回', reviewer_account: ctx.account, review_note: note || null, reviewed_at: nowIso_() }; });
      if (!rows.length) throw new AppError(ERROR_CODES.VALIDATION, '紀錄已被處理或不存在');
      return repo_('attendance').updateMany(patches, ctx.account).length;
    });
  },

  /** 我的紀錄：某月的打卡、假單、加班、補卡，加上補休餘額。 */
  mine(month, ctx) {
    const inMonth = d => String(d || '').slice(0, 7) === month;
    return {
      attendance: sortBy_(repo_('attendance').findWhere(r => r.account === ctx.account && inMonth(r.work_date)), 'work_date'),
      leaves: repo_('leaves').findWhere(l => l.account === ctx.account && (inMonth(l.start_date) || inMonth(l.end_date))),
      overtime: repo_('overtime').findWhere(o => o.account === ctx.account && inMonth(o.work_date)),
      corrections: repo_('corrections').findWhere(c => c.account === ctx.account && inMonth(c.work_date)),
      compBalance: compBalance_(ctx.account),
      today: nowParts_().date,
    };
  },

  /** 待我審核：我是直屬主管的人送來的申請，以及待確認的出差打卡。admin 看全部。 */
  pending(ctx) {
    const mine = account => ctx.role === ROLES.ADMIN || managerOf_(account) === ctx.account;
    const pend = table => repo_(table).findWhere(r => r.status === REVIEW_STATUS.PENDING && r.account !== ctx.account && mine(r.account));
    return {
      leaves: pend('leaves'),
      overtime: pend('overtime'),
      corrections: pend('corrections'),
      trips: repo_('attendance').findWhere(r => r.mode === PUNCH_MODES_.TRIP && r.status === '待主管確認' && r.account !== ctx.account && mine(r.account)),
    };
  },

  /** 月報：每人出勤天數、遲到、早退、未申請延時、請假與加班時數。主管看自己的部屬，admin 與會計看全部。 */
  monthly(month, ctx) {
    const people = repo_('people').findAll().filter(p => p.kind !== '派遣' && p.active !== false &&
      (hasRole_(ctx, [ROLES.ADMIN, ROLES.ACCOUNTANT]) || p.manager_account === ctx.account || p.account === ctx.account));
    const inMonth = d => String(d || '').slice(0, 7) === month;
    const att = repo_('attendance').findWhere(r => inMonth(r.work_date));
    const leaves = repo_('leaves').findWhere(l => l.status === REVIEW_STATUS.APPROVED && inMonth(l.start_date));
    const ots = repo_('overtime').findWhere(o => o.status === REVIEW_STATUS.APPROVED && inMonth(o.work_date));
    return people.map(p => {
      const mineAtt = att.filter(r => r.account === p.account);
      const flags = mineAtt.map(r => String(r.flag || '')).join(',');
      return {
        account: p.account, name: p.name, dept: p.dept,
        days: mineAtt.filter(r => r.punch === PUNCH.IN).length,
        late: (flags.match(/LATE/g) || []).length,
        early: (flags.match(/EARLY/g) || []).length,
        unapprovedOt: (flags.match(/UNAPPROVED_OT/g) || []).length,
        leaveHours: sum_(leaves.filter(l => l.account === p.account), 'hours'),
        overtimeHours: sum_(ots.filter(o => o.account === p.account), 'actual_hours'),
      };
    });
  },
};

function tripFields_(input) {
  if (!input.location) throw new AppError(ERROR_CODES.VALIDATION, '出差打卡須填寫地點');
  if (TRIP_REASONS.indexOf(input.reason) === -1) throw new AppError(ERROR_CODES.VALIDATION, '請選擇出差事由');
  let reason = input.reason;
  if (reason === '其他') {
    if (!input.reason_note) throw new AppError(ERROR_CODES.VALIDATION, '事由選「其他」時請填寫說明');
    reason = '其他：' + input.reason_note;
  }
  const lat = Number(input.lat), lng = Number(input.lng);
  const hasGeo = input.lat !== null && input.lat !== undefined && isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0);
  return {
    location: hasGeo ? input.location : input.location + '（未提供定位）',
    reason, lat: hasGeo ? lat : null, lng: hasGeo ? lng : null, status: '待主管確認',
  };
}

function judgeMode_(deviceKey, ip) {
  const ips = String(setting_('office_ips') || '').split(',').map(x => x.trim()).filter(Boolean);
  const ipOk = !!ip && ips.indexOf(ip) !== -1;
  const deviceOk = !!deviceKey && repo_('devices').findAll().some(d => d.device_key === deviceKey && d.active !== false);
  return ipOk && deviceOk ? PUNCH_MODES_.OFFICE : PUNCH_MODES_.TRIP;
}

function managerOf_(account) {
  const p = PeopleService.byAccount(account);
  return (p && p.manager_account) || null;
}

function assertCanReview_(ctx, account) {
  if (account === ctx.account) throw new AppError(ERROR_CODES.FORBIDDEN, '不能審核自己的申請');
  if (!isManagerOf_(ctx, account)) throw new AppError(ERROR_CODES.FORBIDDEN, '只有直屬主管可以審核');
}

function isActiveLeave_(l) {
  return l.status === REVIEW_STATUS.PENDING || l.status === REVIEW_STATUS.APPROVED;
}

/** 補休可用時數：核准加班的實際時數 − 待審與已核准的補休（待審先扣，避免同時送出多張超額假單）。 */
function compBalance_(account) {
  const earned = sum_(repo_('overtime').findWhere(o => o.account === account && o.status === REVIEW_STATUS.APPROVED), 'actual_hours');
  const used = sum_(repo_('leaves').findWhere(l => l.account === account && l.leave_type === COMP_LEAVE_ && isActiveLeave_(l)), 'hours');
  return Math.round((earned - used) * 2) / 2;
}

function workSettings_() {
  const keys = ['work_start', 'work_end', 'lunch_start', 'lunch_end', 'flex_min', 'ot_threshold_min', 'ot_unit_hours'];
  const s = {};
  keys.forEach(k => { s[k] = setting_(k); });
  return s;
}

function holidayMap_() {
  const m = {};
  repo_('holidays').findAll().forEach(h => { m[h.holiday_date] = h; });
  return m;
}

/** 依當天實際紀錄重算旗標、超時分鐘與加班時數並寫回。呼叫端持有 lock。 */
function recalcDay_(account, date, actor) {
  const att = repo_('attendance').findWhere(r => r.account === account && r.work_date === date);
  const inR = att.find(r => r.punch === PUNCH.IN);
  const outR = att.find(r => r.punch === PUNCH.OUT);
  const ots = repo_('overtime').findWhere(o => o.account === account && o.work_date === date && o.status === REVIEW_STATUS.APPROVED);
  const leaves = repo_('leaves').findWhere(l => l.account === account && l.status === REVIEW_STATUS.APPROVED)
    .map(l => leaveSpanOn_(l, date)).filter(Boolean);
  const res = evalDay_({ date, inTime: inR && inR.punch_time, outTime: outR && outR.punch_time, ots, s: workSettings_(), hol: holidayMap_(), leaves });
  const attPatch = {};
  if (inR && String(inR.flag || '') !== res.inFlags.join(',')) attPatch[inR.id] = { flag: res.inFlags.join(',') || null };
  if (outR) attPatch[outR.id] = { flag: res.outFlags.join(',') || null, over_min: res.overMin };
  repo_('attendance').updateMany(attPatch, actor);
  const otPatch = {};
  ots.forEach(o => { if (Number(o.actual_hours || 0) !== (res.otHours[o.id] || 0)) otPatch[o.id] = { actual_hours: res.otHours[o.id] || 0 }; });
  if (outR) repo_('overtime').updateMany(otPatch, actor);
  return res;
}

/**
 * 單日出勤判定（純函式，沿用舊出勤系統）。
 * a = { date, inTime, outTime, ots:[{id, plan_start, plan_end}]（已核准）, s:設定, hol:假日表, leaves:[{from,to}]（分鐘） }
 */
function evalDay_(a) {
  const s = a.s;
  const wd = isWorkday_(a.date, a.hol);
  const start = toMin_(s.work_start), end = toMin_(s.work_end);
  const flex = Number(s.flex_min) || 0;
  const ls = toMin_(s.lunch_start), le = toMin_(s.lunch_end);
  const thr = Number(s.ot_threshold_min) || 0;
  const unit = Number(s.ot_unit_hours) || 0.5;
  const inM = a.inTime ? toMin_(a.inTime) : null;
  const outM = a.outTime ? toMin_(a.outTime) : null;
  const shift = inM == null ? 0 : Math.min(Math.max(inM - start, 0), flex);
  const dueOut = end + shift;
  const r = { inFlags: [], outFlags: [], overMin: 0, dueOut: minToHM_(dueOut), otHours: {}, workday: wd };
  const ots = a.ots || [];
  ots.forEach(o => { r.otHours[o.id] = 0; });
  // 請假蓋住上班開始（例如上午請假）：應到時間改為假單結束；結束落在午休就從午休結束起算。
  let lateFrom = start;
  let earlyBefore = dueOut;
  (a.leaves || []).forEach(l => {
    if (l.from <= start + flex && l.to > lateFrom) lateFrom = (l.to >= ls && l.to <= le) ? le : l.to;
    if (l.to >= end && l.from < earlyBefore) earlyBefore = (l.from >= ls && l.from <= le) ? ls : l.from;
  });
  if (wd && inM != null && inM > lateFrom + flex) r.inFlags.push('LATE');
  if (outM == null) return r;
  if (wd) {
    if (outM < earlyBefore) r.outFlags.push('EARLY');
    r.overMin = Math.max(0, Math.floor(outM - dueOut));
  } else if (inM != null) {
    r.overMin = Math.max(0, Math.floor(outM - inM - overlap_(inM, outM, ls, le)));
  }
  const triggered = wd ? r.overMin > thr : r.overMin > 0;
  if (!triggered) return r;
  if (!ots.length) {
    r.outFlags.push('UNAPPROVED_OT');
    return r;
  }
  ots.forEach(o => {
    let from = toMin_(o.plan_start);
    const to = Math.min(toMin_(o.plan_end), outM);
    if (inM != null) from = Math.max(from, inM);
    if (wd) from = Math.max(from, dueOut);
    const mins = to > from ? (to - from) - overlap_(from, to, ls, le) : 0;
    r.otHours[o.id] = Math.floor(mins / 60 / unit + 1e-9) * unit;
  });
  return r;
}

/** 請假時數（純函式）：逐日取「請假時段 ∩ 上班時段」扣午休，只計工作日；全天固定 8 小時，同仁好預估。 */
function leaveHours_(sd, st, ed, et, s, hol) {
  let mins = 0;
  datesBetween_(sd, ed).forEach(d => {
    if (!isWorkday_(d, hol)) return;
    mins += workMinutesIn_(d === sd ? toMin_(st) : 0, d === ed ? toMin_(et) : 24 * 60, s);
  });
  return mins / 60;
}

function workMinutesIn_(from, to, s) {
  const a = Math.max(from, toMin_(s.work_start));
  const b = Math.min(to, toMin_(s.work_end));
  return b > a ? (b - a) - overlap_(a, b, toMin_(s.lunch_start), toMin_(s.lunch_end)) : 0;
}

function leaveSpanOn_(l, date) {
  if (date < l.start_date || date > l.end_date) return null;
  return { from: date === l.start_date ? toMin_(l.start_time) : 0, to: date === l.end_date ? toMin_(l.end_time) : 24 * 60 };
}

function toMin_(t) {
  const a = String(t).split(':').map(Number);
  return a[0] * 60 + (a[1] || 0) + (a[2] || 0) / 60;
}

function minToHM_(m) {
  const t = Math.round(m);
  return ('0' + Math.floor(t / 60)).slice(-2) + ':' + ('0' + (t % 60)).slice(-2);
}

function overlap_(a1, a2, b1, b2) {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

function datesBetween_(a, b) {
  const out = [];
  let d = a;
  for (let i = 0; i <= MAX_LEAVE_DAYS_ && d <= b; i++) {
    out.push(d);
    d = addDays_(d, 1);
  }
  return out;
}

function isWorkday_(date, hol) {
  const h = hol && hol[date];
  if (h) return h.kind === 'WORKDAY';
  const p = date.split('-').map(Number);
  const w = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  return w >= 1 && w <= 5;
}

function attendanceRoutes_() {
  const idArgs = p => [requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt')];
  return {
    'attendance.options': { roles: ALL_ROLES_, handler: () => ({ tripReasons: TRIP_REASONS, leaveTypes: LEAVE_TYPES, flags: FLAG_LABELS }) },
    'attendance.punch': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      AttendanceService.punch(pickAllowed_(p, ['punch', 'ip', 'device_key', 'location', 'reason', 'reason_note', 'lat', 'lng'], '打卡'), ctx) },
    'attendance.mine': { roles: ALL_ROLES_, handler: (p, ctx) => AttendanceService.mine(requireString_(p, 'month'), ctx) },
    'attendance.applyLeave': { roles: ALL_ROLES_, handler: (p, ctx) =>
      AttendanceService.applyLeave(pickAllowed_(p.record || {}, ['leave_type', 'start_date', 'start_time', 'end_date', 'end_time', 'reason'], '假單'), ctx) },
    'attendance.cancelLeave': { roles: ALL_ROLES_, handler: (p, ctx) => AttendanceService.cancelLeave(...idArgs(p), ctx) },
    'attendance.applyOvertime': { roles: ALL_ROLES_, handler: (p, ctx) =>
      AttendanceService.applyOvertime(pickAllowed_(p.record || {}, ['work_date', 'plan_start', 'plan_end', 'reason', 'project_id'], '加班單'), ctx) },
    'attendance.applyCorrection': { roles: ALL_ROLES_, handler: (p, ctx) =>
      AttendanceService.applyCorrection(pickAllowed_(p.record || {}, ['work_date', 'punch', 'request_time', 'reason'], '補卡'), ctx) },
    'attendance.pending': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => AttendanceService.pending(ctx) },
    'attendance.review': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) =>
      AttendanceService.review(requireString_(p, 'kind'), ...idArgs(p), p.approve === true, p.note, ctx) },
    'attendance.reviewTrips': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) =>
      AttendanceService.reviewTrips(requireArray_(p, 'ids'), p.approve === true, p.note, ctx) },
    'attendance.monthly': { roles: [ROLES.ADMIN, ROLES.MANAGER, ROLES.ACCOUNTANT], handler: (p, ctx) =>
      AttendanceService.monthly(requireString_(p, 'month'), ctx) },
  };
}
