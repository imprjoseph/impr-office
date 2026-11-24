/**
 * 專案預算與毛利。活動公司的利潤很少出在報價，多半出在執行中的增減項與超支沒被即時加總，
 * 所以任何預算、增減項、費用、派遣工時的變動都會重算一次專案毛利，低於門檻就標毛利警示。
 *
 * 成本的算法（每次從頭算，不累加，算錯可以重跑修復）：
 * - 每個預算科目的「目前成本」取 max(預估成本, 實際成本)：還沒發生的照預估，已超支的照實際，超支會立刻反映。
 *   科目的實際成本 = 手填的實際成本 + 掛在這個科目、已核准或已付款的費用。
 * - 沒掛科目的已核准費用、派遣人力成本、增減項的成本變動，直接加進目前成本。
 * - 毛利率 =（報價合計 − 目前成本）÷ 報價合計；報價合計含增減項的報價變動。
 */

const BUDGET_LINE_FIELDS_ = ['category', 'item', 'quote_amount', 'cost_estimate', 'cost_actual', 'supplier_id', 'note',
  'spec', 'description', 'unit_price', 'quantity', 'unit', 'discount_price'];
// 報價單核定後還能改的：實際成本（廠商發票）、供應商、備註。其他要主管退回成草稿才能改。
const QUOTE_LOCKED_EDITABLE_ = ['cost_actual', 'supplier_id', 'note'];
const QUOTE_STATUS = { DRAFT: '草稿', SUBMITTED: '送審中', APPROVED: '已核定', RETURNED: '退回修改' };
// 計算「已申請」的請款狀態：送審中、已核准、已付款（草稿、退回不算）
const CLAIMED_EXPENSE_STATUSES_ = ['submitted', 'approved', 'paid'];

function quoteStatusOf_(project) { return (project && project.quote_status) || QUOTE_STATUS.DRAFT; }

/** 報價單送審中或已核定時鎖住：只能改 QUOTE_LOCKED_EDITABLE_ 的欄位。 */
function assertQuoteEditable_(projectId, fields) {
  const project = repo_('projects').findById(projectId);
  const st = quoteStatusOf_(project);
  if (st !== QUOTE_STATUS.SUBMITTED && st !== QUOTE_STATUS.APPROVED) return;
  const bad = fields ? fields.filter(f => QUOTE_LOCKED_EDITABLE_.indexOf(f) === -1) : ['*'];
  if (bad.length) {
    throw new AppError(ERROR_CODES.VALIDATION, st === QUOTE_STATUS.APPROVED
      ? '報價單已經主管核定，不能再改報價與預估成本（只能填實際成本、供應商、備註）；要改請主管退回成草稿'
      : '報價單送審中，不能修改；要改請主管先退回');
  }
}

/**
 * 報價單的一行：總價 = 單價 × 數量；對客戶的金額 quote_amount = 優惠價，沒填優惠價就是總價。
 * 沒填單價的舊資料照原本手填的 quote_amount。
 */
function normalizeQuoteLine_(record, current) {
  const m = Object.assign({}, current || {}, record);
  ['unit_price', 'quantity', 'discount_price', 'cost_estimate', 'cost_actual', 'quote_amount'].forEach(f => {
    if (f in record && record[f] !== null && record[f] !== '' && !(Number(record[f]) >= 0)) {
      throw new AppError(ERROR_CODES.VALIDATION, '金額與數量不能小於 0');
    }
  });
  const has = v => v !== null && v !== undefined && v !== '';
  const touched = ['unit_price', 'quantity', 'discount_price'].some(f => f in record);
  if (!touched) return record;
  const out = Object.assign({}, record);
  if (has(m.unit_price)) {
    const qty = has(m.quantity) ? Number(m.quantity) : 1;
    if (!has(m.quantity)) out.quantity = 1;
    const total = Math.round(Number(m.unit_price) * qty);
    out.quote_amount = has(m.discount_price) ? Number(m.discount_price) : total;
  } else if (has(m.discount_price)) {
    out.quote_amount = Number(m.discount_price);
  }
  return out;
}

/**
 * 請款超出核定：同一個科目的請款依送出先後累加（含手填實際成本），加到哪一筆超過科目的核定金額（預估成本），
 * 那一筆和之後的都標「超出核定」。草稿與退回的以「如果送出」來算，申請人送出前就看得到。
 * 回傳 { expenseId: { approved, claimed, over } }。
 */
function overBudgetByExpense_(expenses, lines) {
  const lineById = indexBy_(lines, 'id');
  const byLine = {};
  expenses.forEach(e => { if (e.budget_line_id && lineById[e.budget_line_id]) (byLine[e.budget_line_id] = byLine[e.budget_line_id] || []).push(e); });
  const out = {};
  Object.keys(byLine).forEach(lineId => {
    const line = lineById[lineId];
    if (line.cost_estimate === null || line.cost_estimate === undefined || line.cost_estimate === '') return;
    const approved = Number(line.cost_estimate) || 0;
    let running = Number(line.cost_actual) || 0;
    const order = e => String(e.submitted_at || '9999') + String(e.created_at || '');
    const claimed = byLine[lineId].filter(e => CLAIMED_EXPENSE_STATUSES_.indexOf(e.status) !== -1).sort((a, b) => order(a).localeCompare(order(b)));
    claimed.forEach(e => {
      running += Number(e.amount) || 0;
      if (running > approved) out[e.id] = { approved, claimed: running, over: running - approved };
    });
    byLine[lineId].filter(e => CLAIMED_EXPENSE_STATUSES_.indexOf(e.status) === -1).forEach(e => {
      const ifSent = running + (Number(e.amount) || 0);
      if (ifSent > approved) out[e.id] = { approved, claimed: ifSent, over: ifSent - approved, draft: true };
    });
  });
  return out;
}
const CHANGE_FIELDS_ = ['kind', 'description', 'quote_delta', 'cost_delta', 'change_date', 'note'];
const CHANGE_KINDS_ = ['增項', '減項'];
const BUDGET_CATEGORIES = ['場地', '硬體設備', '視覺設計', '印刷輸出', '餐飲', '交通住宿', '講師貴賓', '人力', '媒體宣傳',
  '攝影錄影', '佈置', '保險', '雜支', '管理費'];

const BudgetService = {
  forProject(projectId) {
    const project = repo_('projects').findById(projectId) || {};
    const lines = sortBy_(repo_('budget_lines').findWhere(l => l.project_id === projectId), 'created_at');
    const allExpenses = repo_('expense_claims').findWhere(e => e.project_id === projectId);
    const claimedByLine = {};
    allExpenses.filter(e => CLAIMED_EXPENSE_STATUSES_.indexOf(e.status) !== -1 && e.budget_line_id).forEach(e => {
      claimedByLine[e.budget_line_id] = (claimedByLine[e.budget_line_id] || 0) + (Number(e.amount) || 0);
    });
    const over = overBudgetByExpense_(allExpenses, lines);
    const changes = sortBy_(repo_('project_changes').findWhere(c => c.project_id === projectId), 'change_date');
    const expenses = countedExpenses_(projectId);
    const labor = laborCostOf_(projectId);
    const summary = computeMargin_(lines, changes, expenses, labor);
    return {
      lines: lines.map(l => Object.assign({}, l, {
        expense_actual: summary.expenseByLine[l.id] || 0,
        current_cost: summary.currentByLine[l.id] || 0,
        // 已申請 = 手填實際成本 + 送審中、已核准、已付款的請款；超過預估（核定金額）就標紅
        claimed: (Number(l.cost_actual) || 0) + (claimedByLine[l.id] || 0),
        list_total: l.unit_price !== null && l.unit_price !== undefined && l.unit_price !== '' ? Math.round(Number(l.unit_price) * (Number(l.quantity) || 1)) : null,
      })),
      quote: {
        status: quoteStatusOf_(project), submitted_at: project.quote_submitted_at || null, approved_by: project.quote_approved_by || null,
        approved_at: project.quote_approved_at || null, review_note: project.quote_review_note || null,
        approved_total: project.quote_approved_total, cost_approved_total: project.cost_approved_total,
        quote_date: project.quote_date || null, valid_until: project.quote_valid_until || null, terms: project.quote_terms || null,
      },
      // 送審中的請款也列出（還沒計入成本），PM 可以先指定科目
      pendingExpenses: allExpenses.filter(e => e.status === 'submitted').map(e => Object.assign({}, e, { over_budget: over[e.id] || null })),
      changes,
      unlinkedExpenses: expenses.filter(e => !e.budget_line_id || !summary.lineIds[e.budget_line_id]),
      // 已計入成本的費用（已核准、已付款），預算分頁可以改它們對沖哪個科目
      expenses: sortBy_(expenses, 'receipt_date').reverse().map(e => Object.assign({}, e, { over_budget: over[e.id] || null })),
      labor,
      totals: summary.totals,
    };
  },

  /**
   * 重算並寫回專案主檔的彙總欄位。系統推導的寫入走 updateMany（不比對 expectedUpdatedAt），
   * 不然 PM 正開著專案頁時，有人報帳核准就會讓 PM 存檔衝突。呼叫端可能已持有 lock。
   */
  recalc(projectId, actor) {
    return withScriptLock_(() => {
      const project = repo_('projects').findById(projectId);
      if (!project) return null;
      const t = computeMargin_(
        repo_('budget_lines').findWhere(l => l.project_id === projectId),
        repo_('project_changes').findWhere(c => c.project_id === projectId),
        countedExpenses_(projectId),
        laborCostOf_(projectId)).totals;
      const threshold = project.margin_threshold !== null && project.margin_threshold !== undefined
        ? Number(project.margin_threshold) : Number(setting_('margin_threshold'));
      const patch = {
        quote_total: t.quote,
        cost_estimate_total: t.estimate,
        cost_actual_total: t.actual,
        margin_rate: t.marginRate,
        margin_alert: t.quote > 0 && t.marginRate !== null && t.marginRate < threshold,
      };
      return repo_('projects').updateMany({ [projectId]: patch }, actor)[0];
    });
  },

  /**
   * 報價單流程：PM（或財務角色）送審 → 主管（manager、admin）核定或退回；核定後鎖住報價與預估成本。
   * 已核定的要改，由主管「退回修改」（要寫原因，記稽核）。
   */
  quoteAction(projectId, action, input, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('projects');
      const project = repo.findById(projectId);
      if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
      const st = quoteStatusOf_(project);
      const isBoss = hasRole_(ctx, [ROLES.ADMIN, ROLES.MANAGER]);
      const note = input && input.note ? String(input.note) : null;
      let patch;
      if (action === 'submit') {
        assertCanEditBudget_(projectId, ctx);
        if (st !== QUOTE_STATUS.DRAFT && st !== QUOTE_STATUS.RETURNED) throw new AppError(ERROR_CODES.VALIDATION, '報價單目前是「' + st + '」，不能送審');
        if (!repo_('budget_lines').findWhere(l => l.project_id === projectId).length) throw new AppError(ERROR_CODES.VALIDATION, '報價單還沒有任何項目');
        patch = { quote_status: QUOTE_STATUS.SUBMITTED, quote_submitted_at: nowIso_(), quote_review_note: null };
      } else if (action === 'approve' || action === 'return') {
        if (!isBoss) throw new AppError(ERROR_CODES.FORBIDDEN, '只有主管可以核定或退回報價單');
        if (action === 'approve' && st !== QUOTE_STATUS.SUBMITTED) throw new AppError(ERROR_CODES.VALIDATION, '報價單要先送審才能核定');
        if (action === 'return' && st !== QUOTE_STATUS.SUBMITTED && st !== QUOTE_STATUS.APPROVED) throw new AppError(ERROR_CODES.VALIDATION, '報價單目前是「' + st + '」，不用退回');
        if (action === 'return' && !note) throw new AppError(ERROR_CODES.VALIDATION, '退回請寫原因');
        if (action === 'approve') {
          const t = this.forProject(projectId).totals;
          patch = { quote_status: QUOTE_STATUS.APPROVED, quote_approved_by: ctx.account, quote_approved_at: nowIso_(), quote_review_note: note,
            quote_approved_total: t.quote, cost_approved_total: t.estimate };
        } else {
          patch = { quote_status: QUOTE_STATUS.RETURNED, quote_review_note: note, quote_approved_by: null, quote_approved_at: null };
        }
      } else if (action === 'info') {
        assertCanEditBudget_(projectId, ctx);
        patch = pickAllowed_(input || {}, ['quote_date', 'quote_valid_until', 'quote_terms'], '報價單');
      } else throw new AppError(ERROR_CODES.VALIDATION, '未知的操作');
      repo.updateMany({ [projectId]: patch }, ctx.account);
      if (action !== 'info') audit_(ctx, 'quote.' + action, 'projects', projectId, { from: st, to: patch.quote_status, note });
      return this.forProject(projectId).quote;
    });
  },

  addLine(projectId, data, ctx) {
    return withScriptLock_(() => {
      assertCanEditBudget_(projectId, ctx);
      assertQuoteEditable_(projectId, null);
      const line = repo_('budget_lines').insert(Object.assign({}, normalizeQuoteLine_(data, null), { project_id: projectId, source: 'manual' }), ctx.account);
      this.recalc(projectId, ctx.account);
      return line;
    });
  },

  /**
   * 從報價參考帶入：每項 { price_ref_id, quantity }，預估成本 = 單價 × 數量，帶入廠商；
   * 科目用呼叫端選的（預設硬體設備），項目名稱附上單價與數量，日後看得出怎麼算的。
   */
  addFromPrices(projectId, items, category, ctx) {
    if (!items.length) throw new AppError(ERROR_CODES.VALIDATION, '請至少選一個品項');
    if (category && BUDGET_CATEGORIES.indexOf(category) === -1) throw new AppError(ERROR_CODES.VALIDATION, '科目不正確');
    return withScriptLock_(() => {
      assertCanEditBudget_(projectId, ctx);
      assertQuoteEditable_(projectId, null);
      const all = repo_('price_refs').findAll();
      const refs = indexBy_(all, 'id');
      // 同品項＋類型的對客戶報價（任一列有填就用）
      const quoteOf = ref => {
        const same = all.filter(r => normName_(r.item) === normName_(ref.item) && normName_(r.type || '') === normName_(ref.type || ''));
        const filled = same.find(r => r.quote_price !== null && r.quote_price !== undefined && r.quote_price !== '');
        const est = same.find(r => !r.vendor_name);
        return quoteFor_(filled ? filled.quote_price : null, est && est.unit_price != null ? est.unit_price : Number(ref.unit_price) || 0);
      };
      const rows = items.map((it, i) => {
        const ref = refs[String(it.price_ref_id)];
        if (!ref) throw new AppError(ERROR_CODES.NOT_FOUND, '第 ' + (i + 1) + ' 項找不到報價資料，請重新整理');
        const qty = Number(it.quantity);
        if (!(qty > 0)) throw new AppError(ERROR_CODES.VALIDATION, '「' + ref.item + '」的數量要大於 0');
        const price = Number(ref.unit_price) || 0;
        const q = quoteOf(ref);
        return {
          quote_amount: q === null ? null : Math.round(q * qty), unit_price: q === null ? null : q, quantity: qty, unit: ref.unit || null,
          spec: ref.type && normName_(ref.type) !== normName_(ref.item) ? ref.type : null,
          project_id: projectId, category: category || '硬體設備', item: ref.item,
          cost_estimate: Math.round(price * qty), supplier_id: ref.supplier_id || null, source: 'price_ref',
          note: (ref.vendor_name ? ref.vendor_name + ' 報價' : '公司估算') + '：' + price + ' 元／' + (ref.unit || '單位') + ' × ' + qty +
            (q === null ? '' : '；對客戶報價 ' + q + ' 元／' + (ref.unit || '單位')),
        };
      });
      const saved = repo_('budget_lines').insertMany(rows, ctx.account);
      this.recalc(projectId, ctx.account);
      return saved;
    });
  },

  updateLine(id, expected, patch, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('budget_lines');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      assertCanEditBudget_(snapshot.record.project_id, ctx);
      assertQuoteEditable_(snapshot.record.project_id, Object.keys(patch));
      const saved = repo.writeSnapshot(snapshot, normalizeQuoteLine_(patch, snapshot.record), ctx.account);
      this.recalc(saved.project_id, ctx.account);
      return saved;
    });
  },

  deleteLine(id, expected, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('budget_lines');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      assertCanEditBudget_(snapshot.record.project_id, ctx);
      assertQuoteEditable_(snapshot.record.project_id, null);
      const linked = repo_('expense_claims').findWhere(e => e.budget_line_id === id);
      if (linked.length) throw new AppError(ERROR_CODES.VALIDATION, '這個科目有 ' + linked.length + ' 筆費用掛著，不能刪除');
      repo.markDeleted(snapshot, ctx.account);
      this.recalc(snapshot.record.project_id, ctx.account);
      return id;
    });
  },

  /** 增減項：一律留紀錄，報價與成本的變動都要寫，事後才查得到毛利是被哪一次變更吃掉的。 */
  addChange(projectId, data, ctx) {
    if (CHANGE_KINDS_.indexOf(data.kind) === -1) throw new AppError(ERROR_CODES.VALIDATION, '類型只能是增項或減項');
    return withScriptLock_(() => {
      assertCanEditBudget_(projectId, ctx);
      const change = repo_('project_changes').insert(Object.assign({ change_date: todayIso_() }, data, { project_id: projectId }), ctx.account);
      this.recalc(projectId, ctx.account);
      return change;
    });
  },

  /** 毛利報表：每個進行中的專案一列，給主管與會計看。 */
  report(ctx) {
    requireRole_(ctx, FINANCE_ROLES_, '查看毛利報表');
    return sortBy_(repo_('projects').findAll(), 'start_date').reverse().map(p => ({
      id: p.id, code: p.code, name: p.name, stage: p.stage, pm_account: p.pm_account, start_date: p.start_date,
      contract_amount: p.contract_amount, quote_total: p.quote_total, cost_estimate_total: p.cost_estimate_total,
      cost_actual_total: p.cost_actual_total, margin_rate: p.margin_rate, margin_alert: p.margin_alert,
    }));
  },
};

function assertCanEditBudget_(projectId, ctx) {
  const project = repo_('projects').findById(projectId);
  if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
  if (!ProjectService.canSeeFinance(ctx, project)) throw new AppError(ERROR_CODES.FORBIDDEN, '只有專案 PM 或財務角色可以修改預算');
}

/** 計入專案成本的費用：已核准或已付款。草稿、送審中、退回都還不算。 */
function countedExpenses_(projectId) {
  return repo_('expense_claims').findWhere(e => e.project_id === projectId &&
    (e.status === EXPENSE_STATUS.APPROVED || e.status === EXPENSE_STATUS.PAID));
}

function laborCostOf_(projectId) {
  return typeof DispatchService !== 'undefined' ? DispatchService.laborCost(projectId) : { hours: 0, cost: 0 };
}

/** 純函式：算法見檔案開頭。 */
function computeMargin_(lines, changes, expenses, labor) {
  const lineIds = {};
  lines.forEach(l => { lineIds[l.id] = true; });
  const expenseByLine = {};
  let unlinked = 0;
  expenses.forEach(e => {
    const amount = Number(e.amount) || 0;
    if (e.budget_line_id && lineIds[e.budget_line_id]) expenseByLine[e.budget_line_id] = (expenseByLine[e.budget_line_id] || 0) + amount;
    else unlinked += amount;
  });
  const currentByLine = {};
  let quote = 0, estimate = 0, actual = 0, current = 0;
  lines.forEach(l => {
    const est = Number(l.cost_estimate) || 0;
    const act = (Number(l.cost_actual) || 0) + (expenseByLine[l.id] || 0);
    quote += Number(l.quote_amount) || 0;
    estimate += est;
    actual += act;
    currentByLine[l.id] = Math.max(est, act);
    current += currentByLine[l.id];
  });
  const laborCost = Number(labor && labor.cost) || 0;
  const changeQuote = sum_(changes, 'quote_delta');
  const changeCost = sum_(changes, 'cost_delta');
  quote += changeQuote;
  estimate += changeCost;
  actual += unlinked + laborCost;
  current += unlinked + laborCost + changeCost;
  const round = n => Math.round(n);
  return {
    lineIds, expenseByLine, currentByLine,
    totals: {
      quote: round(quote), estimate: round(estimate), actual: round(actual), current: round(current),
      labor: round(laborCost), unlinkedExpenses: round(unlinked),
      margin: round(quote - current),
      marginRate: quote > 0 ? Math.round((quote - current) / quote * 1000) / 1000 : null,
    },
  };
}

function budgetRoutes_() {
  return {
    'budget.categories': { roles: INTERNAL_ROLES_, handler: () => BUDGET_CATEGORIES },
    // 請款時選「對沖哪一筆成本」用：同仁都看得到科目名稱；PM 與財務角色另外看得到預估、已用、剩餘。
    'budget.lineOptions': { roles: INTERNAL_ROLES_, handler: (p, ctx) => {
      const id = requireString_(p, 'project_id');
      const project = repo_('projects').findById(id);
      if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
      if (ProjectService.canSeeFinance(ctx, project)) {
        return BudgetService.forProject(id).lines.map(l => ({ id: l.id, category: l.category, item: l.item,
          cost_estimate: l.cost_estimate, used: (Number(l.cost_actual) || 0) + (l.expense_actual || 0),
          remaining: l.cost_estimate == null || l.cost_estimate === '' ? null : Number(l.cost_estimate) - (Number(l.cost_actual) || 0) - (l.expense_actual || 0) }));
      }
      return repo_('budget_lines').findWhere(l => l.project_id === id).map(l => ({ id: l.id, category: l.category, item: l.item }));
    } },
    'budget.get': { roles: INTERNAL_ROLES_, handler: (p, ctx) => {
      const id = requireString_(p, 'project_id');
      const project = repo_('projects').findById(id);
      if (!project || !ProjectService.canSeeFinance(ctx, project)) throw new AppError(ERROR_CODES.FORBIDDEN, '只有專案 PM 或財務角色可以看預算');
      return BudgetService.forProject(id);
    } },
    'budget.addFromPrices': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      BudgetService.addFromPrices(requireString_(p, 'project_id'), requireArray_(p, 'items'), p.category || null, ctx) },
    'budget.addLine': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      BudgetService.addLine(requireString_(p, 'project_id'), pickAllowed_(p.record || {}, BUDGET_LINE_FIELDS_, '預算科目'), ctx) },
    'budget.updateLine': { roles: INTERNAL_ROLES_, handler: (p, ctx) => {
      const a = updateArgs_(p, BUDGET_LINE_FIELDS_, '預算科目');
      return BudgetService.updateLine(a.id, a.expected, a.patch, ctx);
    } },
    'budget.deleteLine': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      BudgetService.deleteLine(requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt'), ctx) },
    'budget.addChange': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      BudgetService.addChange(requireString_(p, 'project_id'), pickAllowed_(p.record || {}, CHANGE_FIELDS_, '增減項'), ctx) },
    'budget.report': { roles: FINANCE_ROLES_, handler: (p, ctx) => BudgetService.report(ctx) },
    'quote.submit': { roles: INTERNAL_ROLES_, handler: (p, ctx) => BudgetService.quoteAction(requireString_(p, 'project_id'), 'submit', p, ctx) },
    'quote.approve': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => BudgetService.quoteAction(requireString_(p, 'project_id'), 'approve', { note: p.note }, ctx) },
    'quote.return': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) => BudgetService.quoteAction(requireString_(p, 'project_id'), 'return', { note: p.note }, ctx) },
    'quote.setInfo': { roles: INTERNAL_ROLES_, handler: (p, ctx) => BudgetService.quoteAction(requireString_(p, 'project_id'), 'info', p.record || {}, ctx) },
    // 待我核定的報價單（主管首頁、專案列表用）
    'quote.pending': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: () =>
      repo_('projects').findWhere(p => p.quote_status === QUOTE_STATUS.SUBMITTED).map(p => ({ id: p.id, code: p.code, name: p.name, pm_account: p.pm_account, quote_submitted_at: p.quote_submitted_at })) },
  };
}
