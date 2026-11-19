import { useState } from "react";
import { call } from "../api";
import { Badge, Field, Loading, Modal, Page, RecordForm, Table, Tabs, money, pct, shortDate, useAction, useLoad, useLookups } from "../ui";

const PROJECT_FIELDS: Field[] = [
  { name: "name", label: "專案名稱", required: true, full: true },
  { name: "client_id", label: "客戶", type: "client" },
  { name: "client_name", label: "客戶／主辦單位（顯示名稱）" },
  { name: "project_type", label: "活動類型", type: "select", options: ["論壇", "研討會", "記者會", "展覽", "頒獎典禮", "訪查", "媒體宣傳", "教育訓練", "尾牙", "其他"] },
  { name: "venue", label: "地點" },
  { name: "start_date", label: "活動日期", type: "date", hint: "套用範本時，工作截止日以這天為 T 日" },
  { name: "end_date", label: "結束日期", type: "date" },
  { name: "pm_account", label: "PM", type: "person" },
  { name: "drive_folder_url", label: "專案資料夾網址", type: "url", full: true },
];
const FINANCE_FIELDS: Field[] = [
  { name: "contract_amount", label: "合約金額", type: "number" },
  { name: "margin_threshold", label: "毛利警示門檻（0.2 = 20%）", type: "number" },
];

export function ProjectList() {
  const lk = useLookups();
  const { data, error, loading, reload } = useLoad<any[]>("project.list");
  const [creating, setCreating] = useState(false);
  const [applyTemplate, setApplyTemplate] = useState(true);
  const [stage, setStage] = useState("進行中");
  const [q, setQ] = useState("");
  const { busy, run } = useAction();
  const closed = ["活動完成", "結案中", "已結案", "暫停"];
  const rows = (data || []).filter(p => (stage === "全部" || (stage === "進行中" ? !closed.includes(p.stage) : closed.includes(p.stage))) &&
    (!q || (p.name + p.code + (p.client_name || "")).toLowerCase().includes(q.toLowerCase())));
  const create = async (values: any) => {
    const r = await run(() => call<any>("project.create", { record: values, applyTemplate }), "已建立專案");
    if (r) { setCreating(false); lk.refresh(["projects"]); location.hash = "#/projects/" + r.project.id; }
  };
  return (
    <Page title="專案與工作" sub="一場活動一個專案；每天更新狀態、最新進度、下一步、卡關原因，燈號由系統計算。"
      actions={<button className="btn primary" onClick={() => setCreating(true)}>＋ 新增專案</button>}>
      <div className="toolbar">
        <Tabs tabs={[["進行中", "進行中"], ["已結束", "已結束"], ["全部", "全部"]]} value={stage} onChange={setStage} />
        <input type="search" placeholder="搜尋名稱、編號、客戶" value={q} onChange={e => setQ(e.target.value)} aria-label="搜尋專案" />
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && <Table rows={rows} onRow={p => { location.hash = "#/projects/" + p.id; }} columns={[
        { key: "light", label: "燈號", render: p => p.light ? <Badge text={p.light} /> : "—" },
        { key: "name", label: "專案", render: p => <><b>{p.name}</b><small className="muted block">{p.code}・{p.client_name || "—"}</small></> },
        { key: "start_date", label: "活動日", render: p => shortDate(p.start_date) },
        { key: "pm", label: "PM", render: p => lk.nameOf(p.pm_account), hideSm: true },
        { key: "stage", label: "階段", hideSm: true },
        { key: "progress", label: "完成", num: true, render: p => p.stats.done + "/" + p.stats.total },
        { key: "margin", label: "毛利", num: true, hideSm: true, render: p => p.margin_rate != null ? <span className={p.margin_alert ? "red" : ""}>{pct(p.margin_rate)}</span> : "—" },
      ]} empty="沒有符合的專案。" />}
      {creating && (
        <Modal title="新增專案" onClose={() => setCreating(false)}>
          <RecordForm fields={PROJECT_FIELDS.concat(lk.can("admin", "manager", "accountant") ? FINANCE_FIELDS : [])} initial={undefined}
            onSubmit={create} onCancel={() => setCreating(false)} busy={busy} submitLabel="建立"
            extra={<label className="check"><input type="checkbox" checked={applyTemplate} onChange={e => setApplyTemplate(e.target.checked)} /> 依 T-60 工作範本自動產生工作（需填活動日期）</label>} />
        </Modal>
      )}
    </Page>
  );
}

export function ProjectDetail({ id }: { id: string }) {
  const lk = useLookups();
  const { data, error, loading, reload } = useLoad<any>("project.get", { id });
  const opts = useLoad<any>("project.options");
  const [tab, setTab] = useState("tasks");
  const [editing, setEditing] = useState(false);
  const { busy, run } = useAction();
  if (!data) return <Page title="專案"><Loading error={error} loading={loading} /></Page>;
  const p = data.project;
  const saveProject = async (patch: any) => {
    const r = await run(() => call("project.update", { id: p.id, expectedUpdatedAt: p.updated_at, patch }), "已儲存");
    if (r) { setEditing(false); reload(); lk.refresh(["projects"]); }
  };
  const setStage = async (stage: string) => {
    const r = await run(() => call("project.setStage", { id: p.id, expectedUpdatedAt: p.updated_at, stage }), "已改成「" + stage + "」");
    if (r) reload();
  };
  return (
    <Page title={p.name} sub={p.code + "・" + (p.client_name || "客戶未填") + "・" + (p.start_date ? p.start_date.replace(/-/g, "/") : "日期未定") + (p.venue ? "・" + p.venue : "")}
      actions={<>
        <a className="btn" href="#/projects">← 專案列表</a>
        <select className="btn" value={p.stage} onChange={e => setStage(e.target.value)} aria-label="執行階段" disabled={busy}>
          {(opts.data?.stages || [p.stage]).map((s: string) => <option key={s}>{s}</option>)}
        </select>
        <button className="btn" onClick={() => setEditing(true)}>編輯專案</button>
      </>}>
      <div className="stats">
        <div className="stat">{p.light ? <Badge text={p.light} /> : <b>—</b>}<span>燈號</span></div>
        <div className="stat"><b>{p.stats.done}/{p.stats.total}</b><span>完成</span></div>
        <div className="stat"><b className={p.stats.overdue ? "red" : ""}>{p.stats.overdue}</b><span>逾期</span></div>
        <div className="stat"><b className={p.stats.blocked ? "red" : ""}>{p.stats.blocked}</b><span>卡關</span></div>
        {data.canSeeFinance && <div className="stat"><b className={p.margin_alert ? "red" : ""}>{pct(p.margin_rate)}</b><span>毛利率</span></div>}
        <div className="stat"><b>{lk.nameOf(p.pm_account)}</b><span>PM</span></div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={([["tasks", "工作"], ["meetings", "會議"], ["suppliers", "供應商檔期"]] as [string, string][])
        .concat(data.canSeeFinance ? [["budget", "預算與毛利"]] : []).concat([["close", "結案"]])} />
      {tab === "tasks" && <Tasks project={p} tasks={data.tasks} options={opts.data} reload={reload} />}
      {tab === "meetings" && <Meetings project={p} meetings={data.meetings} reload={reload} />}
      {tab === "suppliers" && <Bookings project={p} bookings={data.bookings} reload={reload} />}
      {tab === "budget" && <Budget project={p} reload={reload} />}
      {tab === "close" && <Close project={p} bookings={data.bookings} reload={reload} />}
      {editing && (
        <Modal title="編輯專案" onClose={() => setEditing(false)}>
          <RecordForm fields={PROJECT_FIELDS.concat(data.canSeeFinance ? FINANCE_FIELDS : [])} initial={p} onSubmit={saveProject} onCancel={() => setEditing(false)} busy={busy} />
        </Modal>
      )}
    </Page>
  );
}

function taskFields(options: any): Field[] {
  return [
    { name: "title", label: "工作項目", required: true, full: true },
    { name: "category", label: "工作分類", type: "select", options: options?.categories || [] },
    { name: "priority", label: "重要性", type: "select", options: options?.priorities || [] },
    { name: "owner_account", label: "負責人", type: "person" },
    { name: "assistant_account", label: "協辦人", type: "person" },
    { name: "start_date", label: "開始日", type: "date" },
    { name: "due_date", label: "截止日", type: "date" },
    { name: "status", label: "狀態", type: "select", options: options?.statuses || [] },
    { name: "waiting_on", label: "等待對象" },
    { name: "progress_note", label: "最新進度", type: "textarea" },
    { name: "next_step", label: "下一步", type: "textarea" },
    { name: "blocker", label: "卡關原因", type: "textarea", hint: "狀態是卡關時必填" },
    { name: "note", label: "備註", type: "textarea" },
  ];
}

function Tasks({ project, tasks, options, reload }: { project: any; tasks: any[]; options: any; reload: () => void }) {
  const lk = useLookups();
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [filter, setFilter] = useState("open");
  const { busy, run } = useAction();
  const rows = tasks.filter(t => filter === "all" || (filter === "mine" ? t.owner_account === lk.me.account : !["已完成", "取消"].includes(t.status)));
  const save = async (values: any) => {
    const r = await run(() => editing
      ? call("task.update", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: values })
      : call("task.create", { project_id: project.id, record: values }), "已儲存");
    if (r) { setEditing(undefined); reload(); }
  };
  const quick = async (t: any, status: string) => {
    const r = await run(() => call("task.update", { id: t.id, expectedUpdatedAt: t.updated_at, patch: { status } }), "已改成「" + status + "」");
    if (r) reload();
  };
  const remove = async () => {
    if (!editing || !confirm("確定刪除工作「" + editing.title + "」？")) return;
    const r = await run(() => call("task.delete", { id: editing.id, expectedUpdatedAt: editing.updated_at }), "已刪除");
    if (r) { setEditing(undefined); reload(); }
  };
  return (
    <>
      <div className="toolbar">
        <Tabs tabs={[["open", "未完成"], ["mine", "我的"], ["all", "全部"]]} value={filter} onChange={setFilter} />
        <span className="spacer" />
        <button className="btn primary" onClick={() => setEditing(null)}>＋ 新增工作</button>
      </div>
      <Table rows={rows} onRow={t => setEditing(t)} empty="沒有工作。" columns={[
        { key: "light", label: "燈號", render: t => <Badge text={t.light} /> },
        { key: "title", label: "工作", render: t => <><b>{t.title}</b><small className="muted block">{t.code}・{t.category || "未分類"}{t.next_step ? "・下一步：" + t.next_step : ""}</small></> },
        { key: "owner", label: "負責人", render: t => lk.nameOf(t.owner_account) },
        { key: "due", label: "截止", render: t => shortDate(t.due_date) },
        { key: "status", label: "狀態", render: t => (
          <select value={t.status} onClick={e => e.stopPropagation()} onChange={e => quick(t, e.target.value)} aria-label="狀態" disabled={busy}>
            {(options?.statuses || [t.status]).map((s: string) => <option key={s}>{s}</option>)}
          </select>
        ) },
      ]} />
      {editing !== undefined && (
        <Modal title={editing ? editing.code + " " + editing.title : "新增工作"} onClose={() => setEditing(undefined)} wide>
          <RecordForm fields={taskFields(options)} initial={editing || undefined} onSubmit={save} onCancel={() => setEditing(undefined)} busy={busy}
            extra={editing && <button type="button" className="btn danger-link" onClick={remove}>刪除這項工作</button>} />
        </Modal>
      )}
    </>
  );
}

function Meetings({ project, meetings, reload }: { project: any; meetings: any[]; reload: () => void }) {
  const lk = useLookups();
  const [open, setOpen] = useState(false);
  const [meeting, setMeeting] = useState<any>({ title: "", meeting_date: new Date().toISOString().slice(0, 10), attendees: "", notes: "" });
  const [items, setItems] = useState<any[]>([{ title: "", owner_account: "", due_date: "" }]);
  const { busy, run } = useAction();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const tasks = items.filter(i => i.title).map(i => ({ title: i.title, owner_account: i.owner_account || null, due_date: i.due_date || null }));
    const r = await run(() => call("meeting.create", { meeting: Object.assign({}, meeting, { project_id: project.id }), tasks }), "已記錄會議，產生 " + tasks.length + " 項工作");
    if (r) { setOpen(false); setItems([{ title: "", owner_account: "", due_date: "" }]); reload(); }
  };
  return (
    <>
      <div className="toolbar"><span className="spacer" /><button className="btn primary" onClick={() => setOpen(true)}>＋ 會議紀錄</button></div>
      <Table rows={meetings} empty="還沒有會議紀錄。" columns={[
        { key: "meeting_date", label: "日期", render: m => shortDate(m.meeting_date) },
        { key: "title", label: "會議", render: m => <><b>{m.title}</b><small className="muted block pre">{m.notes || ""}</small></> },
        { key: "attendees", label: "出席", hideSm: true },
      ]} />
      {open && (
        <Modal title="會議紀錄" onClose={() => setOpen(false)} wide>
          <form onSubmit={save}>
            <div className="form-grid">
              <label className="field"><span>會議名稱 *</span><input required value={meeting.title} onChange={e => setMeeting({ ...meeting, title: e.target.value })} /></label>
              <label className="field"><span>日期 *</span><input type="date" required value={meeting.meeting_date} onChange={e => setMeeting({ ...meeting, meeting_date: e.target.value })} /></label>
              <label className="field full"><span>出席</span><input value={meeting.attendees} onChange={e => setMeeting({ ...meeting, attendees: e.target.value })} /></label>
              <label className="field full"><span>紀錄</span><textarea value={meeting.notes} onChange={e => setMeeting({ ...meeting, notes: e.target.value })} /></label>
            </div>
            <h3>決議待辦（會直接成為專案工作）</h3>
            {items.map((it, i) => (
              <div className="row3" key={i}>
                <input placeholder="工作項目" value={it.title} onChange={e => setItems(items.map((x, j) => j === i ? { ...x, title: e.target.value } : x))} aria-label="工作項目" />
                <select value={it.owner_account} onChange={e => setItems(items.map((x, j) => j === i ? { ...x, owner_account: e.target.value } : x))} aria-label="負責人">
                  <option value="">負責人</option>{lk.people.map(p => <option key={p.account} value={p.account}>{p.name}</option>)}
                </select>
                <input type="date" value={it.due_date} onChange={e => setItems(items.map((x, j) => j === i ? { ...x, due_date: e.target.value } : x))} aria-label="截止日" />
              </div>
            ))}
            <button type="button" className="btn" onClick={() => setItems([...items, { title: "", owner_account: "", due_date: "" }])}>＋ 再一項</button>
            <div className="modal-foot"><button type="button" className="btn" onClick={() => setOpen(false)}>取消</button><button className="btn primary" disabled={busy}>儲存</button></div>
          </form>
        </Modal>
      )}
    </>
  );
}

function Bookings({ project, bookings, reload }: { project: any; bookings: any[]; reload: () => void }) {
  const lk = useLookups();
  const [open, setOpen] = useState(false);
  const { busy, run } = useAction();
  const book = async (v: any) => {
    const r = await run(() => call("supplier.book", Object.assign({ project_id: project.id }, v)), "已預約");
    if (r) { setOpen(false); reload(); }
  };
  const cancel = async (b: any) => {
    if (!confirm("取消這筆預約？取消後檔期就釋出給其他專案。")) return;
    const r = await run(() => call("supplier.cancelBooking", { id: b.id, expectedUpdatedAt: b.updated_at }), "已取消預約");
    if (r) reload();
  };
  return (
    <>
      <div className="toolbar"><span className="muted">預約時會檢查供應商檔期，同一天交接也算衝突。</span><span className="spacer" /><button className="btn primary" onClick={() => setOpen(true)}>＋ 預約供應商</button></div>
      <Table rows={bookings} empty="還沒有預約供應商。" columns={[
        { key: "supplier", label: "供應商", render: b => lk.suppliers.find(s => s.id === b.supplier_id)?.name || "—" },
        { key: "range", label: "期間", render: b => shortDate(b.start_date) + "–" + shortDate(b.end_date) },
        { key: "note", label: "備註", hideSm: true },
        { key: "x", label: "", render: b => <button className="btn small" onClick={() => cancel(b)} disabled={busy}>取消</button> },
      ]} />
      {open && (
        <Modal title="預約供應商" onClose={() => setOpen(false)}>
          <RecordForm busy={busy} onCancel={() => setOpen(false)} onSubmit={book} submitLabel="預約" initial={undefined} fields={[
            { name: "supplier_id", label: "供應商", type: "supplier", required: true, full: true },
            { name: "start_date", label: "開始", type: "date", required: true },
            { name: "end_date", label: "結束", type: "date", required: true },
            { name: "note", label: "備註", type: "textarea" },
          ]} />
        </Modal>
      )}
    </>
  );
}

function Budget({ project, reload }: { project: any; reload: () => void }) {
  const lk = useLookups();
  const b = useLoad<any>("budget.get", { project_id: project.id });
  const cats = useLoad<string[]>("budget.categories");
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [change, setChange] = useState(false);
  const { busy, run } = useAction();
  const done = () => { b.reload(); reload(); };
  const save = async (v: any) => {
    const r = await run(() => editing ? call("budget.updateLine", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: v })
      : call("budget.addLine", { project_id: project.id, record: v }), "已儲存，毛利已重算");
    if (r) { setEditing(undefined); done(); }
  };
  const remove = async () => {
    if (!editing || !confirm("刪除科目「" + editing.item + "」？")) return;
    const r = await run(() => call("budget.deleteLine", { id: editing.id, expectedUpdatedAt: editing.updated_at }), "已刪除");
    if (r) { setEditing(undefined); done(); }
  };
  const addChange = async (v: any) => {
    const r = await run(() => call("budget.addChange", { project_id: project.id, record: v }), "已記錄增減項，毛利已重算");
    if (r) { setChange(false); done(); }
  };
  if (!b.data) return <Loading error={b.error} loading />;
  const t = b.data.totals;
  return (
    <>
      <div className="stats">
        <div className="stat"><b>{money(t.quote)}</b><span>報價合計（含增減項）</span></div>
        <div className="stat"><b>{money(t.estimate)}</b><span>預估成本</span></div>
        <div className="stat"><b>{money(t.actual)}</b><span>實際成本（含費用、派遣）</span></div>
        <div className="stat"><b>{money(t.current)}</b><span>目前成本</span></div>
        <div className="stat"><b className={project.margin_alert ? "red" : ""}>{money(t.margin)}・{pct(t.marginRate)}</b><span>目前毛利</span></div>
      </div>
      <p className="muted small">目前成本：每個科目取「預估」與「實際」較大者，再加上沒掛科目的費用、派遣人力（{money(b.data.labor.cost)} 元，{b.data.labor.hours} 小時）與增減項成本。</p>
      <div className="toolbar"><h3>預算科目</h3><span className="spacer" /><button className="btn" onClick={() => setChange(true)}>＋ 增減項</button><button className="btn primary" onClick={() => setEditing(null)}>＋ 科目</button></div>
      <Table rows={b.data.lines} onRow={l => setEditing(l)} empty="還沒有預算科目。" columns={[
        { key: "category", label: "科目" },
        { key: "item", label: "項目", render: l => <><b>{l.item}</b>{l.supplier_id && <small className="muted block">{lk.suppliers.find(s => s.id === l.supplier_id)?.name}</small>}</> },
        { key: "quote_amount", label: "報價", num: true, render: l => money(l.quote_amount) },
        { key: "cost_estimate", label: "預估", num: true, render: l => money(l.cost_estimate) },
        { key: "actual", label: "實際", num: true, render: l => money((l.cost_actual || 0) + l.expense_actual) },
        { key: "current", label: "目前", num: true, render: l => <span className={l.current_cost > (l.cost_estimate || 0) ? "red" : ""}>{money(l.current_cost)}</span> },
      ]} />
      {b.data.changes.length > 0 && <>
        <h3>增減項紀錄</h3>
        <Table rows={b.data.changes} columns={[
          { key: "change_date", label: "日期", render: c => shortDate(c.change_date) },
          { key: "kind", label: "類型", render: c => <Badge text={c.kind} tone={c.kind === "增項" ? "yellow" : "green"} /> },
          { key: "description", label: "內容" },
          { key: "quote_delta", label: "報價變動", num: true, render: c => money(c.quote_delta) },
          { key: "cost_delta", label: "成本變動", num: true, render: c => money(c.cost_delta) },
        ]} />
      </>}
      {b.data.unlinkedExpenses.length > 0 && <>
        <h3>沒掛科目的費用</h3>
        <Table rows={b.data.unlinkedExpenses} columns={[
          { key: "description", label: "內容" }, { key: "claimant", label: "申請人", render: e => lk.nameOf(e.claimant_account) },
          { key: "amount", label: "金額", num: true, render: e => money(e.amount) },
        ]} />
      </>}
      {editing !== undefined && (
        <Modal title={editing ? "編輯科目" : "新增預算科目"} onClose={() => setEditing(undefined)}>
          <RecordForm busy={busy} initial={editing || undefined} onSubmit={save} onCancel={() => setEditing(undefined)}
            extra={editing && <button type="button" className="btn danger-link" onClick={remove}>刪除科目</button>} fields={[
              { name: "category", label: "科目", type: "select", options: cats.data || [], required: true },
              { name: "item", label: "項目", required: true },
              { name: "quote_amount", label: "報價", type: "number" },
              { name: "cost_estimate", label: "預估成本", type: "number" },
              { name: "cost_actual", label: "實際成本（手填，例如廠商發票）", type: "number", hint: "掛在這個科目的已核准請款會自動加上，不用重填" },
              { name: "supplier_id", label: "供應商", type: "supplier" },
              { name: "note", label: "備註", type: "textarea" },
            ]} />
        </Modal>
      )}
      {change && (
        <Modal title="增減項" onClose={() => setChange(false)}>
          <RecordForm busy={busy} initial={undefined} onSubmit={addChange} onCancel={() => setChange(false)} fields={[
            { name: "kind", label: "類型", type: "select", options: ["增項", "減項"], required: true },
            { name: "change_date", label: "日期", type: "date" },
            { name: "description", label: "內容", required: true, full: true },
            { name: "quote_delta", label: "報價變動（減項填負數）", type: "number" },
            { name: "cost_delta", label: "成本變動（減項填負數）", type: "number" },
            { name: "note", label: "備註", type: "textarea" },
          ]} />
        </Modal>
      )}
    </>
  );
}

function Close({ project, bookings, reload }: { project: any; bookings: any[]; reload: () => void }) {
  const lk = useLookups();
  const supplierIds = [...new Set(bookings.map(b => b.supplier_id))];
  const [scores, setScores] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState({ success_notes: project.success_notes || "", improve_notes: project.improve_notes || "" });
  const { busy, run } = useAction();
  if (project.stage === "已結案") return <p className="muted">這個專案已結案。成功經驗：{project.success_notes || "—"}；待改進：{project.improve_notes || "—"}</p>;
  const close = async () => {
    if (!confirm("確定結案？結案後供應商評分會寫入供應商資料。")) return;
    const ratings = Object.entries(scores).filter(([, s]) => s > 0).map(([supplier_id, score]) => ({ supplier_id, score }));
    const r = await run(() => call("project.close", { id: project.id, expectedUpdatedAt: project.updated_at, ratings, notes }), "已結案");
    if (r) reload();
  };
  return (
    <div className="card">
      <h3>結案心得</h3>
      <div className="form-grid">
        <label className="field full"><span>成功經驗</span><textarea value={notes.success_notes} onChange={e => setNotes({ ...notes, success_notes: e.target.value })} /></label>
        <label className="field full"><span>待改進事項</span><textarea value={notes.improve_notes} onChange={e => setNotes({ ...notes, improve_notes: e.target.value })} /></label>
      </div>
      {supplierIds.length > 0 && <h3>供應商評分（1–5 分）</h3>}
      {supplierIds.map(id => (
        <div className="row3" key={id}>
          <span>{lk.suppliers.find(s => s.id === id)?.name || id}</span>
          <select value={scores[id] || 0} onChange={e => setScores({ ...scores, [id]: Number(e.target.value) })} aria-label="評分">
            <option value={0}>不評分</option>{[5, 4, 3, 2, 1].map(n => <option key={n} value={n}>{n} 分</option>)}
          </select>
        </div>
      ))}
      <div className="modal-foot"><button className="btn primary" onClick={close} disabled={busy}>結案</button></div>
    </div>
  );
}
