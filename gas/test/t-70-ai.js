/** AI：文件產出、用量上限、拒絕處理、每日提醒。 */
module.exports = (test, { assert }) => {
  const day = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

  test('[AI] 沒設金鑰時給明確訊息', ({ call }) => {
    const { project } = call('hazel', 'project.create', { record: { name: '論壇' } });
    assert.throws(() => call('hazel', 'ai.generateDocument', { kind: 'press_release', project_id: project.id }), e => /ANTHROPIC_API_KEY/.test(e.message));
  });

  test('[AI] 新聞稿：帶專案資料、用 Sonnet 加伺服器端備援、不含毛利；存成 Google 文件並記用量', (env) => {
    const { call, properties, aiCalls, docs, app } = env;
    properties.ANTHROPIC_API_KEY = 'test-key';
    const { project } = call('hazel', 'project.create', { record: { name: '2027 醫學年會', client_name: '醫學會', contract_amount: 999999 } });
    const r = call('hazel', 'ai.generateDocument', { kind: 'press_release', project_id: project.id, extra: '貴賓：部長' });
    const req = aiCalls[0];
    assert.strictEqual(req.body.model, 'claude-sonnet-5-5');
    assert.strictEqual(req.body.fallbacks, 'default');
    assert.strictEqual(req.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.strictEqual(req.headers['anthropic-version'], '2026-10-21');
    assert.match(req.body.messages[0].content, /醫學會/);
    assert.doesNotMatch(req.body.messages[0].content, /999999/);
    assert.strictEqual(docs[0].paras[0].h, 'H1');
    assert.match(r.url, /docs\.google\.com/);
    const job = app.repo_('ai_jobs').findAll()[0];
    assert.strictEqual(job.input_tokens, 100);
    assert.strictEqual(job.output_url, r.url);
  });

  test('[AI] 拒絕回應、超過月用量都擋下並記錄', (env) => {
    const { call, properties, app } = env;
    properties.ANTHROPIC_API_KEY = 'test-key';
    const { project } = call('hazel', 'project.create', { record: { name: '論壇' } });
    env.aiHandler = () => ({ type: 'message', stop_reason: 'refusal', content: [], usage: { input_tokens: 10, output_tokens: 0 } });
    assert.throws(() => call('hazel', 'ai.generateDocument', { kind: 'speech', project_id: project.id }), e => /拒絕/.test(e.message));
    assert.strictEqual(app.repo_('ai_jobs').findAll()[0].status, 'refused');
    app.withScriptLock_(() => {
      const s = app.repo_('settings').findAll().find(x => x.key === 'ai_monthly_token_limit');
      app.repo_('settings').updateMany({ [s.id]: { value: '5' } }, 'boss');
    });
    assert.throws(() => call('hazel', 'ai.generateDocument', { kind: 'speech', project_id: project.id }), e => /用量已達上限/.test(e.message));
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
  test('[AI] 平面設計：Claude 寫文案、OpenAI GPT 生圖，尺寸依比例換算並記用量', (env) => {
    const { call, properties, aiCalls } = env;
    properties.ANTHROPIC_API_KEY = 'test-key';
    const plan = { headline: '主標', subheadline: '副標', copy: '文案', concept: '概念', image_prompt: 'calm harbor at dawn' };
    env.aiHandler = (body, url) => /openai/.test(url)
      ? { data: [{ b64_json: 'iVBORw0KGgo=' }], usage: { input_tokens: 30, output_tokens: 4000 } }
      : { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(plan) }], usage: { input_tokens: 100, output_tokens: 50 } };
    assert.throws(() => call('hazel', 'ai.design', { title: '年會', size: '9:16' }), e => /OPENAI_API_KEY/.test(e.message));
    properties.OPENAI_API_KEY = 'sk-test';
    const r = call('hazel', 'ai.design', { title: '年會', size: '9:16' });
    assert.strictEqual(r.plan.headline, '主標');
    assert.deepStrictEqual(r.image, { mimeType: 'image/png', base64: 'iVBORw0KGgo=' });
    const img = aiCalls.find(c => /api\.openai\.com\/v1\/images\/generations/.test(c.url));
    assert.ok(img, '有呼叫 OpenAI 生圖');
    assert.strictEqual(img.headers.Authorization, 'Bearer sk-test');
    assert.strictEqual(img.body.model, 'gpt-image-1');
    assert.strictEqual(img.body.size, '1024x1536');
    assert.match(img.body.prompt, /calm harbor/);
    assert.ok(!aiCalls.some(c => /googleapis/.test(c.url)), '不再呼叫 Gemini');
    const usage = call('boss', 'ai.usage', {});
    assert.strictEqual(usage.tokens, 300 + 4030);
  });

  test('[AI] GPT 生圖尺寸換算', ({ app }) => {
    assert.strictEqual(app.openAiImageSize_('16:9'), '1536x1024');
    assert.strictEqual(app.openAiImageSize_('1:1'), '1024x1024');
    assert.strictEqual(app.openAiImageSize_('4:5'), '1024x1536');
    assert.strictEqual(app.openAiImageSize_('3:4'), '1024x1536');
    assert.strictEqual(app.openAiImageSize_('1920x1080'), '1536x1024');
  });
};
