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

const BUDGET_LINE_FIELDS_ = ['category', 'item', 'quote_amount', 'cost_estimate', 'cost_actual', 'supplier_id', 'note'];
const CHANGE_FIELDS_ = ['kind', 'description', 'quote_delta', 'cost_delta', 'change_date', 'note'];
const CHANGE_KINDS_ = ['增項', '減項'];
const BUDGET_CATEGORIES = ['場地', '硬體設備', '視覺設計', '印刷輸出', '餐飲', '交通住宿', '講師貴賓', '人力', '媒體宣傳',
  '攝影錄影', '佈置', '保險', '雜支', '管理費'];

const BudgetService = {
  forProject(projectId) {
    const lines = repo_('budget_lines').findWhere(l => l.project_id === projectId);
    const changes = sortBy_(repo_('project_changes').findWhere(c => c.project_id === projectId), 'change_date');
    const expenses = countedExpenses_(projectId);
    const labor = laborCostOf_(projectId);
    const summary = computeMargin_(lines, changes, expenses, labor);
    return {
      lines: lines.map(l => Object.assign({}, l, {
        expense_actual: summary.expenseByLine[l.id] || 0,
        current_cost: summary.currentByLine[l.id] || 0,
      })),
      changes,
      unlinkedExpenses: expenses.filter(e => !e.budget_line_id || !summary.lineIds[e.budget_line_id]),
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

  addLine(projectId, data, ctx) {
    return withScriptLock_(() => {
      assertCanEditBudget_(projectId, ctx);
      const line = repo_('budget_lines').insert(Object.assign({}, data, { project_id: projectId, source: 'manual' }), ctx.account);
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
          quote_amount: q === null ? null : Math.round(q * qty),
          project_id: projectId, category: category || '硬體設備', item: ref.item + (ref.type && normName_(ref.type) !== normName_(ref.item) ? '（' + ref.type + '）' : ''),
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
      const saved = repo.writeSnapshot(snapshot, patch, ctx.account);
      this.recalc(saved.project_id, ctx.account);
      return saved;
    });
  },

  deleteLine(id, expected, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('budget_lines');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      assertCanEditBudget_(snapshot.record.project_id, ctx);
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
  };
}
