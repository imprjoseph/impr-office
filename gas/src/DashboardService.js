/**
 * 首頁工作台：登入後第一眼看到「今天要處理什麼」。
 * 一次回傳全部區塊，前端不必呼叫多次；每張表只讀一次。財務區塊只給財務角色。
 */

const DashboardService = {
  forMe(ctx) {
    if (ctx.role === ROLES.DISPATCH) return { dispatch: DispatchService.mine(ctx) };
    const today = todayIso_();
    const weekEnd = addDays_(today, 7);
    const projects = ProjectService.list(ctx);
    const open = projects.filter(p => p.light);
    const isApprover = hasRole_(ctx, [ROLES.ADMIN, ROLES.MANAGER]);
    const out = {
      today,
      myTasks: TaskService.mine(ctx).slice(0, 30),
      myProjects: open.filter(p => p.pm_account === ctx.account),
      thisWeek: open.filter(p => p.start_date && p.start_date <= weekEnd && (p.end_date || p.start_date) >= today),
      lights: { red: open.filter(p => p.light === '紅燈').length, yellow: open.filter(p => p.light === '黃燈').length, green: open.filter(p => p.light === '綠燈').length },
      tenders: TenderService.dueFor(ctx.account, today),
      myExpenses: ExpenseService.list('mine', ctx).filter(e => e.status !== EXPENSE_STATUS.PAID).slice(0, 10),
      myLoans: InventoryService.loans().filter(l => l.borrower_account === ctx.account && l.status === LOAN_STATUS.OUT),
      approvals: null,
      finance: null,
    };
    if (isApprover) {
      const att = AttendanceService.pending(ctx);
      out.approvals = {
        expenses: ExpenseService.list('approve', ctx).length,
        leaves: att.leaves.length, overtime: att.overtime.length, corrections: att.corrections.length, trips: att.trips.length,
      };
    }
    if (canSeeFinance_(ctx)) {
      out.finance = {
        marginAlerts: open.filter(p => p.margin_alert).map(p => ({ id: p.id, code: p.code, name: p.name, margin_rate: p.margin_rate })),
        toPay: hasRole_(ctx, [ROLES.ADMIN, ROLES.ACCOUNTANT]) ? ExpenseService.list('pay', ctx).length : null,
      };
    }
    return out;
  },
};

const SETTING_FIELDS_ = ['value'];

function dashboardRoutes_() {
  return {
    'dashboard.me': { roles: ALL_ROLES_, handler: (p, ctx) => DashboardService.forMe(ctx) },
  };
}

/** 系統設定：設定值、假日、打卡設備、稽核紀錄。只給 admin。 */
function adminRoutes_() {
  const admin = [ROLES.ADMIN];
  return Object.assign(
    {
      'settings.list': { roles: admin, handler: () => repo_('settings').findAll() },
      'settings.update': { roles: admin, handler: (p, ctx) => {
        const a = updateArgs_(p, SETTING_FIELDS_, '設定');
        return updateRecord_('settings', a.id, a.expected, a.patch, ctx.account);
      } },
      'audit.list': { roles: admin, handler: () => sortBy_(repo_('audit_log').findAll(), 'created_at').reverse().slice(0, 500) },
    },
    crudRoutes_('holiday', 'holidays', { read: ALL_ROLES_, write: admin, fields: ['holiday_date', 'name', 'kind'], label: '假日',
      validate: r => { if (['HOLIDAY', 'WORKDAY'].indexOf(r.kind) === -1) throw new AppError(ERROR_CODES.VALIDATION, '類型只能是 HOLIDAY（放假）或 WORKDAY（補班）'); } }),
    crudRoutes_('device', 'devices', { read: admin, write: admin, fields: ['device_key', 'name', 'registered_by', 'active'], label: '打卡設備' }),
  );
}
