/**
 * 派遣：排班（派到哪個專案、哪幾天）、派遣人員現場打卡、工作回報、問題回報，
 * 以及派遣工時 × 時薪計入專案人力成本。
 *
 * 派遣人員只看得到自己的排班、打卡、回報；看不到客戶、預算、其他人的時薪。
 */

const ASSIGNMENT_STATUS = { ACTIVE: '派遣中', CANCELLED: '已取消' };
const ISSUE_STATUS = { OPEN: '待處理', DONE: '已處理' };
const ASSIGNMENT_FIELDS_ = ['account', 'project_id', 'start_date', 'end_date', 'role', 'hourly_wage', 'note'];

const DispatchService = {
  /** 排班：同一人同一段時間只能在一個專案，檢查與寫入在同一把 lock 內。 */
  assign(input, ctx) {
    assertDateRange_(input.start_date, input.end_date);
    return withScriptLock_(() => {
      const person = PeopleService.byAccount(input.account);
      if (!person || person.kind !== '派遣') throw new AppError(ERROR_CODES.VALIDATION, '只能排派遣人員');
      if (!repo_('projects').findById(input.project_id)) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
      const clash = repo_('dispatch_assignments').findWhere(a => a.account === input.account && a.status === ASSIGNMENT_STATUS.ACTIVE &&
        a.start_date <= input.end_date && input.start_date <= a.end_date)[0];
      if (clash) throw new AppError(ERROR_CODES.SCHEDULE_CONFLICT, person.name + ' 在 ' + clash.start_date + '～' + clash.end_date + ' 已經排了其他專案');
      return repo_('dispatch_assignments').insert(Object.assign({}, input, {
        status: ASSIGNMENT_STATUS.ACTIVE,
      }), ctx.account);
    });
  },

  cancel(id, expected, ctx) {
    return withScriptLock_(() => {
      const saved = updateRecord_('dispatch_assignments', id, expected, { status: ASSIGNMENT_STATUS.CANCELLED }, ctx.account);
      BudgetService.recalc(saved.project_id, ctx.account);
      return saved;
    });
  },

  /** 排班總表（內部同仁）：附上人名與專案名，時薪只給財務角色。 */
  list(ctx) {
    const people = indexBy_(repo_('people').findAll(), 'account');
    const projects = indexBy_(repo_('projects').findAll(), 'id');
    const finance = canSeeFinance_(ctx);
    return sortBy_(repo_('dispatch_assignments').findAll(), 'start_date').reverse().map(a => {
      const out = Object.assign({}, a, {
        name: people[a.account] ? people[a.account].name : a.account,
        project_name: projects[a.project_id] ? projects[a.project_id].name : '',
      });
      if (!finance) delete out.hourly_wage;
      return out;
    });
  },

  /** 派遣人員自己的頁面：我的排班（只給專案名、地點、日期）、今天的打卡、最近的回報與問題。 */
  mine(ctx) {
    const today = nowParts_().date;
    const projects = indexBy_(repo_('projects').findAll(), 'id');
    const assignments = repo_('dispatch_assignments').findWhere(a => a.account === ctx.account && a.status === ASSIGNMENT_STATUS.ACTIVE)
      .map(a => ({
        id: a.id, project_id: a.project_id, start_date: a.start_date, end_date: a.end_date, role: a.role, hourly_wage: a.hourly_wage,
        project_name: projects[a.project_id] ? projects[a.project_id].name : '',
        venue: projects[a.project_id] ? projects[a.project_id].venue : '',
      }));
    return {
      today,
      assignments: sortBy_(assignments, 'start_date'),
      todayAssignment: assignments.find(a => a.start_date <= today && today <= a.end_date) || null,
      punches: repo_('attendance').findWhere(r => r.account === ctx.account && r.work_date === today),
      reports: sortBy_(repo_('dispatch_reports').findWhere(r => r.account === ctx.account), 'report_date').reverse().slice(0, 30),
      issues: repo_('dispatch_issues').findWhere(r => r.account === ctx.account),
    };
  },

  /** 派遣人員現場打卡：當天一定要有排班，打卡記在那個專案上，下班卡後重算專案人力成本。 */
  punch(input, ctx) {
    if (input.punch !== PUNCH.IN && input.punch !== PUNCH.OUT) throw new AppError(ERROR_CODES.VALIDATION, '請選擇上班或下班');
    const n = nowParts_();
    return withScriptLock_(() => {
      const a = repo_('dispatch_assignments').findWhere(x => x.account === ctx.account && x.status === ASSIGNMENT_STATUS.ACTIVE &&
        x.start_date <= n.date && n.date <= x.end_date)[0];
      if (!a) throw new AppError(ERROR_CODES.VALIDATION, '今天沒有你的派遣排班，請聯絡負責的同仁');
      const repo = repo_('attendance');
      const exist = repo.findWhere(r => r.account === ctx.account && r.work_date === n.date && r.punch === input.punch)[0];
      if (exist && input.punch === PUNCH.IN) throw new AppError(ERROR_CODES.VALIDATION, '今天已在 ' + exist.punch_time.slice(0, 5) + ' 打過上班卡');
      const rec = {
        account: ctx.account, work_date: n.date, punch: input.punch, punch_time: n.time, mode: PUNCH_MODES_.SITE,
        project_id: a.project_id, location: input.location || null, lat: input.lat || null, lng: input.lng || null, status: '正常',
      };
      const saved = exist ? repo.updateMany({ [exist.id]: rec }, ctx.account)[0] : repo.insert(rec, ctx.account);
      if (input.punch === PUNCH.OUT) BudgetService.recalc(a.project_id, ctx.account);
      return saved;
    });
  },

  /**
   * 專案人力成本：每位派遣人員每天「上班卡到下班卡」的時數（扣午休、以 0.5 小時捨去）× 排班時薪。
   * 只算有上下班兩張卡的日子：漏打卡的天數要補卡後才計入，避免用猜的時數付錢。
   */
  laborCost(projectId) {
    const att = repo_('attendance').findWhere(r => r.project_id === projectId && r.mode === PUNCH_MODES_.SITE);
    const assignments = repo_('dispatch_assignments').findWhere(a => a.project_id === projectId && a.status === ASSIGNMENT_STATUS.ACTIVE);
    if (!att.length) return { hours: 0, cost: 0, byPerson: [] };
    const s = workSettings_();
    const days = {};
    att.forEach(r => {
      const k = r.account + '|' + r.work_date;
      (days[k] = days[k] || {})[r.punch] = r.punch_time;
    });
    const byPerson = {};
    Object.keys(days).forEach(k => {
      const [account, date] = k.split('|');
      const d = days[k];
      if (!d.IN || !d.OUT) return;
      const from = toMin_(d.IN), to = toMin_(d.OUT);
      const mins = to > from ? (to - from) - overlap_(from, to, toMin_(s.lunch_start), toMin_(s.lunch_end)) : 0;
      const hours = Math.floor(mins / 30) / 2;
      const a = assignments.find(x => x.account === account && x.start_date <= date && date <= x.end_date);
      const wage = a ? Number(a.hourly_wage) || 0 : 0;
      const p = byPerson[account] || (byPerson[account] = { account, hours: 0, cost: 0 });
      p.hours += hours;
      p.cost += hours * wage;
    });
    const list = Object.keys(byPerson).map(k => byPerson[k]);
    return { hours: sum_(list, 'hours'), cost: Math.round(sum_(list, 'cost')), byPerson: list };
  },

  report(input, ctx) {
    if (!input.content) throw new AppError(ERROR_CODES.VALIDATION, '請填寫工作內容');
    return createRecord_('dispatch_reports', Object.assign({ report_date: nowParts_().date }, input, { account: ctx.account }), ctx.account);
  },

  raiseIssue(input, ctx) {
    return createRecord_('dispatch_issues', Object.assign({}, input, { account: ctx.account, status: ISSUE_STATUS.OPEN }), ctx.account);
  },

  replyIssue(id, expected, reply, ctx) {
    if (!reply) throw new AppError(ERROR_CODES.VALIDATION, '請填寫回覆');
    return updateRecord_('dispatch_issues', id, expected, { reply, status: ISSUE_STATUS.DONE }, ctx.account);
  },
};

function dispatchRoutes_() {
  const idArgs = p => [requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt')];
  const dispatchOnly = [ROLES.DISPATCH];
  return {
    'dispatch.list': { roles: INTERNAL_ROLES_, handler: (p, ctx) => DispatchService.list(ctx) },
    'dispatch.assign': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      DispatchService.assign(pickAllowed_(p.record || {}, ASSIGNMENT_FIELDS_, '排班'), ctx) },
    'dispatch.cancel': { roles: INTERNAL_ROLES_, handler: (p, ctx) => DispatchService.cancel(...idArgs(p), ctx) },
    'dispatch.reports': { roles: INTERNAL_ROLES_, handler: () => sortBy_(repo_('dispatch_reports').findAll(), 'report_date').reverse() },
    'dispatch.issues': { roles: INTERNAL_ROLES_, handler: () => repo_('dispatch_issues').findAll() },
    'dispatch.replyIssue': { roles: INTERNAL_ROLES_, handler: (p, ctx) => DispatchService.replyIssue(...idArgs(p), p.reply, ctx) },
    'dispatch.laborCost': { roles: FINANCE_ROLES_, handler: p => DispatchService.laborCost(requireString_(p, 'project_id')) },
    // 以下是派遣人員自己用的
    'dispatch.mine': { roles: dispatchOnly, handler: (p, ctx) => DispatchService.mine(ctx) },
    'dispatch.punch': { roles: dispatchOnly, handler: (p, ctx) =>
      DispatchService.punch(pickAllowed_(p, ['punch', 'location', 'lat', 'lng'], '打卡'), ctx) },
    'dispatch.report': { roles: dispatchOnly, handler: (p, ctx) =>
      DispatchService.report(pickAllowed_(p.record || {}, ['project_id', 'report_date', 'content', 'hours'], '工作回報'), ctx) },
    'dispatch.raiseIssue': { roles: dispatchOnly, handler: (p, ctx) =>
      DispatchService.raiseIssue(pickAllowed_(p.record || {}, ['project_id', 'title', 'detail'], '問題回報'), ctx) },
  };
}
