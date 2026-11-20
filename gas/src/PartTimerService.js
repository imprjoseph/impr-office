/**
 * 工讀生名冊：聯絡方式、專長、合作紀錄與評價。
 * 工讀生不一定有系統帳號（臨時找的就沒有）；有派遣帳號的可以填 account 對應。
 * 每次合作記一筆（哪個專案、哪天、做什麼、評分 1–5、評語），名冊上顯示平均分數、合作次數、最近一次。
 */
const PART_TIMER_STATUS = ['可合作', '暫停', '不再合作'];
const PART_TIMER_SKILLS = ['報到接待', '引導帶位', '貴賓接待', '會場佈置', '搬運', '攝影', '錄影', '社群小編', '行政文書', '主持', '駕駛'];
const PART_TIMER_LANGUAGES = ['英文', '日文', '韓文', '台語', '客語', '粵語'];
const PART_TIMER_FIELDS_ = ['name', 'phone', 'mobile', 'email', 'line_id', 'region', 'school', 'skills', 'languages', 'status', 'account', 'note'];
const PART_TIMER_JOB_FIELDS_ = ['part_timer_id', 'project_id', 'work_date', 'role', 'rating', 'comment'];

const PartTimerService = {
  list() {
    const jobs = repo_('part_timer_jobs').findAll();
    return sortBy_(repo_('part_timers').findAll(), 'name').map(p => {
      const mine = jobs.filter(j => j.part_timer_id === p.id);
      const rated = mine.filter(j => Number(j.rating) > 0);
      return Object.assign({}, p, {
        status: p.status || '可合作',
        job_count: mine.length,
        last_work_date: mine.map(j => j.work_date).sort().pop() || null,
        avg_rating: rated.length ? Math.round(rated.reduce((s, j) => s + Number(j.rating), 0) / rated.length * 10) / 10 : null,
      });
    });
  },

  jobs(partTimerId) {
    const projects = indexBy_(repo_('projects').findAll(), 'id');
    return sortBy_(repo_('part_timer_jobs').findWhere(j => !partTimerId || j.part_timer_id === partTimerId), 'work_date').reverse()
      .map(j => Object.assign({}, j, { project_name: j.project_id && projects[j.project_id] ? projects[j.project_id].name : null }));
  },

  addJob(record, ctx) {
    ratingNum_(record);
    assertJob_(record);
    return withScriptLock_(() => {
      if (!repo_('part_timers').findById(record.part_timer_id)) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到工讀生');
      return repo_('part_timer_jobs').insert(Object.assign({}, record, { rated_by: record.rating ? ctx.account : null }), ctx.account);
    });
  },

  updateJob(id, expected, patch, ctx) {
    ratingNum_(patch);
    assertJob_(patch);
    return withScriptLock_(() => {
      const repo = repo_('part_timer_jobs');
      const snapshot = loadCurrentForWrite_(repo, id, expected);
      return repo.writeSnapshot(snapshot, Object.assign({}, patch, 'rating' in patch ? { rated_by: ctx.account } : {}), ctx.account);
    });
  },
};

/** 評分從下拉選單來是字串，存成數字；空白是沒評分。 */
function ratingNum_(r) {
  if ('rating' in r) r.rating = r.rating === null || r.rating === '' ? null : Number(r.rating);
  return r;
}

function assertJob_(r) {
  if ('rating' in r && r.rating !== null && r.rating !== '' && !(Number(r.rating) >= 1 && Number(r.rating) <= 5)) {
    throw new AppError(ERROR_CODES.VALIDATION, '評分要在 1 到 5 之間');
  }
}

function assertPartTimer_(r) {
  if (r.status && PART_TIMER_STATUS.indexOf(r.status) === -1) throw new AppError(ERROR_CODES.VALIDATION, '狀態只能是：' + PART_TIMER_STATUS.join('、'));
  if (!r.phone && !r.mobile && !r.email && !r.line_id && !r.id) throw new AppError(ERROR_CODES.VALIDATION, '請至少填一種聯絡方式（電話、手機、Email 或 LINE）');
}

function partTimerRoutes_() {
  const r = INTERNAL_ROLES_;
  const crud = crudRoutes_('partTimer', 'part_timers', { read: r, write: r, fields: PART_TIMER_FIELDS_, label: '工讀生', validate: assertPartTimer_ });
  return Object.assign(crud, {
    'partTimer.list': { roles: r, handler: () => PartTimerService.list() },
    'partTimer.options': { roles: r, handler: () => ({ statuses: PART_TIMER_STATUS, skills: PART_TIMER_SKILLS, languages: PART_TIMER_LANGUAGES }) },
    'partTimer.jobs': { roles: r, handler: p => PartTimerService.jobs(p.part_timer_id || null) },
    'partTimer.addJob': { roles: r, handler: (p, ctx) => PartTimerService.addJob(pickAllowed_(p.record || {}, PART_TIMER_JOB_FIELDS_, '合作紀錄'), ctx) },
    'partTimer.updateJob': { roles: r, handler: (p, ctx) => {
      const a = updateArgs_(p, PART_TIMER_JOB_FIELDS_, '合作紀錄');
      return PartTimerService.updateJob(a.id, a.expected, a.patch, ctx);
    } },
    'partTimer.deleteJob': { roles: r, handler: (p, ctx) => withScriptLock_(() => {
      const repo = repo_('part_timer_jobs');
      return repo.markDeleted(loadCurrentForWrite_(repo, requireString_(p, 'id'), requireString_(p, 'expectedUpdatedAt')), ctx.account);
    }) },
  });
}
