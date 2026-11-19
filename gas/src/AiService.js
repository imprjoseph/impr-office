/**
 * AI：文件產出（新聞稿、致詞稿、建議書初稿、結案報告）、每日待辦摘要與主管週報、AI 平面設計（Claude 寫文案與提示詞，GPT 出圖）。
 * 同仁填的資料欄位與範本在 AiForms.js。
 *
 * 金鑰放在 Script Properties（ANTHROPIC_API_KEY、OPENAI_API_KEY），由管理者自己貼，不進程式碼、不進試算表。
 * 每次呼叫都記進 ai_jobs（誰、做什麼、用了多少 token）；當月用量超過設定上限就暫停，避免帳單失控。
 * 沒設金鑰時每日提醒照常寄送，只是不經 AI 整理。
 */

const CLAUDE_URL_ = 'https://api.anthropic.com/v1/messages';
const CLAUDE_VERSION_ = '2026-10-21';
// 文件要寫得好用 Sonnet；每日摘要量大、內容單純，用 Haiku 省錢。
const CLAUDE_DOC_MODEL_ = 'claude-sonnet-5-5';
const CLAUDE_SUMMARY_MODEL_ = 'claude-haiku-5-5';
// Apps Script 的 UrlFetch 約 60 秒逾時，文件長度上限壓在這裡，並用 medium effort 縮短回應時間。
const CLAUDE_DOC_MAX_TOKENS_ = 8000;
const CLAUDE_SUMMARY_MAX_TOKENS_ = 1500;

const AI_DOC_KINDS = {
  press_release: { label: '新聞稿', guide: '寫成台灣政府與企業活動常用的新聞稿：標題、副標、導言（5W1H）、內文三到五段、引述主辦單位長官一句話、活動資訊與聯絡窗口。語氣正式、具體，不誇大，不捏造數字或人名；資料沒有的就用【待補】標示。' },
  speech: { label: '致詞稿', guide: '寫一份 3 分鐘的長官致詞稿：稱謂、開場感謝、活動意義、對與會者的期許、結語祝福。口語、好唸，每段不超過三句；資料沒有的人名職稱用【待補】。' },
  proposal: { label: '標案服務建議書初稿', guide: '寫政府採購服務建議書的章節大綱與重點內容：計畫緣起與目標、執行策略、工作項目與時程、人力配置、預期效益、風險管理。逐條對應需求，具體可執行；沒有的資訊用【待補】，不捏造實績。' },
  closing_report: { label: '結案報告', guide: '寫活動結案報告：活動概要、執行成果（依工作分類整理完成情形）、成功經驗、待改進事項、後續建議。根據提供的工作清單與心得寫，沒有的數據用【待補】，不捏造人數或成效。' },
};

const AiService = {
  /**
   * 依同仁逐項填的資料產出文件；有選專案就另附專案的工作與進度（結案報告必選）。回傳文字並另存成 Google 文件。
   */
  generateDocument(kind, projectId, values, ctx, research) {
    const spec = AI_DOC_KINDS[kind];
    if (!spec) throw new AppError(ERROR_CODES.VALIDATION, '不支援的文件類型：' + kind);
    const form = AI_DOC_FORMS_[kind];
    if (form.needsProject && !projectId) throw new AppError(ERROR_CODES.VALIDATION, spec.label + '要選擇專案，才能整理工作完成情形');
    const brief = aiFormBrief_(form.fields, values);
    const detail = projectId ? ProjectService.get(projectId, ctx) : null;
    const ref = String(research || '').trim().slice(0, 6000);
    const prompt = '同仁填寫的資料：\n' + brief + (detail ? '\n\n專案系統資料：\n' + projectBrief_(detail) : '') +
      (ref ? '\n\n客戶單位背景與既有稿件寫法（網路查詢結果，經同仁確認）：\n' + ref : '') + '\n\n請產出：' + spec.label;
    const system = '你是 imPR 新動力公關顧問公司的資深文案。只用繁體中文（台灣用語）。' + spec.guide +
      '\n稿件要清楚說明客戶單位是誰（全名與角色）。有提供客戶單位既有稿件寫法時，標題、導言與用語盡量貼近該單位的習慣。' +
      '\n以同仁填寫的資料為準；資料沒有的地方用【待補】，不要自己編人名、數字或實績。\n用 Markdown 標題與段落輸出，不要加任何前言或解釋。';
    const res = this.callClaude_(CLAUDE_DOC_MODEL_, system, prompt, CLAUDE_DOC_MAX_TOKENS_, 'doc.' + kind, projectId || null, ctx);
    const name = String((values || {}).event_name || (detail ? detail.project.name : '')).trim();
    const title = (detail ? detail.project.code + ' ' : '') + name + '｜' + spec.label + '（AI 初稿）';
    const url = saveAsGoogleDoc_(title, res.text);
    withScriptLock_(() => repo_('ai_jobs').updateMany({ [res.jobId]: { output_url: url } }, ctx.account));
    return { title, text: res.text, url };
  },

  /**
   * 上網查客戶單位：單位簡介、近期重要政策或活動，以及該單位既有新聞稿的寫法（標題、導言、引述、署名習慣）。
   * 結果先給同仁看（附來源連結、可修改），寫稿時再當參考資料帶進去。和寫稿分成兩次呼叫，各自都在 Apps Script 的逾時內。
   */
  researchClient(clientUnit, clientSite, kind, projectId, ctx) {
    const unit = String(clientUnit || '').trim();
    if (!unit) throw new AppError(ERROR_CODES.VALIDATION, '請填寫「客戶單位」');
    const label = (AI_DOC_KINDS[kind] || AI_DOC_KINDS.press_release).label;
    const system = '你是公關公司的研究助理。只用繁體中文（台灣用語）。用網路搜尋查這個單位，優先看它的官方網站與新聞發布頁。' +
      '只寫查得到的事實，查不到就寫「查無資料」，不要猜。輸出三段，用 Markdown 小標：' +
      '「## 單位簡介」（全名、層級、主管業務，3 到 5 句）、「## 近期重點」（近一年的政策、活動或新聞，條列最多 5 點）、' +
      '「## 既有' + label + '寫法」（該單位已發布稿件的標題格式、導言寫法、常見用語、引述與署名習慣，條列，並舉一個實際標題為例）。不要加前言。';
    const prompt = '客戶單位：' + unit + (clientSite ? '\n官方網站或新聞頁：' + clientSite : '') + '\n要寫的稿件：' + label;
    const tool = { type: 'web_search_20260209', name: 'web_search', max_uses: 4 };
    const res = this.callClaude_(CLAUDE_DOC_MODEL_, system, prompt, 2500, 'research.client', projectId || null, ctx, { tools: [tool], effort: 'low' });
    return { text: res.text, sources: res.sources };
  },

  /**
   * AI 平面設計第一步：Claude 依同仁填的需求寫主標、副標、文案、設計概念與給 GPT 的英文生圖提示詞。
   * 出圖是第二步（designImage），分開呼叫：兩段各自都在 Apps Script 約 60 秒的逾時內，同仁也能先改提示詞或挑變化版再出圖。
   */
  design(projectId, values, ctx) {
    const brief = aiFormBrief_(AI_DESIGN_FORM_.fields, values);
    const toolHint = '提示詞是給 OpenAI GPT 生圖用的：用完整英文句子描述畫面主體、構圖、光線、色調與質感，開頭說明比例，最後一句寫明 "No text, no letters, no logos."。';
    const system = '你是國際會議主視覺設計顧問。先決定一個貫穿畫面的視覺比喻，再設計元素。避免常見的 AI 圖像感（過度光暈、廉價科技藍、無意義的電路紋）。' +
      '圖裡不放任何文字，字由設計師後製套上。' + toolHint +
      '\n只輸出 JSON，不要其他文字：{"headline":"主標","subheadline":"副標","copy":"一段 40 字內文案","concept":"視覺比喻與構圖說明（繁體中文）",' +
      '"prompt":"可直接貼到生圖工具的英文提示詞","prompt_zh":"提示詞的中文說明，讓同仁看懂在描述什麼","negative":"要避免的元素（英文，逗號分隔）",' +
      '"variations":["換一種構圖的英文提示詞","換一種色調的英文提示詞"]}';
    const res = this.callClaude_(CLAUDE_DOC_MODEL_, system, '設計需求：\n' + brief, 3000, 'design.prompt', projectId || null, ctx);
    let plan;
    try {
      plan = JSON.parse(res.text.replace(/^```(json)?|```$/g, '').trim());
    } catch (e) {
      throw new AppError(ERROR_CODES.VALIDATION, 'AI 回傳的格式有誤，請再試一次');
    }
    return { plan };
  },

  /** AI 平面設計第二步：把（同仁可能改過的）提示詞交給 GPT 出圖。圖直接回傳給前端下載，不存試算表（base64 超過儲存格上限）。 */
  designImage(prompt, ratio, projectId, ctx) {
    const p = String(prompt || '').trim();
    if (!p) throw new AppError(ERROR_CODES.VALIDATION, '缺少提示詞');
    if (p.length > 4000) throw new AppError(ERROR_CODES.VALIDATION, '提示詞太長，請精簡到 4000 字內');
    return { image: generateImage_(p, ratio, ctx, projectId) };
  },

  /** 呼叫 Claude Messages API（raw HTTP；Apps Script 沒有官方 SDK）。回傳 { text, jobId }。 */
  callClaude_(model, system, prompt, maxTokens, kind, projectId, ctx, opts) {
    const o = opts || {};
    const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
    if (!key) throw new AppError(ERROR_CODES.VALIDATION, '尚未設定 Claude API 金鑰，請管理者在 Apps Script 的指令碼屬性加上 ANTHROPIC_API_KEY');
    assertAiQuota_();
    const body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort: o.effort || (model === CLAUDE_SUMMARY_MODEL_ ? 'low' : 'medium') },
    };
    if (o.tools) body.tools = o.tools;
    const headers = { 'x-api-key': key, 'anthropic-version': CLAUDE_VERSION_ };
    // Sonnet 遇到安全分類器誤擋時，伺服器端自動改用其他模型重跑，同一次呼叫內完成。
    if (model === CLAUDE_DOC_MODEL_) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }
    const job = { kind, project_id: projectId, prompt: String(prompt).slice(0, 4000), model, input_tokens: 0, output_tokens: 0 };
    const content = [];
    let json;
    // 上網搜尋這類伺服器端工具跑太久時會回 pause_turn：把目前內容帶回去再送一次，伺服器會接著做（最多接兩次）。
    for (let round = 0; round < 3; round++) {
      let res;
      try {
        res = UrlFetchApp.fetch(CLAUDE_URL_, {
          method: 'post', contentType: 'application/json', headers, payload: JSON.stringify(body), muteHttpExceptions: true,
        });
      } catch (e) {
        throw new AppError(ERROR_CODES.VALIDATION, 'AI 服務連線失敗，請稍後再試');
      }
      json = JSON.parse(res.getContentText());
      if (json.type === 'error' || (res.getResponseCode && res.getResponseCode() >= 400)) {
        recordAiJob_(Object.assign(job, { status: 'error', error: json.error ? json.error.message : 'HTTP ' + res.getResponseCode() }), ctx);
        throw new AppError(ERROR_CODES.VALIDATION, 'AI 服務暫時無法使用：' + (json.error ? json.error.message : '請稍後再試'));
      }
      const usage = json.usage || {};
      job.input_tokens += usage.input_tokens || 0;
      job.output_tokens += usage.output_tokens || 0;
      (json.content || []).forEach(b => content.push(b));
      if (json.stop_reason !== 'pause_turn') break;
      body.messages = [{ role: 'user', content: prompt }, { role: 'assistant', content: content.slice() }];
    }
    if (json.stop_reason === 'refusal') {
      recordAiJob_(Object.assign(job, { status: 'refused' }), ctx);
      throw new AppError(ERROR_CODES.VALIDATION, 'AI 拒絕產生這份內容，請調整補充說明後再試');
    }
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    // 被 max_tokens 截斷時照樣給使用者，但標示出來，免得把半份文件當完整版用。
    const finalText = json.stop_reason === 'max_tokens' ? text + '\n\n【AI 輸出長度已達上限，內容可能不完整】' : text;
    const jobRow = recordAiJob_(Object.assign(job, { status: 'done', output: finalText.slice(0, 40000) }), ctx);
    return { text: finalText, jobId: jobRow.id, sources: webSources_(content) };
  },


  usageThisMonth() {
    const month = todayIso_().slice(0, 7);
    const rows = repo_('ai_jobs').findWhere(j => String(j.created_at || '').slice(0, 7) === month);
    return { month, jobs: rows.length, tokens: sum_(rows, 'input_tokens') + sum_(rows, 'output_tokens'), limit: Number(setting_('ai_monthly_token_limit')) };
  },
};

function assertAiQuota_() {
  const u = AiService.usageThisMonth();
  if (u.limit > 0 && u.tokens >= u.limit) throw new AppError(ERROR_CODES.VALIDATION, '本月 AI 用量已達上限，請管理者調整設定或下個月再用');
}

function recordAiJob_(job, ctx) {
  return withScriptLock_(() => repo_('ai_jobs').insert(job, ctx.account));
}

/** 給 AI 的專案摘要：只放產出文件需要的事實，不放成本與毛利（文件可能對外）。 */
function projectBrief_(detail) {
  const p = detail.project;
  const lines = [
    '專案：' + p.name + '（' + p.code + '）',
    '客戶／主辦單位：' + (p.client_name || '【待補】'),
    '活動類型：' + (p.project_type || '【待補】'),
    '日期：' + (p.start_date || '【待補】') + (p.end_date && p.end_date !== p.start_date ? ' 至 ' + p.end_date : ''),
    '地點：' + (p.venue || '【待補】'),
  ];
  if (p.success_notes) lines.push('成功經驗：' + p.success_notes);
  if (p.improve_notes) lines.push('待改進事項：' + p.improve_notes);
  const done = detail.tasks.filter(t => t.status === '已完成');
  if (detail.tasks.length) {
    lines.push('工作項目（' + done.length + '/' + detail.tasks.length + ' 完成）：');
    detail.tasks.slice(0, 80).forEach(t => lines.push('- [' + (t.category || '其他') + '] ' + t.title + '：' + t.status + (t.progress_note ? '，' + t.progress_note : '')));
  }
  return lines.join('\n');
}

function saveAsGoogleDoc_(title, markdown) {
  const doc = DocumentApp.create(title);
  const body = doc.getBody();
  String(markdown).split('\n').forEach(line => {
    const m = line.match(/^(#{1,3})\s+(.*)$/);
    if (m) {
      body.appendParagraph(m[2]).setHeading([DocumentApp.ParagraphHeading.HEADING1, DocumentApp.ParagraphHeading.HEADING2, DocumentApp.ParagraphHeading.HEADING3][m[1].length - 1]);
    } else if (line.trim()) {
      body.appendParagraph(line.replace(/\*\*(.*?)\*\*/g, '$1'));
    }
  });
  doc.saveAndClose();
  return doc.getUrl();
}

/**
 * OpenAI GPT 生圖（Images API）。模型名稱放設定（openai_image_model），OpenAI 換版本時改設定就好。
 * GPT 生圖只支援橫、方、直三種尺寸，依前端選的比例挑最接近的一種。
 */
function generateImage_(prompt, size, ctx, projectId) {
  const key = PropertiesService.getScriptProperties().getProperty('OPENAI_API_KEY');
  if (!key) throw new AppError(ERROR_CODES.VALIDATION, '尚未設定 OpenAI API 金鑰，請管理者在指令碼屬性加上 OPENAI_API_KEY');
  assertAiQuota_();
  const model = setting_('openai_image_model');
  let res;
  try {
    res = UrlFetchApp.fetch('https://api.openai.com/v1/images/generations', {
      method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + key }, muteHttpExceptions: true,
      payload: JSON.stringify({ model, prompt: prompt + '\nNo text, no letters, no logos.', size: openAiImageSize_(size), n: 1 }),
    });
  } catch (e) {
    throw new AppError(ERROR_CODES.VALIDATION, '生圖服務連線失敗，請稍後再試');
  }
  let json;
  try { json = JSON.parse(res.getContentText()); } catch (e) { json = {}; }
  const img = ((json.data || [])[0] || {}).b64_json;
  const usage = json.usage || {};
  const errMsg = json.error ? json.error.message : '沒有產生圖片';
  recordAiJob_({ kind: 'design.image', project_id: projectId, prompt: String(prompt).slice(0, 4000), model, status: img ? 'done' : 'error',
    input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, error: img ? null : errMsg }, ctx);
  if (!img) throw new AppError(ERROR_CODES.VALIDATION, '生圖失敗：' + (json.error ? json.error.message : '沒有產生圖片，請調整描述再試'));
  return { mimeType: 'image/png', base64: img };
}

/** 比例（16:9、1:1、4:5、A 系列直式…）或像素（1920x1080）換成 GPT 生圖支援的尺寸。 */
function openAiImageSize_(size) {
  const s = String(size || '16:9');
  const m = s.match(/(\d+)\s*[:x×]\s*(\d+)/);
  const ratio = m ? Number(m[1]) / Number(m[2]) : /直式/.test(s) ? 0.7 : /方/.test(s) ? 1 : 16 / 9;
  if (ratio > 1.15) return '1536x1024';
  if (ratio < 0.87) return '1024x1536';
  return '1024x1024';
}

/** 從回應裡整理搜尋到的來源（標題＋網址），去除重複。 */
function webSources_(content) {
  const seen = {};
  const out = [];
  const add = (url, title) => {
    if (!url || seen[url] || !/^https?:\/\//.test(url)) return;
    seen[url] = true;
    out.push({ url, title: title || url });
  };
  content.forEach(b => {
    if (b.type === 'text' && Array.isArray(b.citations)) b.citations.forEach(c => add(c.url, c.title));
  });
  content.forEach(b => {
    if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) b.content.forEach(r => add(r.url, r.title));
  });
  return out.slice(0, 12);
}

// ---------------- 每日提醒與主管週報 ----------------

/**
 * 每天早上由排程觸發：每人一封待辦摘要（逾期、卡關、即將到期、久未更新）。
 * 同一件工作提醒後隔 remind_cooldown_days 天才再提醒；逾期超過 escalate_overdue_days 天副本給主管。
 */
function runDailyReminders() {
  const today = todayIso_();
  const ctx = { account: 'system', role: ROLES.ADMIN };
  const people = indexBy_(repo_('people').findAll(), 'account');
  const open = indexBy_(repo_('projects').findWhere(p => PROJECT_CLOSED_STAGES_.indexOf(p.stage) === -1), 'id');
  const cooldown = Number(setting_('remind_cooldown_days'));
  const escalate = Number(setting_('escalate_overdue_days'));
  const recent = {};
  repo_('reminder_log').findWhere(r => daysBetween_(r.sent_on, today) < cooldown).forEach(r => { recent[r.account + '|' + r.ref_id] = true; });
  const byOwner = {};
  repo_('project_tasks').findWhere(t => open[t.project_id] && TASK_DONE_STATUSES_.indexOf(t.status) === -1 && t.owner_account).forEach(t => {
    const light = taskLight_(t, today);
    if (light === '正常' || recent[t.owner_account + '|' + t.id]) return;
    (byOwner[t.owner_account] = byOwner[t.owner_account] || []).push(Object.assign({}, t, { light, project_name: open[t.project_id].name }));
  });
  const logs = [];
  let sent = 0;
  Object.keys(byOwner).forEach(account => {
    const person = people[account];
    if (!person || !person.email) return;
    const tasks = byOwner[account];
    const plain = tasks.map(t => '・[' + t.light + '] ' + t.project_name + '／' + t.title + (t.due_date ? '（截止 ' + t.due_date + '）' : '') + (t.next_step ? '　下一步：' + t.next_step : '')).join('\n');
    let summary = '';
    try {
      summary = AiService.callClaude_(CLAUDE_SUMMARY_MODEL_, '你是專案助理。用繁體中文寫 3 句以內的今日重點提醒：先講最急的，語氣友善具體，不要條列、不要客套。',
        plain, CLAUDE_SUMMARY_MAX_TOKENS_, 'summary.daily', null, ctx).text;
    } catch (e) {
      summary = ''; // 沒設金鑰或 AI 暫時失敗時，照樣寄出清單。
    }
    const worst = tasks.filter(t => t.light === '已逾期' && t.due_date && daysBetween_(t.due_date, today) >= escalate);
    const manager = person.manager_account && people[person.manager_account];
    MailApp.sendEmail({
      to: person.email,
      cc: worst.length && manager && manager.email ? manager.email : undefined,
      subject: '【imPR】今日待辦提醒：' + tasks.length + ' 件需要注意',
      body: (summary ? summary + '\n\n' : '') + plain + '\n\n請到公司系統更新狀態、最新進度與下一步。',
    });
    sent++;
    tasks.forEach(t => logs.push({ account, ref_id: t.id, reason: t.light, sent_on: today }));
  });
  withScriptLock_(() => repo_('reminder_log').insertMany(logs, 'system'));
  return { sent, tasks: logs.length };
}

/** 每週五寄給 admin 與主管：專案燈號、毛利警示、待審項目、各人逾期件數。 */
function runWeeklyReport() {
  const today = todayIso_();
  const ctx = { account: 'system', role: ROLES.ADMIN };
  const list = ProjectService.list(ctx).filter(p => p.light);
  const lines = list.map(p => '・' + p.light + ' ' + p.code + ' ' + p.name + '：完成 ' + p.stats.done + '/' + p.stats.total +
    (p.stats.overdue ? '，逾期 ' + p.stats.overdue : '') + (p.stats.blocked ? '，卡關 ' + p.stats.blocked : '') +
    (p.margin_alert ? '，毛利警示 ' + Math.round((p.margin_rate || 0) * 100) + '%' : ''));
  const pendingExpenses = repo_('expense_claims').findWhere(e => e.status === EXPENSE_STATUS.SUBMITTED).length;
  const facts = '日期：' + today + '\n進行中專案：\n' + lines.join('\n') + '\n待主管核准請款：' + pendingExpenses + ' 筆';
  let summary = '';
  try {
    summary = AiService.callClaude_(CLAUDE_SUMMARY_MODEL_, '你是營運長的助理。用繁體中文寫一段 5 句以內的本週重點：哪些專案有風險、要主管介入什麼。只根據提供的事實。',
      facts, CLAUDE_SUMMARY_MAX_TOKENS_, 'summary.weekly', null, ctx).text;
  } catch (e) {
    summary = '';
  }
  const people = repo_('people').findAll();
  const managers = {};
  people.forEach(p => { if (p.manager_account) managers[p.manager_account] = true; });
  const to = people.filter(p => p.active !== false && p.email && managers[p.account]).map(p => p.email);
  if (to.length) MailApp.sendEmail({ to: to.join(','), subject: '【imPR】每週專案報告 ' + today, body: (summary ? summary + '\n\n' : '') + facts });
  return { recipients: to.length };
}

/** 從 Apps Script 編輯器手動執行一次：每天 08:30 寄提醒、每週五 17:00 寄週報。可重複執行。 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['runDailyReminders', 'runWeeklyReport'].indexOf(t.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runDailyReminders').timeBased().everyDays(1).atHour(8).nearMinute(30).create();
  ScriptApp.newTrigger('runWeeklyReport').timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(17).create();
}

function aiRoutes_() {
  return {
    'ai.forms': { roles: INTERNAL_ROLES_, handler: () => aiFormsForClient_() },
    'ai.generateDocument': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      AiService.generateDocument(requireString_(p, 'kind'), p.project_id || null, p.values || {}, ctx, p.research || null) },
    'ai.researchClient': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      AiService.researchClient(requireString_(p, 'client_unit'), p.client_site || null, p.kind || 'press_release', p.project_id || null, ctx) },
    'ai.design': { roles: INTERNAL_ROLES_, handler: (p, ctx) => AiService.design(p.project_id || null, p.values || {}, ctx) },
    'ai.designImage': { roles: INTERNAL_ROLES_, handler: (p, ctx) =>
      AiService.designImage(requireString_(p, 'prompt'), p.ratio || null, p.project_id || null, ctx) },
    'ai.usage': { roles: [ROLES.ADMIN], handler: () => AiService.usageThisMonth() },
  };
}
