/**
 * 費用請款與報帳：申請人 → 直屬主管核准 → 會計付款。
 * 直屬主管以人員資料的 manager_account 為準（從帳號中心同步）；沒有主管的人由 admin 核准。
 * 已核准或已付款、而且掛了專案的費用，會計入專案實際成本並重算毛利。
 */

const EXPENSE_STATUS = {
  DRAFT: 'draft', SUBMITTED: 'submitted', APPROVED: 'approved', PAID: 'paid', REJECTED: 'rejected',
};
const EXPENSE_LABELS_ = { draft: '草稿', submitted: '待主管核准', approved: '待付款', paid: '已付款', rejected: '已退回' };
const EXPENSE_FIELDS_ = ['project_id', 'budget_line_id', 'dept', 'category', 'description', 'amount', 'receipt_date',
  'receipt_no', 'receipt_url', 'payee', 'supplier_id'];
const EXPENSE_CATEGORIES = ['交通', '餐費', '住宿', '印刷輸出', '設備租借', '採購', '郵電', '供應商款項', '講師費', '雜支'];

const ExpenseService = {
  create(data, ctx) {
    return withScriptLock_(() => {
      assertExpense_(data);
      return repo_('expense_claims').insert(Object.assign({}, data,
        { claimant_account: ctx.account, dept: data.dept || ctx.dept || null, status: EXPENSE_STATUS.DRAFT }), ctx.account);
    });
  },

  /** 只有申請人能改，而且只能在草稿或退回時改；送出後改金額，主管核准的就不是同一筆了。 */
  update(id, expected, patch, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('expense_claims');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      const e = snapshot.record;
      if (e.claimant_account !== ctx.account) throw new AppError(ERROR_CODES.FORBIDDEN, '只有申請人可以修改');
      if ([EXPENSE_STATUS.DRAFT, EXPENSE_STATUS.REJECTED].indexOf(e.status) === -1) {
        throw new AppError(ERROR_CODES.VALIDATION, '已送出的請款不能修改，請主管退回後再改');
      }
      assertExpense_(Object.assign({}, e, patch));
      return repo.writeSnapshot(snapshot, patch, ctx.account);
    });
  },

  submit(id, expected, ctx) {
    return this.transition_(id, expected, ctx, e => {
      if (e.claimant_account !== ctx.account) throw new AppError(ERROR_CODES.FORBIDDEN, '只有申請人可以送出');
      requireFrom_(e, [EXPENSE_STATUS.DRAFT, EXPENSE_STATUS.REJECTED]);
      const me = PeopleService.byAccount(ctx.account);
      return {
        status: EXPENSE_STATUS.SUBMITTED,
        submitted_at: nowIso_(),
        approver_account: (me && me.manager_account) || null,
        review_note: null,
      };
    });
  },

  /** 核准或退回：申請人的直屬主管或 admin；自己的請款不能自己核。 */
  review(id, expected, approve, note, ctx) {
    return this.transition_(id, expected, ctx, e => {
      requireFrom_(e, [EXPENSE_STATUS.SUBMITTED]);
      if (e.claimant_account === ctx.account) throw new AppError(ERROR_CODES.FORBIDDEN, '不能核准自己的請款');
      const allowed = ctx.role === ROLES.ADMIN || (e.approver_account ? e.approver_account === ctx.account : false);
      if (!allowed) throw new AppError(ERROR_CODES.FORBIDDEN, '只有申請人的直屬主管可以審核');
      if (!approve && !note) throw new AppError(ERROR_CODES.VALIDATION, '退回請寫原因，申請人才知道要改什麼');
      return {
        status: approve ? EXPENSE_STATUS.APPROVED : EXPENSE_STATUS.REJECTED,
        approver_account: ctx.account,
        approved_at: approve ? nowIso_() : null,
        review_note: note || null,
      };
    });
  },

  pay(id, expected, note, ctx) {
    requireRole_(ctx, [ROLES.ACCOUNTANT, ROLES.ADMIN], '付款');
    return this.transition_(id, expected, ctx, e => {
      requireFrom_(e, [EXPENSE_STATUS.APPROVED]);
      return { status: EXPENSE_STATUS.PAID, paid_by: ctx.account, paid_at: nowIso_(), pay_note: note || null };
    });
  },

  transition_(id, expected, ctx, decide) {
    return withScriptLock_(() => {
      const repo = repo_('expense_claims');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      const saved = repo.writeSnapshot(snapshot, decide(snapshot.record), ctx.account);
      // 狀態變動可能讓費用開始或停止計入成本（核准、付款、退回），掛專案的都重算。
      if (saved.project_id) BudgetService.recalc(saved.project_id, ctx.account);
      audit_(ctx, 'expense.' + saved.status, 'expense_claims', saved.id, { amount: saved.amount });
      return saved;
    });
  },

  /** scope：mine 我的、approve 待我核准、pay 待付款（會計）、all 全部（財務角色）。 */
  list(scope, ctx) {
    const rows = repo_('expense_claims').findAll();
    let out;
    if (scope === 'mine') out = rows.filter(e => e.claimant_account === ctx.account);
    else if (scope === 'approve') {
      out = rows.filter(e => e.status === EXPENSE_STATUS.SUBMITTED && e.claimant_account !== ctx.account &&
        (ctx.role === ROLES.ADMIN || e.approver_account === ctx.account));
    } else if (scope === 'pay') {
      requireRole_(ctx, [ROLES.ACCOUNTANT, ROLES.ADMIN], '查看待付款');
      out = rows.filter(e => e.status === EXPENSE_STATUS.APPROVED);
    } else if (scope === 'all') {
      requireRole_(ctx, FINANCE_ROLES_, '查看全部請款');
      out = rows;
    } else throw new AppError(ERROR_CODES.VALIDATION, '未知的範圍：' + scope);
    return sortBy_(out, 'created_at').reverse();
  },
};

function requireFrom_(e, statuses) {
  if (statuses.indexOf(e.status) === -1) {
    throw new AppError(ERROR_CODES.VALIDATION, '這筆請款目前是「' + (EXPENSE_LABELS_[e.status] || e.status) + '」，不能執行這個操作');
  }
}

function assertExpense_(e) {
  if (!(Number(e.amount) > 0)) throw new AppError(ERROR_CODES.VALIDATION, '金額必須大於 0');
  if (e.budget_line_id) {
    const line = repo_('budget_lines').findById(e.budget_line_id);
    if (!line || line.project_id !== e.project_id) throw new AppError(ERROR_CODES.VALIDATION, '預算科目不屬於所選的專案');
  }
  if (e.project_id && !repo_('projects').findById(e.project_id)) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
}

function expenseRoutes_() {
  const idArgs = p => [requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt')];
  return {
    'expense.categories': { roles: INTERNAL_ROLES_, handler: () => EXPENSE_CATEGORIES },
    'expense.list': { roles: INTERNAL_ROLES_, handler: (p, ctx) => ExpenseService.list(requireString_(p, 'scope'), ctx) },
    'expense.create': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      ExpenseService.create(pickAllowed_(p.record || {}, EXPENSE_FIELDS_, '請款'), ctx) },
    'expense.update': { roles: INTERNAL_ROLES_, handler: (p, ctx) => {
      const a = updateArgs_(p, EXPENSE_FIELDS_, '請款');
      return ExpenseService.update(a.id, a.expected, a.patch, ctx);
    } },
    'expense.submit': { roles: INTERNAL_ROLES_, handler: (p, ctx) => ExpenseService.submit(...idArgs(p), ctx) },
    'expense.approve': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => ExpenseService.review(...idArgs(p), true, p.note, ctx) },
    'expense.reject': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => ExpenseService.review(...idArgs(p), false, p.note, ctx) },
    'expense.pay': { roles: [ROLES.ACCOUNTANT, ROLES.ADMIN], handler: (p, ctx) => ExpenseService.pay(...idArgs(p), p.note, ctx) },
  };
}
