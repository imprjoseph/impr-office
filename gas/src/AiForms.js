/**
 * AI 文件與平面設計的填寫欄位：同仁逐項填（能選的就用選的），後端把填好的項目整理成條列交給 AI。
 * 欄位定義只放這裡，前端照這份畫表單，後端照這份檢查必填、只收認得的欄位。
 * 每種都附「範本」：按一下帶入示範內容，同仁照著改就好。
 *
 * type：text、textarea、select（單選）、multi（複選）、date、number。
 * fromProject：選了專案時，從專案資料自動帶入（同仁可改）。
 */

const AUDIENCES_ = ['政府機關', '企業主管', '醫療專業人員', '學術研究人員', '產業從業人員', '學生青年', '一般民眾', '媒體記者', '國際貴賓'];
const TONES_ = ['正式莊重', '專業親切', '溫暖感性', '活潑年輕', '國際大氣'];

// 文件共用的活動基本資料
const AI_CLIENT_FIELDS_ = [
  { name: 'client_unit', label: '客戶單位（委託本司的單位全名）', type: 'text', required: true, fromProject: 'client_name', research: true },
  { name: 'client_site', label: '客戶官網或新聞稿頁網址', type: 'text', placeholder: '選填；填了 AI 會優先參考這裡的既有新聞稿' },
];

const DOC_BASE_FIELDS_ = [
  { name: 'event_name', label: '活動名稱', type: 'text', required: true, fromProject: 'name' },
  { name: 'organizer', label: '主辦單位', type: 'text', required: true, fromProject: 'client_name' },
  { name: 'co_organizers', label: '協辦／指導單位', type: 'text', placeholder: '多個單位用頓號分隔' },
  { name: 'event_date', label: '活動日期', type: 'date', fromProject: 'start_date' },
  { name: 'venue', label: '地點', type: 'text', fromProject: 'venue' },
  { name: 'audience', label: '目標對象', type: 'multi', options: AUDIENCES_ },
  { name: 'tone', label: '語氣', type: 'select', options: TONES_ },
];

const AI_DOC_FORMS_ = {
  press_release: {
    research: true,
    fields: AI_CLIENT_FIELDS_.concat(DOC_BASE_FIELDS_, [
      { name: 'timing', label: '發布時機', type: 'select', required: true, options: ['活動前預告', '活動當天發布', '活動後成果'] },
      { name: 'key_points', label: '新聞重點（一行一點）', type: 'textarea', required: true, placeholder: '最多三點，最重要的放第一行' },
      { name: 'quote_person', label: '引述人姓名與職稱', type: 'text', placeholder: '例如：衛生福利部 王○○ 部長' },
      { name: 'quote_point', label: '引述想表達的重點', type: 'textarea' },
      { name: 'figures', label: '關鍵數據', type: 'textarea', placeholder: '參與人數、國家數、場次、成果數字…沒有就留空，AI 不會自己編' },
      { name: 'length', label: '字數', type: 'select', options: ['約 600 字', '約 800 字', '約 1200 字'] },
      { name: 'contact', label: '新聞聯絡人', type: 'text', placeholder: '姓名、電話、Email' },
    ]),
    template: {
      client_unit: '台灣腎臟醫學會', client_site: '',
      event_name: '2027 台灣早期慢性腎臟病照護國際論壇', organizer: '台灣腎臟醫學會', co_organizers: '衛生福利部國民健康署',
      event_date: '2027-03-20', venue: '台大醫院國際會議中心', audience: ['醫療專業人員', '政府機關', '媒體記者'], tone: '專業親切',
      timing: '活動當天發布', key_points: '十國專家分享早期腎病篩檢經驗\n發表台灣早期 CKD 照護成果\n宣布明年全國篩檢推廣計畫',
      quote_person: '台灣腎臟醫學會 理事長', quote_point: '早期發現、早期介入，可大幅降低洗腎人數',
      figures: '參與人數約 500 人；10 個國家；3 場專題論壇', length: '約 800 字', contact: '新動力公關 王小姐 02-1234-5678',
    },
  },
  speech: {
    research: true,
    fields: AI_CLIENT_FIELDS_.concat(DOC_BASE_FIELDS_, [
      { name: 'speaker', label: '致詞人姓名與職稱', type: 'text', required: true },
      { name: 'role', label: '致詞身分', type: 'select', required: true, options: ['主辦單位長官', '指導單位長官', '貴賓', '協辦單位', '閉幕致詞'] },
      { name: 'duration', label: '長度', type: 'select', required: true, options: ['1 分鐘（約 250 字）', '3 分鐘（約 750 字）', '5 分鐘（約 1200 字）'] },
      { name: 'thanks', label: '要感謝的貴賓與單位', type: 'textarea', placeholder: '依致詞時的稱謂順序，一行一位' },
      { name: 'messages', label: '想傳達的重點（一行一點）', type: 'textarea', required: true },
      { name: 'style', label: '致詞風格', type: 'multi', options: ['引用數據', '分享小故事', '展望未來', '呼籲行動', '幽默輕鬆'] },
    ]),
    template: {
      client_unit: '經濟部產業發展署', client_site: '',
      event_name: '2027 智慧醫療創新論壇', organizer: '經濟部產業發展署', event_date: '2027-05-12', venue: '台北國際會議中心',
      audience: ['產業從業人員', '政府機關'], tone: '正式莊重', speaker: '經濟部產業發展署 署長', role: '主辦單位長官',
      duration: '3 分鐘（約 750 字）', thanks: '衛生福利部 次長\n各位產業先進\n與會貴賓',
      messages: '台灣智慧醫療產值逐年成長\n政府將持續推動跨域合作\n期待產學研共同打造國際品牌', style: ['引用數據', '展望未來'],
    },
  },
  proposal: {
    fields: [
      { name: 'event_name', label: '標案名稱', type: 'text', required: true, fromProject: 'name' },
      { name: 'organizer', label: '招標機關', type: 'text', required: true, fromProject: 'client_name' },
      { name: 'budget', label: '預算金額（元）', type: 'number' },
      { name: 'event_date', label: '履約期間或活動日期', type: 'text', fromProject: 'start_date' },
      { name: 'requirements', label: '需求書重點（工作項目，一行一項）', type: 'textarea', required: true },
      { name: 'criteria', label: '評選重點', type: 'multi', options: ['計畫可行性與執行策略', '創意與整體規劃', '團隊專業與經驗', '過去實績', '價格合理性', '在地資源整合', '媒體與宣傳效益', '簡報與答詢'] },
      { name: 'strengths', label: '本司優勢', type: 'multi', options: ['國際會議籌辦經驗', '政府標案實績', '醫療學會合作資源', '媒體公關關係', '設計製作團隊', '數位與社群行銷', '同步口譯與國際接待', '在地供應商網絡'] },
      { name: 'cases', label: '類似實績（一行一案）', type: 'textarea', placeholder: '年度、案名、機關、規模；沒有就留空，AI 不會自己編' },
      { name: 'team', label: '預計投入人力', type: 'textarea', placeholder: '例如：專案經理 1、執行 3、設計 1' },
    ],
    template: {
      event_name: '2027 防詐宣導整合行銷委託服務案', organizer: '電信技術中心', budget: 2400000, event_date: '決標日起至 2027-12-15',
      requirements: '防詐主視覺與宣導素材設計\n社群平台經營 6 個月\n大型宣導活動 1 場\n媒體露出 20 則以上\n成效報告',
      criteria: ['計畫可行性與執行策略', '創意與整體規劃', '媒體與宣傳效益'], strengths: ['政府標案實績', '媒體公關關係', '數位與社群行銷'],
      cases: '2025 反詐騙全民宣導活動（○○部）約 300 萬', team: '專案經理 1、活動執行 2、設計 1、社群 1',
    },
  },
  closing_report: {
    needsProject: true,
    fields: DOC_BASE_FIELDS_.concat([
      { name: 'attendance', label: '實際參與人數', type: 'text' },
      { name: 'media', label: '媒體露出', type: 'textarea', placeholder: '則數、主要媒體' },
      { name: 'satisfaction', label: '滿意度調查結果', type: 'text' },
      { name: 'highlights', label: '成功經驗（一行一點）', type: 'textarea' },
      { name: 'issues', label: '待改進事項（一行一點）', type: 'textarea' },
      { name: 'next', label: '後續建議', type: 'textarea' },
    ]),
    template: {
      event_name: '資策會淨零研討會', organizer: '資策會數轉院', event_date: '2026-11-25', venue: '台大醫院國際會議中心',
      audience: ['產業從業人員', '政府機關'], tone: '專業親切', attendance: '報名 420 人、實到 365 人（出席率 87%）',
      media: '12 則，含經濟日報、工商時報', satisfaction: '整體滿意度 4.6／5',
      highlights: '報到動線分流，十分鐘內完成報到\n講者簡報提前一週收齊', issues: '午餐發放等候過久\n同步口譯耳機數量不足', next: '明年可增設線上直播',
    },
  },
};

const AI_DESIGN_FORM_ = {
  fields: [
    { name: 'event_name', label: '活動名稱', type: 'text', required: true, fromProject: 'name' },
    { name: 'organizer', label: '主辦單位', type: 'text', fromProject: 'client_name' },
    { name: 'usage', label: '用途', type: 'select', required: true, options: ['主視覺 KV', '舞台背板', '海報', '社群貼文', 'EDM 橫幅', '識別證', '邀請函'] },
    { name: 'ratio', label: '比例', type: 'select', required: true, options: ['16:9 橫式', '1:1 方形', '4:5 直式', '9:16 直式', '3:4 直式', 'A 系列直式'] },
    { name: 'field', label: '產業領域', type: 'select', options: ['醫療健康', '科技與 AI', '永續淨零', '文化藝術', '政府政策', '金融經濟', '教育', '觀光地方'] },
    { name: 'theme', label: '活動主題與想傳達的訊息', type: 'textarea', required: true },
    { name: 'styles', label: '風格', type: 'multi', options: ['沉穩專業', '科技未來', '溫暖人文', '清新自然', '國際大氣', '活潑年輕', '極簡留白', '東方意象'] },
    { name: 'colors', label: '主色', type: 'multi', options: ['深藍', '暖金', '綠色', '橘色', '紅色', '紫色', '灰黑', '白色', '依主辦單位 CI'] },
    { name: 'elements', label: '想出現的元素', type: 'textarea', placeholder: '例如：台灣意象、腎臟抽象線條、城市天際線' },
    { name: 'avoid', label: '要避免的', type: 'textarea', placeholder: '例如：電路板紋路、過度光暈、人物臉部特寫' },
  ],
  template: {
    event_name: '2027 台灣早期慢性腎臟病照護國際論壇', organizer: '台灣腎臟醫學會', usage: '主視覺 KV', ratio: '16:9 橫式', field: '醫療健康',
    theme: '早期發現、早期守護：串連國際專家，讓腎臟照護走在病程前面', styles: ['沉穩專業', '溫暖人文', '國際大氣'], colors: ['深藍', '暖金'],
    elements: '抽象的腎臟輪廓化為守護的雙手、晨光、台灣島形', avoid: '醫院走廊照片、針筒、電路板紋路、過度光暈',
  },
};

/** 給前端畫表單用。 */
function aiFormsForClient_() {
  return {
    docs: Object.keys(AI_DOC_KINDS).map(k => ({ kind: k, label: AI_DOC_KINDS[k].label, needsProject: !!AI_DOC_FORMS_[k].needsProject,
      research: !!AI_DOC_FORMS_[k].research,
      fields: AI_DOC_FORMS_[k].fields, template: AI_DOC_FORMS_[k].template })),
    design: AI_DESIGN_FORM_,
  };
}

/** 檢查必填、只收認得的欄位、值要在選項裡，整理成「・項目：值」條列。 */
function aiFormBrief_(fields, values) {
  const v = values || {};
  const lines = [];
  fields.forEach(f => {
    let x = v[f.name];
    if (f.type === 'multi') {
      x = Array.isArray(x) ? x.map(String).filter(s => f.options.indexOf(s) !== -1) : [];
      if (f.required && !x.length) throw new AppError(ERROR_CODES.VALIDATION, '請選擇「' + f.label + '」');
      if (x.length) lines.push('・' + f.label + '：' + x.join('、'));
      return;
    }
    x = x === null || x === undefined ? '' : String(x).trim();
    if (f.required && !x) throw new AppError(ERROR_CODES.VALIDATION, '請填寫「' + f.label + '」');
    if (!x) return;
    if (f.type === 'select' && f.options.indexOf(x) === -1) throw new AppError(ERROR_CODES.VALIDATION, '「' + f.label + '」的選項不正確');
    if (x.length > 3000) throw new AppError(ERROR_CODES.VALIDATION, '「' + f.label + '」太長，請精簡到 3000 字內');
    lines.push(x.indexOf('\n') !== -1 ? '・' + f.label + '：\n  - ' + x.split('\n').map(s => s.trim()).filter(Boolean).join('\n  - ') : '・' + f.label + '：' + x);
  });
  return lines.join('\n');
}
