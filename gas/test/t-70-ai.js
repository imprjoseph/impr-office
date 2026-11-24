/** AI：文件產出、用量上限、拒絕處理、每日提醒。 */
module.exports = (test, { assert }) => {
  const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  test('[AI] 沒設金鑰時給明確訊息', ({ call }) => {
    const { project } = call('hazel', 'project.create', { record: { name: '論壇' } });
    assert.throws(() => call('hazel', 'ai.generateDocument', { kind: 'press_release', project_id: project.id, values: { client_unit: '台灣醫學會', event_name: '2027 醫學年會', organizer: '醫學會', timing: '活動當天發布', key_points: '十國專家\n成果發表' } }), e => /ANTHROPIC_API_KEY/.test(e.message));
  });

  test('[AI] 新聞稿：帶專案資料、用 Sonnet 加伺服器端備援、不含毛利；存成 Google 文件並記用量', (env) => {
    const { call, properties, aiCalls, docs, app } = env;
    properties.ANTHROPIC_API_KEY = 'test-key';
    const { project } = call('hazel', 'project.create', { record: { name: '2027 醫學年會', client_name: '醫學會', contract_amount: 999999 } });
    const r = call('hazel', 'ai.generateDocument', { kind: 'press_release', project_id: project.id, values: { client_unit: '台灣醫學會', event_name: '2027 醫學年會', organizer: '醫學會', timing: '活動當天發布', key_points: '十國專家\n成果發表' } });
    const req = aiCalls[0];
    assert.strictEqual(req.body.model, 'claude-sonnet-5-5');
    assert.strictEqual(req.body.fallbacks, 'default');
    assert.strictEqual(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.strictEqual(req.headers['anthropic-version'], '2026-10-21');
    assert.match(req.body.messages[0].content, /醫學會/);
    assert.match(req.body.messages[0].content, /・發布時機：活動當天發布/);
    assert.match(req.body.messages[0].content, /  - 成果發表/);
    assert.doesNotMatch(req.body.messages[0].content, /999999/);
    assert.strictEqual(docs[0].paras[0].h, 'H1');
    assert.match(r.url, /docs\.google\.com/);
    const job = app.repo_('ai_jobs').findAll()[0];
    assert.strictEqual(job.input_tokens, 100);
    assert.strictEqual(job.output_url, r.url);
  });

  test('[AI] 查客戶單位：用網路搜尋、接續 pause_turn、整理來源；寫稿時帶入查詢結果並要求說明客戶單位', (env) => {
    const { call, properties, aiCalls, app } = env;
    properties.ANTHROPIC_API_KEY = 'test-key';
    let n = 0;
    env.aiHandler = body => {
      n++;
      if (body.tools && n === 1) return { type: 'message', stop_reason: 'pause_turn', usage: { input_tokens: 10, output_tokens: 5 },
        content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: '國健署 新聞稿' } },
          { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://www.hpa.gov.tw/news/1', title: '國健署新聞' }] }] };
      if (body.tools) return { type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 20, output_tokens: 30 },
        content: [{ type: 'text', text: '## 單位簡介\n國民健康署是…', citations: [{ type: 'web_search_result_location', url: 'https://www.hpa.gov.tw/about', title: '關於本署' }] }] };
      return { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: '# 新聞稿' }], usage: { input_tokens: 100, output_tokens: 50 } };
    };
    const r = call('hazel', 'ai.researchClient', { client_unit: '衛生福利部國民健康署', client_site: 'https://www.hpa.gov.tw', kind: 'press_release' });
    assert.match(r.text, /國民健康署/);
    assert.deepStrictEqual(r.sources.map(x => x.url), ['https://www.hpa.gov.tw/about', 'https://www.hpa.gov.tw/news/1']);
    assert.strictEqual(aiCalls[0].body.tools[0].type, 'web_search_20260209');
    assert.match(aiCalls[0].body.messages[0].content, /hpa\.gov\.tw/);
    assert.strictEqual(aiCalls[1].body.messages[1].role, 'assistant');
    assert.strictEqual(aiCalls[1].body.messages.length, 2);
    const job = app.repo_('ai_jobs').findAll().find(j => j.kind === 'research.client');
    assert.strictEqual(job.input_tokens, 30);

    call('hazel', 'ai.generateDocument', { kind: 'press_release', research: r.text,
      values: { client_unit: '衛生福利部國民健康署', event_name: '健康論壇', organizer: '國健署', timing: '活動前預告', key_points: '重點' } });
    const doc = aiCalls[aiCalls.length - 1].body;
    assert.ok(!doc.tools);
    assert.match(doc.messages[0].content, /・客戶單位（委託本司的單位全名）：衛生福利部國民健康署/);
    assert.match(doc.messages[0].content, /網路查詢結果[\s\S]*國民健康署是/);
    assert.match(doc.system, /說明客戶單位/);
    assert.throws(() => call('hazel', 'ai.researchClient', { client_unit: '' }), /client_unit|客戶單位/);
  });

  test('[AI] 拒絕回應、超過月用量都擋下並記錄', (env) => {
    const { call, properties, app } = env;
    properties.ANTHROPIC_API_KEY = 'test-key';
    const { project } = call('hazel', 'project.create', { record: { name: '論壇' } });
    env.aiHandler = () => ({ type: 'message', stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 } });
    assert.throws(() => call('hazel', 'ai.generateDocument', { kind: 'speech', project_id: project.id, values: { client_unit: '學會', event_name: '年會', organizer: '學會', speaker: '理事長', role: '貴賓', duration: '1 分鐘（約 250 字）', messages: '感謝' } }), e => /拒絕/.test(e.message));
    assert.strictEqual(app.repo_('ai_jobs').findAll()[0].status, 'refused');
    app.withScriptLock_(() => {
      const s = app.repo_('settings').findAll().find(x => x.key === 'ai_monthly_token_limit');
      app.repo_('settings').updateMany({ [s.id]: { value: '5' } }, 'boss');
    });
    assert.throws(() => call('hazel', 'ai.generateDocument', { kind: 'speech', project_id: project.id, values: { client_unit: '學會', event_name: '年會', organizer: '學會', speaker: '理事長', role: '貴賓', duration: '1 分鐘（約 250 字）', messages: '感謝' } }), e => /用量已達上限/.test(e.message));
  });

  test('[提醒] 每日提醒：只寄有狀況的工作、冷卻期內不重寄、逾期太久副本主管；沒金鑰也照寄', ({ app, call, mails }) => {
    call('boss', 'people.sync');
    const { project } = call('hazel', 'project.create', { record: { name: '論壇', start_date: day(30), end_date: day(30) } });
    call('hazel', 'task.create', { project_id: project.id, record: { title: '早該完成', owner_account: 'amy', due_date: day(-5) } });
    call('hazel', 'task.create', { project_id: project.id, record: { title: '還早', owner_account: 'amy', due_date: day(20) } });
    const r = app.runDailyReminders();
    assert.strictEqual(r.sent, 1);
    assert.strictEqual(mails[0].to, 'amy@impr.com.tw');
    assert.strictEqual(mails[0].cc, 'mgr@impr.com.tw');
    assert.match(mails[0].body, /早該完成/);
    assert.doesNotMatch(mails[0].body, /還早/);
    assert.strictEqual(app.runDailyReminders().sent, 0);
  });
  test('[提醒] 每日提醒：保管的資材該保養也寄給保管人；冷卻期內不重寄；沒保管人不寄', ({ app, call, mails }) => {
    call('boss', 'people.sync');
    call('hazel', 'inventory.create', { record: { name: '投影機', code: 'P-1', quantity: 1, category: '投影簡報', manager_account: 'amy', needs_maintenance: true, maintenance_cycle_days: 30, maintenance_note: '清濾網' } });
    call('hazel', 'inventory.create', { record: { name: '無人保管', quantity: 1, category: '投影簡報', needs_maintenance: true } });
    const ok = call('hazel', 'inventory.create', { record: { name: '剛保養', quantity: 1, category: '投影簡報', manager_account: 'amy', needs_maintenance: true, maintenance_cycle_days: 30 } });
    call('amy', 'maintenance.add', { record: { inventory_id: ok.id, kind: '定期保養', content: '清潔' } });
    const r = app.runDailyReminders();
    assert.deepStrictEqual([r.sent, r.maintenance], [1, 1]);
    assert.strictEqual(mails[0].to, 'amy@impr.com.tw');
    assert.match(mails[0].subject, /1 項資材要保養/);
    assert.match(mails[0].body, /未保養過\] 投影機（P-1）.*清濾網/);
    assert.doesNotMatch(mails[0].body, /剛保養|無人保管/);
    assert.strictEqual(app.runDailyReminders().sent, 0);
  });
  test('[會議] AI 整理：摘要、決議、待辦；負責人只能是公司人員、日期格式不對就留空；紀錄太短擋下', (env) => {
    const { call, properties } = env;
    properties.ANTHROPIC_API_KEY = 'test-key';
    call('boss', 'people.sync');
    env.aiHandler = () => ({ type: 'message', stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: '```json\n' + JSON.stringify({
      summary: '主視覺定稿', decisions: ['採 B 案'], actions: [{ title: '修圖', owner_account: 'amy', due_date: '2026-12-01' }, { title: '問場地', owner_account: 'stranger', due_date: '下週' }], next_meeting_date: 'x' }) + '\n```' }] });
    assert.throws(() => call('hazel', 'ai.meetingSummary', { notes: '太短' }), /太短/);
    const r = call('hazel', 'ai.meetingSummary', { notes: '今天討論主視覺，大家同意採用 B 案，Amy 負責修圖，12/1 前交。另外要問場地。', title: '進度會議' });
    assert.strictEqual(r.summary, '主視覺定稿');
    assert.deepStrictEqual(r.decisions, ['採 B 案']);
    assert.deepStrictEqual(r.actions, [{ title: '修圖', owner_account: 'amy', due_date: '2026-12-01' }, { title: '問場地', owner_account: '', due_date: '' }]);
    assert.strictEqual(r.next_meeting_date, '');
  });

  test('[會議] 彙整：列表附待辦統計；查單場含待辦；會後追加待辦；待辦總表只列未完成；刪會議保留工作', ({ call, app }) => {
    const { project } = call('hazel', 'project.create', { record: { name: '年會' } });
    const r = call('hazel', 'meeting.create', { meeting: { project_id: project.id, title: '第一次進度會議', meeting_date: '2026-11-20', meeting_type: '進度會議', summary: '確認分工', decisions: '採 B 案' },
      tasks: [{ title: '修圖', owner_account: 'amy', due_date: '2000-01-01' }, { title: '訂場地', owner_account: 'hazel' }] });
    assert.throws(() => call('hazel', 'meeting.create', { meeting: { title: 'x', meeting_date: '2026-11-20', meeting_type: '亂寫' }, tasks: [] }), /會議類型/);
    let list = call('hazel', 'meeting.list');
    assert.deepStrictEqual([list[0].project_name, list[0].task_total, list[0].task_open, list[0].task_overdue], ['年會', 2, 2, 1]);
    call('amy', 'meeting.addTasks', { meeting_id: r.meeting.id, tasks: [{ title: '寄會議摘要給客戶', owner_account: 'amy' }] });
    const got = call('hazel', 'meeting.get', { id: r.meeting.id });
    assert.strictEqual(got.tasks.length, 3);
    const t0 = got.tasks.find(t => t.title === '修圖');
    call('amy', 'task.update', { id: t0.id, expectedUpdatedAt: t0.updated_at, patch: { status: '已完成' } });
    assert.strictEqual(call('hazel', 'meeting.actionItems', {}).length, 2);
    assert.strictEqual(call('hazel', 'meeting.actionItems', { includeDone: true }).length, 3);
    const m = call('hazel', 'meeting.update', { id: r.meeting.id, expectedUpdatedAt: r.meeting.updated_at, patch: { summary: '確認分工與主視覺' } });
    assert.strictEqual(m.summary, '確認分工與主視覺');
    assert.throws(() => call('amy', 'meeting.delete', { id: m.id, expectedUpdatedAt: m.updated_at }), /建立的人/);
    assert.strictEqual(call('hazel', 'meeting.delete', { id: m.id, expectedUpdatedAt: m.updated_at }).tasks_kept, 3);
    assert.strictEqual(app.repo_('project_tasks').findWhere(t => t.project_id === project.id && t.title === '修圖').length, 1);
    assert.strictEqual(call('hazel', 'meeting.list').length, 0);
  });

  test('[AI] 平面設計：Claude 寫文案與 GPT 提示詞；再把提示詞交給 GPT 出圖，尺寸依比例換算並記用量', (env) => {
    const { call, properties, aiCalls } = env;
    properties.ANTHROPIC_API_KEY = 'test-key';
    const plan = { headline: '主標', subheadline: '副標', copy: '文案', concept: '概念', prompt: 'calm harbor at dawn', prompt_zh: '港灣', negative: 'text', variations: ['a', 'b'] };
    env.aiHandler = (body, url) => /openai/.test(url)
      ? { data: [{ b64_json: 'iVBORw0KGgo=' }], usage: { input_tokens: 30, output_tokens: 4000 } }
      : { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: '```json\n' + JSON.stringify(plan) + '\n```' }], usage: { input_tokens: 100, output_tokens: 50 } };
    const values = { event_name: '年會', usage: '海報', ratio: 'A 系列直式', theme: '守護', styles: ['沉穩專業', '亂填'] };
    const r = call('hazel', 'ai.design', { values });
    assert.deepStrictEqual(r.plan, plan);
    assert.strictEqual(aiCalls.length, 1);
    assert.match(aiCalls[0].body.system, /GPT/);
    assert.match(aiCalls[0].body.messages[0].content, /・風格：沉穩專業$/);
    assert.doesNotMatch(aiCalls[0].body.messages[0].content, /亂填/);

    assert.throws(() => call('hazel', 'ai.designImage', { prompt: r.plan.prompt, ratio: values.ratio }), e => /OPENAI_API_KEY/.test(e.message));
    properties.OPENAI_API_KEY = 'sk-test';
    const img = call('hazel', 'ai.designImage', { prompt: r.plan.prompt, ratio: values.ratio });
    assert.deepStrictEqual(img.image, { mimeType: 'image/png', base64: 'iVBORw0KGgo=' });
    const req = aiCalls.find(c => /api\.openai\.com\/v1\/images\/generations/.test(c.url));
    assert.strictEqual(req.headers.Authorization, 'Bearer sk-test');
    assert.strictEqual(req.body.model, 'gpt-image-1');
    assert.strictEqual(req.body.size, '1024x1536');
    assert.match(req.body.prompt, /calm harbor/);
    assert.strictEqual(call('boss', 'ai.usage', {}).tokens, 150 + 4030);
  });

  test('[AI] GPT 生圖尺寸換算', ({ app }) => {
    assert.strictEqual(app.openAiImageSize_('16:9 橫式'), '1536x1024');
    assert.strictEqual(app.openAiImageSize_('1:1 方形'), '1024x1024');
    assert.strictEqual(app.openAiImageSize_('4:5 直式'), '1024x1536');
    assert.strictEqual(app.openAiImageSize_('A 系列直式'), '1024x1536');
    assert.strictEqual(app.openAiImageSize_('1920x1080'), '1536x1024');
  });

  test('[AI] 表單：必填、選項檢查；結案報告要選專案；範本本身能通過檢查', (env) => {
    const { call, properties, app } = env;
    properties.ANTHROPIC_API_KEY = 'test-key';
    assert.throws(() => call('hazel', 'ai.design', { values: { event_name: '年會', usage: '海報', ratio: '4:5 直式' } }), /主題/);
    assert.throws(() => call('hazel', 'ai.design', { values: { event_name: '年會', usage: '亂填', ratio: '4:5 直式', theme: 'x' } }), /選項不正確/);
    assert.throws(() => call('hazel', 'ai.generateDocument', { kind: 'closing_report', values: { event_name: 'x', organizer: 'y' } }), /選擇專案/);
    const forms = call('hazel', 'ai.forms', {});
    assert.deepStrictEqual(forms.docs.map(d => d.kind), ['press_release', 'speech', 'proposal', 'closing_report']);
    forms.docs.forEach(d => app.aiFormBrief_(d.fields, d.template));
    app.aiFormBrief_(forms.design.fields, forms.design.template);
    assert.throws(() => call('pt1', 'ai.forms', {}), /權限/);
  });
};
