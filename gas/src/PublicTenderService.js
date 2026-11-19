/**
 * 公開標案：直接讀「政府標案資料庫（自動累積）」試算表（GitHub Actions 每天從政府電子採購網篩選後寫入）。
 * 新系統不複製這份資料，只讀；同仁覺得值得投就按「追蹤」，在標案管理建立一筆，並回寫原表的狀態與負責人欄，
 * 用原表的同事也看得到誰在追。
 */
const GOV_TENDER_SHEET_DEFAULT_ = '1vKY27NlrPMpUOyq5mqSWgGRiJSHxaB-eDAJEr49mMVk';
const GOV_TENDER_TAB_ = '符合案件';
const GOV_TENDER_CACHE_KEY_ = 'gov-tenders-v1';

function govTenderSheet_() {
  const id = PropertiesService.getScriptProperties().getProperty('GOV_TENDER_SHEET_ID') || GOV_TENDER_SHEET_DEFAULT_;
  const sheet = SpreadsheetApp.openById(id).getSheetByName(GOV_TENDER_TAB_);
  if (!sheet) throw new AppError(ERROR_CODES.VALIDATION, '政府標案資料庫找不到「' + GOV_TENDER_TAB_ + '」分頁');
  return sheet;
}

/** 欄位依表頭名稱對應，原表調整欄序也不會讀錯。 */
const GOV_TENDER_HEADERS_ = {
  key: '主鍵', announce_date: '公告日', agency: '機關', title: '案名', budget: '預算', deadline_date: '截止投標',
  notice_type: '公告類型', tender_no: '案號', groups: '關鍵字群組', keywords: '命中關鍵字', score: '分數', link: '連結',
  first_seen: '首次收錄', status: '狀態', owner: '負責人', will_bid: '是否投標', note: '備註',
};

/** 「連結」欄可能是 HYPERLINK 公式或文字超連結，兩種都試。 */
function govTenderUrl_(formula, rich) {
  const m = String(formula || '').match(/HYPERLINK\(\s*"([^"]+)"/i);
  if (m) return m[1];
  try { return rich && rich.getLinkUrl ? rich.getLinkUrl() : null; } catch (e) { return null; }
}

function readGovTenders_() {
  const sheet = govTenderSheet_();
  const range = sheet.getDataRange();
  const values = range.getValues();
  if (!values.length) return [];
  const header = values[0].map(h => String(h).trim());
  const col = {};
  Object.keys(GOV_TENDER_HEADERS_).forEach(k => { col[k] = header.indexOf(GOV_TENDER_HEADERS_[k]); });
  if (col.title === -1 || col.key === -1) throw new AppError(ERROR_CODES.VALIDATION, '政府標案資料庫的表頭和預期不同（找不到「主鍵」「案名」）');
  const formulas = range.getFormulas ? range.getFormulas() : [];
  const rich = col.link >= 0 && range.getRichTextValues ? range.getRichTextValues() : [];
  return values.slice(1).map((r, i) => {
    const at = k => (col[k] >= 0 ? r[col[k]] : '');
    return {
      key: cellText_(at('key')),
      row: i + 2,
      announce_date: cellDate_(at('announce_date')),
      agency: cellText_(at('agency')),
      title: cellText_(at('title')),
      budget: cellNum_(at('budget')),
      deadline_date: cellDate_(at('deadline_date')),
      notice_type: cellText_(at('notice_type')),
      tender_no: cellText_(at('tender_no')),
      groups: cellText_(at('groups')),
      keywords: cellText_(at('keywords')),
      score: cellNum_(at('score')),
      url: col.link >= 0 ? govTenderUrl_((formulas[i + 1] || [])[col.link], (rich[i + 1] || [])[col.link]) : null,
      status: cellText_(at('status')),
      owner: cellText_(at('owner')),
      will_bid: cellText_(at('will_bid')),
      note: cellText_(at('note')),
    };
  }).filter(t => t.key && t.title);
}

const PublicTenderService = {
  /**
   * 預設只列還沒截標的；可用關鍵字（案名、機關、命中關鍵字）、關鍵字群組、最低分數篩選。最多回 300 筆。
   * 已在標案管理追蹤的（同案號＋機關）標上 tracked。
   */
  list(input) {
    const q = String(input.q || '').trim().toLowerCase();
    const group = String(input.group || '').trim();
    const minScore = Number(input.minScore) || 0;
    const includeClosed = input.includeClosed === true;
    const today = todayIso_();
    const all = readGovTenders_();
    const tracked = {};
    repo_('tenders').findAll().forEach(t => { if (t.tender_no) tracked[t.agency + '|' + t.tender_no] = t.id; });
    const groups = {};
    all.forEach(t => String(t.groups || '').split('/').forEach(g => {
      const name = g.replace(/[\d.…]+$/, '').replace(/\.\.\.$/, '').trim();
      if (name) groups[name] = true;
    }));
    const rows = all.filter(t =>
      (includeClosed || !t.deadline_date || t.deadline_date >= today) &&
      (!group || String(t.groups || '').indexOf(group) !== -1) &&
      (!minScore || (t.score || 0) >= minScore) &&
      (!q || [t.title, t.agency, t.keywords, t.tender_no].some(v => String(v || '').toLowerCase().indexOf(q) !== -1)));
    rows.sort((a, b) => String(b.announce_date || '').localeCompare(String(a.announce_date || '')) || (b.score || 0) - (a.score || 0));
    return {
      total: rows.length,
      totalAll: all.length,
      groups: Object.keys(groups).sort(),
      sheetUrl: 'https://docs.google.com/spreadsheets/d/' +
        (PropertiesService.getScriptProperties().getProperty('GOV_TENDER_SHEET_ID') || GOV_TENDER_SHEET_DEFAULT_) + '/edit',
      rows: rows.slice(0, 300).map(t => Object.assign(t, { tracked_id: tracked[t.agency + '|' + t.tender_no] || null })),
    };
  },

  /** 追蹤：在標案管理建一筆（負責人是自己），並回寫原表「狀態」「負責人」。同一案重按回傳原本那筆。 */
  track(key, ctx) {
    const t = readGovTenders_().find(x => x.key === key);
    if (!t) throw new AppError(ERROR_CODES.NOT_FOUND, '找不到這筆公開標案，可能已被移除，請重新整理');
    const existing = repo_('tenders').findWhere(x => x.tender_no && x.tender_no === t.tender_no && x.agency === t.agency)[0];
    if (existing) return { tender: existing, created: false };
    const tender = TenderService.create({
      title: t.title.replace(/\.\.\.$/, ''), agency: t.agency.replace(/\.\.\.$/, ''), tender_no: t.tender_no, source_url: t.url,
      budget_amount: t.budget, announce_date: t.announce_date, deadline_date: t.deadline_date,
    }, ctx);
    try {
      const sheet = govTenderSheet_();
      const header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());
      const statusCol = header.indexOf(GOV_TENDER_HEADERS_.status) + 1;
      const ownerCol = header.indexOf(GOV_TENDER_HEADERS_.owner) + 1;
      if (statusCol && !t.status) sheet.getRange(t.row, statusCol).setValues([['評估中']]);
      if (ownerCol && !t.owner) sheet.getRange(t.row, ownerCol).setValues([[ctx.name]]);
    } catch (e) {
      // 回寫原表失敗不影響新系統的追蹤紀錄。
    }
    return { tender, created: true };
  },
};

function publicTenderRoutes_() {
  return {
    'publicTender.list': { roles: INTERNAL_ROLES_, handler: p => PublicTenderService.list(p) },
    'publicTender.track': { roles: INTERNAL_ROLES_, handler: (p, ctx) => PublicTenderService.track(requireString_(p, 'key'), ctx) },
  };
}
