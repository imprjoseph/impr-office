/**
 * 專案與工作追蹤：沿用「活動進度自動追蹤系統」的做法——
 * 一場活動一個專案（EVT-年度-流水號）、底下一串工作；每天只更新狀態、最新進度、下一步、卡關原因，
 * 燈號與統計由系統算，不靠人填。
 */

const PROJECT_STAGES = ['規劃中', '籌備中', '執行準備', '活動完成', '結案中', '已結案', '暫停'];
// 這些階段不算進行中：工作台、提醒、燈號都略過。
const PROJECT_CLOSED_STAGES_ = ['活動完成', '結案中', '已結案', '暫停'];
const TASK_STATUSES = ['未開始', '進行中', '待內部確認', '待客戶確認', '待廠商回覆', '卡關', '已完成', '取消'];
const TASK_DONE_STATUSES_ = ['已完成', '取消'];
const TASK_WAITING_STATUSES_ = ['待內部確認', '待客戶確認', '待廠商回覆'];
const TASK_PRIORITIES = ['關鍵', '高', '中', '低'];
const TASK_CATEGORIES = ['合約行政', '整體時程', '視覺設計', '網站報名', '講師貴賓', '交通住宿', '餐飲伴手禮', '場地規劃',
  '舞台硬體', '輸出物', '文稿流程', '司儀口譯', '媒體社群', '攝影錄影', '人力分工', '保險安全', '彩排進場', '活動當日',
  '撤場場復', '驗收結案', '招商贊助'];

const PROJECT_FIELDS_ = ['name', 'client_id', 'client_name', 'project_type', 'venue', 'start_date', 'end_date',
  'pm_account', 'contract_amount', 'margin_threshold', 'drive_folder_url', 'success_notes', 'improve_notes',
  'client_contact', 'client_contact_title', 'client_contact_info'];
// 合約金額、毛利門檻是財務欄位；彙總欄位（quote_total…margin_rate）只能由預算重算寫入。
const PROJECT_FINANCE_FIELDS_ = ['contract_amount', 'margin_threshold', 'margin_alert', 'quote_total',
  'cost_estimate_total', 'cost_actual_total', 'margin_rate'];
const TASK_FIELDS_ = ['category', 'title', 'owner_account', 'assistant_account', 'start_date', 'due_date', 'priority',
  'status', 'progress_note', 'next_step', 'blocker', 'waiting_on', 'note'];
// 改到這些欄位才算「有更新進度」：只改備註不應該讓久未更新的提醒消失。
const TASK_PROGRESS_FIELDS_ = ['status', 'progress_note', 'next_step', 'blocker', 'waiting_on'];
const TEMPLATE_FIELDS_ = ['category', 'title', 'offset_days', 'priority', 'role', 'done_criteria', 'tip', 'sort', 'project_types'];

const ProjectService = {
  /** 能不能看這個專案的財務欄位：財務角色，或是這個專案的 PM。 */
  canSeeFinance(ctx, project) {
    return canSeeFinance_(ctx) || (!!project && project.pm_account === ctx.account);
  },

  present(ctx, project) {
    project = withClientId_(project);
    if (this.canSeeFinance(ctx, project)) return project;
    const c = Object.assign({}, project);
    PROJECT_FINANCE_FIELDS_.forEach(f => { delete c[f]; });
    return c;
  },

  list(ctx) {
    const today = todayIso_();
    const projects = repo_('projects').findAll();
    const stats = taskStatsByProject_(repo_('project_tasks').findAll(), today);
    return sortBy_(projects, 'start_date').reverse().map(p => {
      const s = stats[p.id] || emptyTaskStats_();
      return Object.assign(this.present(ctx, p), { stats: s, light: projectLight_(p, s, today) });
    });
  },

  get(id, ctx) {
    const project = repo_('projects').findById(id);
    if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
    const today = todayIso_();
    const tasks = repo_('project_tasks').findWhere(t => t.project_id === id);
    const stats = taskStatsByProject_(tasks, today)[id] || emptyTaskStats_();
    const finance = this.canSeeFinance(ctx, project);
    return {
      project: Object.assign(this.present(ctx, project), { stats, light: projectLight_(project, stats, today) }),
      tasks: sortBy_(tasks, 'due_date').map(t => Object.assign({}, t, { light: taskLight_(t, today) })),
      meetings: sortBy_(repo_('meetings').findWhere(m => m.project_id === id), 'meeting_date').reverse(),
      bookings: repo_('supplier_bookings').findWhere(b => b.project_id === id && b.status !== BOOKING_STATUS.CANCELLED),
      budget: finance && typeof BudgetService !== 'undefined' ? BudgetService.forProject(id) : null,
      canSeeFinance: finance,
    };
  },

  /**
   * 建立專案；有活動日期又勾選套用範本時，依 T-60 範本一次產生全部工作（截止日 = 活動日 + offset）。
   * 呼叫端可能已持有 lock（標案轉專案），withScriptLock_ 可重入。
   */
  create(data, ctx, options) {
    // 管理者帳號不當 PM：管理者建專案時 PM 先空白，由同仁指派
    const record = fillClientContact_(syncClientName_(Object.assign({ stage: '規劃中', pm_account: ctx.role === ROLES.ADMIN ? null : ctx.account }, data)), null);
    assertPmNotAdmin_(record.pm_account);
    if ('project_type' in record) record.project_type = normalizeProjectType_(record.project_type);
    if (record.start_date && record.end_date) assertDateRange_(record.start_date, record.end_date);
    return withScriptLock_(() => {
      const projects = repo_('projects').findAll({ includeDeleted: true });
      const dupe = projects.find(p => !p.is_deleted && normName_(p.name) === normName_(record.name));
      if (dupe) throw new AppError(ERROR_CODES.VALIDATION, '已經有同名的專案「' + dupe.name + '」（' + dupe.code + '）');
      record.code = nextProjectCode_(projects.map(p => p.code), record.start_date || todayIso_());
      const project = repo_('projects').insert(record, ctx.account);
      let tasks = [];
      if (options && options.applyTemplate && project.start_date) {
        tasks = TaskService.createFromTemplates(project, ctx);
      }
      return { project, tasks };
    });
  },

  /**
   * 刪除專案（邏輯刪除，資料列還在、可由管理者在試算表復原）。只有管理者、主管或該專案 PM 能刪。
   * 連帶刪除工作、會議、預算科目、增減項，取消供應商檔期。已送出的報帳、派遣排班、借用中的資材
   * 牽涉付款與人力成本，有這些就擋下，請先處理。
   */
  remove(id, expected, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('projects');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      const p = snapshot.record;
      if (!hasRole_(ctx, [ROLES.ADMIN, ROLES.MANAGER]) && p.pm_account !== ctx.account) {
        throw new AppError(ERROR_CODES.FORBIDDEN, '只有管理者、主管或這個專案的 PM 可以刪除專案');
      }
      const blockers = [];
      const expenses = repo_('expense_claims').findWhere(e => e.project_id === id && ['draft', 'rejected'].indexOf(e.status) === -1);
      if (expenses.length) blockers.push(expenses.length + ' 筆已送出的報帳');
      const dispatch = repo_('dispatch_assignments').findWhere(a => a.project_id === id && a.status === ASSIGNMENT_STATUS.ACTIVE);
      if (dispatch.length) blockers.push(dispatch.length + ' 筆派遣排班（請先取消排班）');
      const loans = repo_('loans').findWhere(l => l.project_id === id && l.status === LOAN_STATUS.OUT);
      if (loans.length) blockers.push(loans.length + ' 筆借用中的資材（請先歸還）');
      if (blockers.length) throw new AppError(ERROR_CODES.VALIDATION, '「' + p.name + '」還有 ' + blockers.join('、') + '，不能刪除；不做了可以改成「暫停」');
      const counts = {};
      ['project_tasks', 'meetings', 'budget_lines', 'project_changes'].forEach(table => {
        const ids = repo_(table).findWhere(r => r.project_id === id).map(r => r.id);
        repo_(table).markDeletedMany(ids, ctx.account);
        counts[table] = ids.length;
      });
      const bookings = {};
      repo_('supplier_bookings').findWhere(b => b.project_id === id && b.status !== BOOKING_STATUS.CANCELLED).forEach(b => { bookings[b.id] = { status: BOOKING_STATUS.CANCELLED }; });
      repo_('supplier_bookings').updateMany(bookings, ctx.account);
      repo.markDeleted(snapshot, ctx.account);
      audit_(ctx, 'project.delete', 'projects', id, { code: p.code, name: p.name, tasks: counts.project_tasks, bookings: Object.keys(bookings).length });
      return { id, name: p.name, tasks: counts.project_tasks, meetings: counts.meetings, budget_lines: counts.budget_lines, bookings: Object.keys(bookings).length };
    });
  },

  update(id, expected, patch, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('projects');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      if ('project_type' in patch) patch = Object.assign({}, patch, { project_type: normalizeProjectType_(patch.project_type) });
      if ('client_id' in patch) patch = syncClientName_(Object.assign({}, patch));
      if ('client_contact' in patch) patch = fillClientContact_(Object.assign({}, patch), snapshot.record);
      if ('pm_account' in patch) assertPmNotAdmin_(patch.pm_account);
      const finance = PROJECT_FINANCE_FIELDS_.filter(f => f in patch);
      if (finance.length && !this.canSeeFinance(ctx, snapshot.record)) {
        throw new AppError(ERROR_CODES.FORBIDDEN, '只有專案 PM 或財務角色可以修改：' + finance.join('、'));
      }
      const merged = Object.assign({}, snapshot.record, patch);
      if (merged.start_date && merged.end_date) assertDateRange_(merged.start_date, merged.end_date);
      const saved = repo.writeSnapshot(snapshot, patch, ctx.account);
      if ('margin_threshold' in patch && typeof BudgetService !== 'undefined') BudgetService.recalc(id, ctx.account);
      return this.present(ctx, repo_('projects').findById(id) || saved);
    });
  },

  setStage(id, expected, stage, ctx) {
    if (PROJECT_STAGES.indexOf(stage) === -1) throw new AppError(ERROR_CODES.VALIDATION, '未知的執行階段：' + stage);
    return this.present(ctx, updateRecord_('projects', id, expected, { stage }, ctx.account));
  },

  /** 結案：階段改成已結案，同時對這次合作的供應商評分（評分彙總回供應商主檔）。 */
  close(id, expected, ratings, notes, ctx) {
    return withScriptLock_(() => {
      const project = updateRecord_('projects', id, expected,
        Object.assign({ stage: '已結案' }, pickAllowed_(notes || {}, ['success_notes', 'improve_notes'], '結案心得')), ctx.account);
      if (ratings.length) SupplierService.rate(id, ratings, ctx);
      return this.present(ctx, project);
    });
  },
};

const TaskService = {
  create(projectId, data, ctx) {
    return withScriptLock_(() => {
      if (!repo_('projects').findById(projectId)) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
      return this.insertMany_([Object.assign({}, data, { project_id: projectId })], ctx)[0];
    });
  },

  /** 通用範本＋該活動類型的參考工作項目（新增專案時一次產生）。 */
  createFromTemplates(project, ctx) {
    return this.insertMany_(templatesFor_(project).map(t => taskFromTemplate_(project, t)), ctx);
  },

  /**
   * 專案建立後再代入參考工作：列出這個專案類型適用的範本、截止日，標出專案裡已經有的（同名工作），
   * 讓同仁勾選要加的。活動日期或類型是後來才填、或範本後來有新增時用。
   */
  templatePreview(projectId) {
    const project = repo_('projects').findById(projectId);
    if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
    const have = {};
    repo_('project_tasks').findWhere(t => t.project_id === projectId).forEach(t => { have[normName_(t.title)] = true; });
    return {
      project_type: project.project_type || '其他',
      start_date: project.start_date || null,
      items: templatesFor_(project).map(t => ({
        template_id: t.id, category: t.category, title: t.title, priority: t.priority || '中', role: t.role || null,
        offset_days: Number(t.offset_days) || 0,
        due_date: project.start_date ? addDays_(project.start_date, Number(t.offset_days) || 0) : null,
        exists: !!have[normName_(t.title)],
      })).sort((x, y) => x.offset_days - y.offset_days),
    };
  },

  /** 把勾選的範本加進專案；專案裡已有同名工作的略過，不會重複。 */
  addFromTemplates(projectId, templateIds, ctx) {
    return withScriptLock_(() => {
      const project = repo_('projects').findById(projectId);
      if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
      if (!project.start_date) throw new AppError(ERROR_CODES.VALIDATION, '請先填專案的活動日期，才能推算工作截止日');
      const want = {};
      templateIds.forEach(id => { want[id] = true; });
      const have = {};
      repo_('project_tasks').findWhere(t => t.project_id === projectId).forEach(t => { have[normName_(t.title)] = true; });
      const picked = templatesFor_(project).filter(t => want[t.id] && !have[normName_(t.title)]);
      return this.insertMany_(picked.map(t => taskFromTemplate_(project, t)), ctx);
    });
  },

  // 呼叫端持有 lock。工作編號沿用追蹤表的 T-流水號，跨專案唯一，口頭溝通說「T-116」就找得到。
  insertMany_(rows, ctx) {
    if (!rows.length) return [];
    const repo = repo_('project_tasks');
    let next = maxTaskNumber_(repo.findAll({ includeDeleted: true }).map(t => t.code));
    const now = nowIso_();
    return repo.insertMany(rows.map(r => {
      assertTaskValues_(r);
      next += 1;
      return Object.assign({ status: '未開始', priority: '中' }, r, { code: 'T-' + ('00' + next).slice(-3), last_update_at: now });
    }), ctx.account);
  },

  update(id, expected, patch, ctx) {
    assertTaskValues_(patch);
    return withScriptLock_(() => {
      const repo = repo_('project_tasks');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      const extra = {};
      if (TASK_PROGRESS_FIELDS_.some(f => f in patch)) extra.last_update_at = nowIso_();
      if ('status' in patch) {
        const done = TASK_DONE_STATUSES_.indexOf(patch.status) !== -1;
        const wasDone = TASK_DONE_STATUSES_.indexOf(snapshot.record.status) !== -1;
        if (done && !wasDone) extra.done_at = nowIso_();
        if (!done && wasDone) extra.done_at = null;
      }
      // 卡關一定要寫原因：沒有原因的卡關，主管看了也不知道要幫什麼。
      const merged = Object.assign({}, snapshot.record, patch);
      if (merged.status === '卡關' && !merged.blocker) throw new AppError(ERROR_CODES.VALIDATION, '狀態是卡關時請填卡關原因');
      const saved = repo.writeSnapshot(snapshot, Object.assign({}, patch, extra), ctx.account);
      return Object.assign(saved, { light: taskLight_(saved, todayIso_()) });
    });
  },

  mine(ctx) {
    const today = todayIso_();
    const open = indexBy_(repo_('projects').findWhere(p => PROJECT_CLOSED_STAGES_.indexOf(p.stage) === -1), 'id');
    return sortBy_(repo_('project_tasks').findWhere(t =>
      !!open[t.project_id] && TASK_DONE_STATUSES_.indexOf(t.status) === -1 &&
      (t.owner_account === ctx.account || t.assistant_account === ctx.account)), 'due_date')
      .map(t => Object.assign({}, t, { project_name: open[t.project_id].name, project_code: open[t.project_id].code, light: taskLight_(t, today) }));
  },
};

const MEETING_FIELDS_ = ['project_id', 'title', 'meeting_date', 'attendees', 'notes', 'meeting_type', 'location', 'summary', 'decisions', 'next_meeting_date'];
const MEETING_TYPES = ['內部會議', '客戶會議', '廠商會議', '進度會議', '場勘', '其他'];

const MeetingService = {
  /** 會議彙整：每場附上專案名稱與待辦統計（待辦就是帶 meeting_id 的專案工作）。 */
  list() {
    const today = todayIso_();
    const projects = indexBy_(repo_('projects').findAll(), 'id');
    const byMeeting = {};
    repo_('project_tasks').findWhere(t => t.meeting_id).forEach(t => { (byMeeting[t.meeting_id] = byMeeting[t.meeting_id] || []).push(t); });
    return sortBy_(repo_('meetings').findAll(), 'meeting_date').reverse().map(m => {
      const tasks = byMeeting[m.id] || [];
      const open = tasks.filter(t => TASK_DONE_STATUSES_.indexOf(t.status) === -1);
      return Object.assign({}, m, {
        project_name: m.project_id && projects[m.project_id] ? projects[m.project_id].name : null,
        project_code: m.project_id && projects[m.project_id] ? projects[m.project_id].code : null,
        task_total: tasks.length, task_open: open.length,
        task_overdue: open.filter(t => t.due_date && t.due_date < today).length,
      });
    });
  },

  get(id) {
    const m = repo_('meetings').findById(id);
    if (!m) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到這場會議');
    const today = todayIso_();
    const projects = indexBy_(repo_('projects').findAll(), 'id');
    const tasks = sortBy_(repo_('project_tasks').findWhere(t => t.meeting_id === id), 'due_date')
      .map(t => Object.assign({}, t, { light: taskLight_(t, today), project_name: projects[t.project_id] ? projects[t.project_id].name : null }));
    return { meeting: Object.assign({}, m, { project_name: m.project_id && projects[m.project_id] ? projects[m.project_id].name : null }), tasks };
  },

  /** 所有會議產生的待辦（跨專案）：預設只列未完成的。 */
  actionItems(includeDone) {
    const today = todayIso_();
    const meetings = indexBy_(repo_('meetings').findAll(), 'id');
    const projects = indexBy_(repo_('projects').findAll(), 'id');
    return sortBy_(repo_('project_tasks').findWhere(t => t.meeting_id && meetings[t.meeting_id] &&
      (includeDone || TASK_DONE_STATUSES_.indexOf(t.status) === -1)), 'due_date')
      .map(t => Object.assign({}, t, {
        light: taskLight_(t, today), meeting_title: meetings[t.meeting_id].title, meeting_date: meetings[t.meeting_id].meeting_date,
        project_name: projects[t.project_id] ? projects[t.project_id].name : null,
      }));
  },

  update(id, expected, patch, ctx) {
    if ('meeting_type' in patch && patch.meeting_type && MEETING_TYPES.indexOf(patch.meeting_type) === -1) throw new AppError(ERROR_CODES.VALIDATION, '會議類型不正確');
    if ('project_id' in patch && patch.project_id && !repo_('projects').findById(patch.project_id)) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
    return updateRecord_('meetings', id, expected, patch, ctx.account);
  },

  /** 刪會議只刪紀錄本身；它產生的待辦已經是專案工作，保留下來（只是不再連到會議）。 */
  remove(id, expected, ctx) {
    return withScriptLock_(() => {
      const repo = repo_('meetings');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      if (!hasRole_(ctx, [ROLES.ADMIN, ROLES.MANAGER]) && snapshot.record.created_by !== ctx.account) {
        throw new AppError(ERROR_CODES.FORBIDDEN, '只有建立的人、管理者或主管可以刪除會議紀錄');
      }
      const tasks = repo_('project_tasks').findWhere(t => t.meeting_id === id);
      const patches = {};
      tasks.forEach(t => { patches[t.id] = { meeting_id: null }; });
      if (tasks.length) repo_('project_tasks').updateMany(patches, ctx.account);
      repo.markDeleted(snapshot, ctx.account);
      return { id, tasks_kept: tasks.length };
    });
  },

  /** 會後追加待辦。 */
  addTasks(meetingId, tasks, ctx) {
    return withScriptLock_(() => {
      const m = repo_('meetings').findById(meetingId);
      if (!m) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到這場會議');
      if (!tasks.length) throw new AppError(ERROR_CODES.VALIDATION, '請至少填一項待辦');
      tasks.forEach((t, i) => {
        if (!t.title) throw new AppError(ERROR_CODES.VALIDATION, '第 ' + (i + 1) + ' 筆待辦缺少工作項目');
        if (!(t.project_id || m.project_id)) throw new AppError(ERROR_CODES.VALIDATION, '第 ' + (i + 1) + ' 筆待辦要指定專案');
        assertTaskValues_(t);
      });
      return TaskService.insertMany_(tasks.map(t => Object.assign({}, t, { project_id: t.project_id || m.project_id, meeting_id: meetingId })), ctx);
    });
  },

  /**
   * 會議紀錄連同決議的待辦一起建立，待辦直接成為專案工作（帶 meeting_id），不再是另一份清單。
   * 先全部驗過再寫：Sheets 沒有交易，寫到一半失敗會留下沒有待辦的會議。
   */
  createWithTasks(meeting, tasks, ctx) {
    return withScriptLock_(() => {
      if (meeting.project_id && !repo_('projects').findById(meeting.project_id)) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到專案');
      if (meeting.meeting_type && MEETING_TYPES.indexOf(meeting.meeting_type) === -1) throw new AppError(ERROR_CODES.VALIDATION, '會議類型不正確');
      tasks.forEach((t, i) => {
        if (!t.title) throw new AppError(ERROR_CODES.VALIDATION, '第 ' + (i + 1) + ' 筆待辦缺少工作項目');
        if (!(t.project_id || meeting.project_id)) throw new AppError(ERROR_CODES.VALIDATION, '第 ' + (i + 1) + ' 筆待辦要指定專案');
        assertTaskValues_(t);
      });
      repo_('meetings').assertInsertable([meeting]);
      const saved = repo_('meetings').insert(meeting, ctx.account);
      const created = TaskService.insertMany_(tasks.map(t =>
        Object.assign({}, t, { project_id: t.project_id || meeting.project_id, meeting_id: saved.id })), ctx);
      return { meeting: saved, tasks: created };
    });
  },
};

function assertTaskValues_(t) {
  if (t.status && TASK_STATUSES.indexOf(t.status) === -1) throw new AppError(ERROR_CODES.VALIDATION, '未知的狀態：' + t.status);
  if (t.priority && TASK_PRIORITIES.indexOf(t.priority) === -1) throw new AppError(ERROR_CODES.VALIDATION, '未知的重要性：' + t.priority);
}

/** EVT-年度-三碼流水號，接在該年度最大號之後；年度取活動日期，沒有就取今天。 */
function nextProjectCode_(codes, date) {
  const prefix = 'EVT-' + String(date).slice(0, 4) + '-';
  const max = codes.reduce((m, c) => {
    const s = String(c || '');
    if (s.indexOf(prefix) !== 0) return m;
    const n = parseInt(s.slice(prefix.length), 10);
    return isNaN(n) ? m : Math.max(m, n);
  }, 0);
  return prefix + ('00' + (max + 1)).slice(-3);
}

function maxTaskNumber_(codes) {
  return codes.reduce((m, c) => {
    const n = parseInt(String(c || '').replace(/^T-/, ''), 10);
    return isNaN(n) ? m : Math.max(m, n);
  }, 0);
}

function emptyTaskStats_() {
  return { total: 0, done: 0, overdue: 0, blocked: 0, waiting: 0, rate: 0 };
}

function taskStatsByProject_(tasks, today) {
  const out = {};
  tasks.forEach(t => {
    if (t.status === '取消') return;
    const s = out[t.project_id] || (out[t.project_id] = emptyTaskStats_());
    s.total++;
    if (t.status === '已完成') { s.done++; return; }
    if (t.due_date && t.due_date < today) s.overdue++;
    if (t.status === '卡關') s.blocked++;
    if (TASK_WAITING_STATUSES_.indexOf(t.status) !== -1) s.waiting++;
  });
  Object.keys(out).forEach(k => { out[k].rate = out[k].total ? Math.round(out[k].done / out[k].total * 100) / 100 : 0; });
  return out;
}

/**
 * 專案燈號，規則同追蹤表的公式：有逾期或卡關是紅燈；
 * 活動 7 天內完成率不到九成，或有待確認的工作是黃燈；其餘綠燈。已結束的專案不給燈號。
 */
/** PM 不能是管理者（admin 角色）帳號。 */
function assertPmNotAdmin_(account) {
  if (!account) return;
  const p = PeopleService.byAccount(account);
  if (p && p.office_role === ROLES.ADMIN) throw new AppError(ERROR_CODES.VALIDATION, '管理者帳號不能當 PM，請指派負責同仁');
}

/** 專案適用的範本：通用＋該類型；沒填類型的當成「其他」，寧可多不可漏。 */
function templatesFor_(project) {
  const type = project.project_type || '其他';
  return sortBy_(repo_('task_templates').findAll().filter(t => templateAppliesTo_(t, type)), 'sort');
}

function taskFromTemplate_(project, t) {
  return {
    project_id: project.id,
    category: t.category,
    title: t.title,
    due_date: addDays_(project.start_date, Number(t.offset_days) || 0),
    priority: t.priority || '中',
    owner_account: project.pm_account,
    note: [t.done_criteria ? '完成判斷：' + t.done_criteria : '', t.tip ? '提醒：' + t.tip : ''].filter(Boolean).join('\n') || null,
  };
}

function projectLight_(project, stats, today) {
  if (PROJECT_CLOSED_STAGES_.indexOf(project.stage) !== -1) return '';
  if (stats.overdue > 0 || stats.blocked > 0) return '紅燈';
  const daysLeft = project.start_date ? daysBetween_(today, project.start_date) : null;
  if ((daysLeft !== null && daysLeft <= 7 && stats.rate < 0.9) || stats.waiting > 0) return '黃燈';
  return '綠燈';
}

/** 工作燈號：已完成 / 已逾期 / 卡關 / 即將到期 / 久未更新 / 正常。 */
function taskLight_(task, today) {
  if (TASK_DONE_STATUSES_.indexOf(task.status) !== -1) return task.status;
  if (task.due_date && task.due_date < today) return '已逾期';
  if (task.status === '卡關') return '卡關';
  if (task.due_date && daysBetween_(today, task.due_date) <= Number(setting_('remind_due_days'))) return '即將到期';
  const last = String(task.last_update_at || task.updated_at || '').slice(0, 10);
  if (last && daysBetween_(last, today) >= Number(setting_('remind_stale_days'))) return '久未更新';
  return '正常';
}

/**
 * 專案只有一個「客戶」欄（選客戶主檔）；client_name 跟著客戶名稱走，列表、搜尋、AI 文件用。
 * 清掉客戶時名稱也清掉。
 */
function syncClientName_(record) {
  if (!('client_id' in record)) return record;
  if (!record.client_id) { record.client_name = null; return record; }
  const client = repo_('clients').findById(record.client_id);
  if (!client) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到這個客戶，請重新整理');
  record.client_name = client.name;
  return record;
}

/**
 * 客戶窗口：從客戶的主要窗口或聯絡人選（也可以直接打名字）。選到已知的人而職稱、聯絡方式沒填，就自動帶入。
 */
function clientContacts_(clientId) {
  if (!clientId) return [];
  const c = repo_('clients').findById(clientId);
  const out = [];
  if (c && c.contact_name) out.push({ name: c.contact_name, title: c.contact_title || null,
    info: [c.contact_mobile, c.contact_phone, c.contact_email].filter(Boolean).join('・') || null });
  repo_('contacts').findWhere(x => x.client_id === clientId).forEach(x => {
    if (!out.some(o => normName_(o.name) === normName_(x.name))) out.push({ name: x.name, title: x.title || null, info: [x.phone, x.email].filter(Boolean).join('・') || null });
  });
  return out;
}

function fillClientContact_(record, current) {
  const m = Object.assign({}, current || {}, record);
  if (!m.client_contact) return record;
  const hit = clientContacts_(m.client_id).find(o => normName_(o.name) === normName_(m.client_contact));
  if (!hit) return record;
  if (!m.client_contact_title && hit.title) record.client_contact_title = hit.title;
  if (!m.client_contact_info && hit.info) record.client_contact_info = hit.info;
  return record;
}

/** 舊資料（搬過來的、標案轉的）只有客戶名稱：同名的客戶主檔自動對上，表單打開就是選好的。 */
function withClientId_(project) {
  if (project.client_id || !project.client_name) return project;
  const key = normName_(project.client_name);
  const c = repo_('clients').findAll().find(x => normName_(x.name) === key);
  return c ? Object.assign({}, project, { client_id: c.id }) : project;
}

function daysBetween_(fromIso, toIso) {
  return Math.round((Date.parse(toIso + 'T00:00:00Z') - Date.parse(fromIso + 'T00:00:00Z')) / 86400000);
}

function projectRoutes_() {
  const pickTask = (o, label) => pickAllowed_(o || {}, TASK_FIELDS_, label || '工作');
  return Object.assign({
    'project.clientContacts': { roles: INTERNAL_ROLES_, handler: p => clientContacts_(p.client_id || null) },
    'project.options': { roles: INTERNAL_ROLES_, handler: () =>
      ({ stages: PROJECT_STAGES, statuses: TASK_STATUSES, priorities: TASK_PRIORITIES, categories: TASK_CATEGORIES }) },
    'project.list': { roles: INTERNAL_ROLES_, handler: (p, ctx) => ProjectService.list(ctx) },
    'project.get': { roles: INTERNAL_ROLES_, handler: (p, ctx) => ProjectService.get(requireString_(p, 'id'), ctx) },
    'project.create': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      ProjectService.create(pickAllowed_(p.record || {}, PROJECT_FIELDS_, '專案'), ctx, { applyTemplate: p.applyTemplate === true }) },
    'project.update': { roles: INTERNAL_ROLES_, handler: (p, ctx) => {
      const a = updateArgs_(p, PROJECT_FIELDS_, '專案');
      return ProjectService.update(a.id, a.expected, a.patch, ctx);
    } },
    'project.setStage': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      ProjectService.setStage(requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt'), requireString_(p, 'stage'), ctx) },
    'project.delete': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      ProjectService.remove(requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt'), ctx) },
    'project.close': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      ProjectService.close(requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt'),
        requireArray_(p, 'ratings').map(r => pickAllowed_(r, ['supplier_id', 'score', 'comment'], '評分')), p.notes, ctx) },
    'task.create': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      TaskService.create(requireString_(p, 'project_id'), pickTask(p.record), ctx) },
    'task.update': { roles: INTERNAL_ROLES_, handler: (p, ctx) => {
      const a = updateArgs_(p, TASK_FIELDS_, '工作');
      return TaskService.update(a.id, a.expected, a.patch, ctx);
    } },
    // 前端先在畫面上改、累積幾筆後一次送：同一把 lock 內逐筆套用，每筆各自成功或失敗（例如別人剛改過）。
    'task.updateMany': { roles: INTERNAL_ROLES_, handler: (p, ctx) => {
      const items = requireArray_(p, 'items');
      if (items.length > 200) throw new AppError(ERROR_CODES.VALIDATION, '一次最多 200 筆');
      return withScriptLock_(() => items.map(it => {
        try {
          const a = updateArgs_(it, TASK_FIELDS_, '工作');
          return { id: a.id, ok: true, record: TaskService.update(a.id, a.expected, a.patch, ctx) };
        } catch (e) {
          return { id: String(it.id || ''), ok: false, code: e.code || 'INTERNAL_ERROR', error: e.message };
        }
      }));
    } },
    'task.delete': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      softDeleteRecord_('project_tasks', requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt'), ctx.account).id },
    'task.mine': { roles: INTERNAL_ROLES_, handler: (p, ctx) => TaskService.mine(ctx) },
    'task.templatePreview': { roles: INTERNAL_ROLES_, handler: p => TaskService.templatePreview(requireString_(p, 'project_id')) },
    'task.addFromTemplates': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      TaskService.addFromTemplates(requireString_(p, 'project_id'), requireArray_(p, 'template_ids').map(String), ctx) },
    'meeting.create': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      MeetingService.createWithTasks(pickAllowed_(p.meeting || {}, MEETING_FIELDS_, '會議'),
        requireArray_(p, 'tasks').map((t, i) => pickAllowed_(t, TASK_FIELDS_.concat(['project_id']), '第 ' + (i + 1) + ' 筆待辦')), ctx) },
    'meeting.list': { roles: INTERNAL_ROLES_, handler: () => MeetingService.list() },
    'meeting.types': { roles: INTERNAL_ROLES_, handler: () => MEETING_TYPES },
    'meeting.get': { roles: INTERNAL_ROLES_, handler: p => MeetingService.get(requireString_(p, 'id')) },
    'meeting.actionItems': { roles: INTERNAL_ROLES_, handler: p => MeetingService.actionItems(p.includeDone === true) },
    'meeting.update': { roles: INTERNAL_ROLES_, handler: (p, ctx) => {
      const a = updateArgs_(p, MEETING_FIELDS_, '會議');
      return MeetingService.update(a.id, a.expected, a.patch, ctx);
    } },
    'meeting.delete': { roles: INTERNAL_ROLES_, handler: (p, ctx) => MeetingService.remove(requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt'), ctx) },
    'meeting.addTasks': { roles: INTERNAL_ROLES_, handler: (p, ctx) => MeetingService.addTasks(requireString_(p, 'meeting_id'),
      requireArray_(p, 'tasks').map((t, i) => pickAllowed_(t, TASK_FIELDS_.concat(['project_id']), '第 ' + (i + 1) + ' 筆待辦')), ctx) },
    'project.types': { roles: INTERNAL_ROLES_, handler: () => PROJECT_TYPES },
    'template.seedTypes': { roles: [ROLES.ADMIN, ROLES.MANAGER], handler: (p, ctx) =>
      ({ added: withScriptLock_(() => seedTypeTemplates_(ctx.account)) }) },
  }, crudRoutes_('template', 'task_templates', {
    read: INTERNAL_ROLES_, write: [ROLES.ADMIN, ROLES.MANAGER], fields: TEMPLATE_FIELDS_, label: '工作範本' }));
}
