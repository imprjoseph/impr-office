/**
 * 標案：公告 → 評估 → 準備 → 投標 → 開標結果；得標一鍵建立專案並套用 T-60 範本。
 * admin / manager 可改所有標案；其他人只能改自己負責的，避免別人誤改投標金額。
 */

const TENDER_STATUS = {
  EVALUATING: 'evaluating', PREPARING: 'preparing', SUBMITTED: 'submitted', WON: 'won', LOST: 'lost', SKIPPED: 'skipped',
};
// 限制狀態轉換讓統計可信：沒有「已投標」就直接標得標，得標率就算不準。
const TENDER_TRANSITIONS_ = {
  evaluating: ['preparing', 'skipped'],
  preparing: ['evaluating', 'submitted', 'skipped'],
  submitted: ['won', 'lost'],
  won: [],
  lost: [],
  skipped: ['evaluating'],
};
const TENDER_LABELS_ = { evaluating: '評估中', preparing: '準備中', submitted: '已投標', won: '得標', lost: '未得標', skipped: '不投標' };
const TENDER_FIELDS_ = ['title', 'agency', 'tender_no', 'source_url', 'budget_amount', 'announce_date', 'deadline_date',
  'opening_date', 'owner_account', 'decision_note', 'bid_bond', 'documents', 'bid_amount', 'award_amount',
  'competitors', 'result_note'];
// 截標前幾天開始出現在負責人的工作台。
const TENDER_REMIND_DAYS_ = 14;

const TenderService = {
  list() {
    return sortBy_(repo_('tenders').findAll(), 'deadline_date');
  },

  create(data, ctx) {
    const draft = Object.assign({ owner_account: ctx.account }, data, { status: TENDER_STATUS.EVALUATING });
    assertTenderDates_(draft);
    return createRecord_('tenders', draft, ctx.account);
  },

  update(id, expected, patch, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('tenders');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      assertCanEditTender_(snapshot.record, ctx);
      // 換負責人等於把標案交給別人，只有主管能做，否則同仁可以把別人的標案轉給自己。
      if ('owner_account' in patch && !isTenderManager_(ctx) && patch.owner_account !== ctx.account) {
        throw new AppError(ERROR_CODES.FORBIDDEN, '只有主管可以更換標案負責人');
      }
      assertTenderDates_(Object.assign({}, snapshot.record, patch));
      return repo.writeSnapshot(snapshot, patch, ctx.account);
    });
  },

  setStatus(id, expected, status, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('tenders');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      assertCanEditTender_(snapshot.record, ctx);
      const from = snapshot.record.status;
      if ((TENDER_TRANSITIONS_[from] || []).indexOf(status) === -1) {
        throw new AppError(ERROR_CODES.VALIDATION, '標案目前是「' + (TENDER_LABELS_[from] || from) + '」，不能改成「' + (TENDER_LABELS_[status] || status) + '」');
      }
      return repo.writeSnapshot(snapshot, { status }, ctx.account);
    });
  },

  /** 得標轉專案：名稱、客戶、PM 沿用標案，日期由使用者填；建立與回寫在同一把 lock 內，重複點擊不會建兩個。 */
  convertToProject(id, expected, input, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('tenders');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      const tender = snapshot.record;
      assertCanEditTender_(tender, ctx);
      if (tender.status !== TENDER_STATUS.WON) throw new AppError(ERROR_CODES.VALIDATION, '只有得標的標案可以轉成專案');
      if (tender.project_id) throw new AppError(ERROR_CODES.VALIDATION, '這個標案已經轉成專案了');
      const result = ProjectService.create(Object.assign({
        name: tender.title,
        client_name: tender.agency,
        pm_account: tender.owner_account,
        tender_id: tender.id,
        contract_amount: tender.award_amount || tender.bid_amount || null,
      }, input), ctx, { applyTemplate: true });
      const updated = repo.writeSnapshot(snapshot, { project_id: result.project.id }, ctx.account);
      return { tender: updated, project: result.project, taskCount: result.tasks.length };
    });
  },

  /** 工作台：我負責、還在評估或準備、截標日在提醒期間內（含已過）的標案。 */
  dueFor(account, today) {
    const until = addDays_(today, TENDER_REMIND_DAYS_);
    return sortBy_(repo_('tenders').findWhere(t => t.owner_account === account &&
      (t.status === TENDER_STATUS.EVALUATING || t.status === TENDER_STATUS.PREPARING) &&
      t.deadline_date && t.deadline_date <= until), 'deadline_date');
  },
};

function isTenderManager_(ctx) {
  return hasRole_(ctx, [ROLES.ADMIN, ROLES.MANAGER]);
}

function assertCanEditTender_(tender, ctx) {
  if (isTenderManager_(ctx) || tender.owner_account === ctx.account) return;
  throw new AppError(ERROR_CODES.FORBIDDEN, '只有負責人或主管可以修改這個標案');
}

// 開標日不能早於截標日：填反通常是打錯字，晚點才發現就錯過截標。
function assertTenderDates_(t) {
  if (t.deadline_date && t.opening_date && t.opening_date < t.deadline_date) {
    throw new AppError(ERROR_CODES.VALIDATION, '開標日不能早於截標日');
  }
}

function tenderRoutes_() {
  return {
    'tender.list': { roles: INTERNAL_ROLES_, handler: () => TenderService.list() },
    'tender.create': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      TenderService.create(pickAllowed_(p.record || {}, TENDER_FIELDS_, '標案'), ctx) },
    'tender.update': { roles: INTERNAL_ROLES_, handler: (p, ctx) => {
      const a = updateArgs_(p, TENDER_FIELDS_, '標案');
      return TenderService.update(a.id, a.expected, a.patch, ctx);
    } },
    'tender.setStatus': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      TenderService.setStatus(requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt'), requireString_(p, 'status'), ctx) },
    'tender.convertToProject': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      TenderService.convertToProject(requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt'),
        pickAllowed_(p.project || {}, ['project_type', 'venue', 'start_date', 'end_date', 'client_id'], '專案'), ctx) },
  };
}
