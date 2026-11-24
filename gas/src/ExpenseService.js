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
  'receipt_no', 'receipt_url', 'payee', 'supplier_id', 'payee_name', 'payee_bank'];
// 付款方式：代墊（付給申請人）、付給廠商（選清單或直接填新的）、公司卡支付（不用付款對象）
const EXPENSE_PAYEES_ = ['代墊（付給我）', '付給廠商', '公司卡支付'];
const EXPENSE_CATEGORIES = ['交通', '餐費', '住宿', '印刷輸出', '設備租借', '採購', '郵電', '供應商款項', '講師費', '雜支'];

const ExpenseService = {
  create(data, ctx) {
    return withScriptLock_(() => {
      assertExpense_(data);
      return repo_('expense_claims').insert(Object.assign({ receipt_date: todayIso_() }, data,
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
      if (!e.receipt_date) throw new AppError(ERROR_CODES.VALIDATION, '請填費用日期');
      const vendor = isVendorPayee_(e.payee);
      if (vendor && !e.supplier_id && !e.payee_name) throw new AppError(ERROR_CODES.VALIDATION, '付給廠商請選廠商，或填付款對象名稱');
      // 清單裡沒有的付款對象：同名的對上，沒有就新增一筆供應商，下次可以直接選
      const supplierPatch = vendor && !e.supplier_id && e.payee_name ? { supplier_id: supplierForPayee_(e.payee_name, e.payee_bank, ctx) } : {};
      const me = PeopleService.byAccount(ctx.account);
      return Object.assign({
        status: EXPENSE_STATUS.SUBMITTED,
        submitted_at: nowIso_(),
        approver_account: (me && me.manager_account) || null,
        review_note: null,
      }, supplierPatch);
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

  /**
   * 改這筆費用對沖哪個預算科目：專案 PM 或財務角色可以改，任何狀態都行（已核准的費用常常事後才歸科目）。
   * 只改科目、不動金額與狀態，所以不比對 expectedUpdatedAt；改完重算專案毛利。
   */
  setBudgetLine(id, lineId, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('expense_claims');
      const e = repo.findById(id);
      if (!e) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到這筆請款');
      if (!e.project_id) throw new AppError(ERROR_CODES.VALIDATION, '這筆請款沒有掛專案，不能指定預算科目');
      const project = repo_('projects').findById(e.project_id);
      if (!project || !ProjectService.canSeeFinance(ctx, project)) throw new AppError(ERROR_CODES.FORBIDDEN, '只有專案 PM 或財務角色可以指定預算科目');
      assertExpense_(Object.assign({}, e, { budget_line_id: lineId }));
      const saved = repo.updateMany({ [id]: { budget_line_id: lineId } }, ctx.account)[0];
      BudgetService.recalc(e.project_id, ctx.account);
      audit_(ctx, 'expense.setBudgetLine', 'expense_claims', id, { from: e.budget_line_id || null, to: lineId });
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
    // 附上對沖的預算科目名稱，以及是否超出科目核定金額（看得到該專案財務的人才看得到數字）
    const allLines = repo_('budget_lines').findAll();
    const lines = indexBy_(allLines, 'id');
    const over = overBudgetByExpense_(rows, allLines);
    const projects = indexBy_(repo_('projects').findAll(), 'id');
    return sortBy_(out, 'created_at').reverse().map(e => {
      const extra = {};
      if (e.budget_line_id && lines[e.budget_line_id]) extra.budget_line_label = lines[e.budget_line_id].category + '／' + lines[e.budget_line_id].item;
      if (over[e.id]) extra.over_budget = ProjectService.canSeeFinance(ctx, projects[e.project_id]) ? over[e.id] : { hidden: true, draft: !!over[e.id].draft };
      return Object.keys(extra).length ? Object.assign({}, e, extra) : e;
    });
  },
};

function requireFrom_(e, statuses) {
  if (statuses.indexOf(e.status) === -1) {
    throw new AppError(ERROR_CODES.VALIDATION, '這筆請款目前是「' + (EXPENSE_LABELS_[e.status] || e.status) + '」，不能執行這個操作');
  }
}

function isVendorPayee_(payee) { return payee === '付給廠商' || payee === '付給供應商'; }

function supplierForPayee_(name, bank, ctx) {
  const key = normName_(name);
  const hit = repo_('suppliers').findAll().find(s => normName_(s.name) === key);
  if (hit) return hit.id;
  return repo_('suppliers').insert({ name: String(name).trim(), category: '其他', note: '請款時新增' + (bank ? '；匯款資料：' + bank : '') }, ctx.account).id;
}

function assertExpense_(e) {
  if (!(Number(e.amount) > 0)) throw new AppError(ERROR_CODES.VALIDATION, '金額必須大於 0');
  if (e.payee && EXPENSE_PAYEES_.indexOf(e.payee) === -1 && e.payee !== '付給供應商') throw new AppError(ERROR_CODES.VALIDATION, '付款方式只能是：' + EXPENSE_PAYEES_.join('、'));
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
    'expense.payees': { roles: INTERNAL_ROLES_, handler: () => EXPENSE_PAYEES_ },
    'expense.list': { roles: INTERNAL_ROLES_, handler: (p, ctx) => ExpenseService.list(requireString_(p, 'scope'), ctx) },
    'expense.create': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      ExpenseService.create(pickAllowed_(p.record || {}, EXPENSE_FIELDS_, '請款'), ctx) },
    'expense.update': { roles: INTERNAL_ROLES_, handler: (p, ctx) => {
      const a = updateArgs_(p, EXPENSE_FIELDS_, '請款');
      return ExpenseService.update(a.id, a.expected, a.patch, ctx);
    } },
    'expense.setBudgetLine': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      ExpenseService.setBudgetLine(requireString_(p, 'id'), p.budget_line_id ? String(p.budget_line_id) : null, ctx) },
    'expense.submit': { roles: INTERNAL_ROLES_, handler: (p, ctx) => ExpenseService.submit(...idArgs(p), ctx) },
    'expense.approve': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => ExpenseService.review(...idArgs(p), true, p.note, ctx) },
    'expense.reject': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => ExpenseService.review(...idArgs(p), false, p.note, ctx) },
    'expense.pay': { roles: [ROLES.ACCOUNTANT, ROLES.ADMIN], handler: (p, ctx) => ExpenseService.pay(...idArgs(p), p.note, ctx) },
  };
}
