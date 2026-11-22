import { useState } from "react";
import { call } from "../api";
import { Badge, Field, Loading, Modal, Page, RecordForm, Table, Tabs, money, pct, shortDate, useAction, useLoad, useLookups } from "../ui";

// 活動類型：和後端 PROJECT_TYPES 一致（「頒獎典禮」已改為「典禮」）
export const PROJECT_TYPES = ["論壇", "研討會", "記者會", "展覽", "典禮", "訪查", "媒體宣傳", "教育訓練", "尾牙", "其他"];

const PROJECT_FIELDS: Field[] = [
  { name: "name", label: "專案名稱", required: true, full: true },
  { name: "client_id", label: "客戶", type: "client" },
  { name: "client_name", label: "客戶／主辦單位（顯示名稱）" },
  { name: "project_type", label: "活動類型", type: "select", options: PROJECT_TYPES, hint: "依類型代入參考工作項目" },
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
  const [newType, setNewType] = useState("");
  const templates = useLoad<any[]>(creating ? "template.list" : null);
  const typesOf = (t: any) => String(t.project_types || "").split(/[,、，]/).map((s: string) => s.trim()).filter(Boolean);
  const common = (templates.data || []).filter(t => !typesOf(t).length);
  // 沒選類型時後端當成「其他」
  const typed = (templates.data || []).filter(t => typesOf(t).includes(newType || "其他"));
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
            onValuesChange={(name, v) => { if (name === "project_type") setNewType(v || ""); }}
            extra={<>
              <label className="check"><input type="checkbox" checked={applyTemplate} onChange={e => setApplyTemplate(e.target.checked)} />
                依活動類型代入參考工作項目（需填活動日期）</label>
              {applyTemplate && templates.data && <p className="muted small" style={{ margin: "6px 0 0 26px" }}>
                將產生 {common.length + typed.length} 項：每種專案都有的 {common.length} 項＋{newType || "其他（未選類型）"}適用的 {typed.length} 項
                {!newType && "；選擇活動類型可換成該類型的參考工作"}
              </p>}
            </>} />
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
  const [importing, setImporting] = useState(false);
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
        <button className="btn" onClick={() => setImporting(true)}>代入參考工作</button>
        <button className="btn primary" onClick={() => setEditing(null)}>＋ 新增工作</button>
      </div>
      {tasks.length === 0 && (
        <div className="card hint-card">
          <b>這個專案還沒有工作。</b>
          <span className="muted">可以依活動類型「{project.project_type || "其他"}」代入參考工作項目，再勾選要用的。</span>
          <button className="btn primary" onClick={() => setImporting(true)}>代入參考工作</button>
        </div>
      )}
      {importing && <TemplateImport project={project} onClose={() => setImporting(false)} onDone={() => { setImporting(false); reload(); }} />}
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

/** 專案建立後再代入參考工作：列出適用的範本與截止日，已有的自動不勾，同仁勾選後加入。 */
function TemplateImport({ project, onClose, onDone }: { project: any; onClose: () => void; onDone: () => void }) {
  const { data, error, loading } = useLoad<any>("task.templatePreview", { project_id: project.id });
  const [picked, setPicked] = useState<Record<string, boolean> | null>(null);
  const { busy, run } = useAction();
  const items: any[] = data?.items || [];
  const sel = picked || Object.fromEntries(items.filter(i => !i.exists).map(i => [i.template_id, true]));
  const count = items.filter(i => sel[i.template_id] && !i.exists).length;
  const toggle = (id: string) => setPicked({ ...sel, [id]: !sel[id] });
  const all = (on: boolean) => setPicked(Object.fromEntries(items.filter(i => !i.exists).map(i => [i.template_id, on])));
  const add = async () => {
    const ids = items.filter(i => sel[i.template_id] && !i.exists).map(i => i.template_id);
    const r = await run(() => call<any[]>("task.addFromTemplates", { project_id: project.id, template_ids: ids }), "已加入 " + ids.length + " 項工作");
    if (r) onDone();
  };
  return (
    <Modal title="代入參考工作" onClose={onClose} wide>
      <Loading error={error} loading={loading && !data} />
      {data && <>
        <p className="muted small">
          活動類型「{data.project_type}」適用 {items.length} 項{data.start_date ? "，截止日以活動日 " + data.start_date + " 推算" : ""}。
          專案裡已經有的（同名工作）不會重複加入。工作範本可在「系統設定 → 工作範本」調整。
        </p>
        {!data.start_date && <p className="error">這個專案還沒填活動日期，無法推算截止日。請先到「編輯專案」填活動日期。</p>}
        <div className="toolbar"><button className="btn small" onClick={() => all(true)}>全選</button><button className="btn small" onClick={() => all(false)}>全不選</button>
          <span className="muted small">已選 {count} 項</span></div>
        <div className="table-wrap"><table><thead><tr><th></th><th>截止</th><th>分類</th><th>工作項目</th><th className="hide-sm">重要性</th></tr></thead>
          <tbody>{items.map(i => (
            <tr key={i.template_id} className={i.exists ? "muted" : "clickable"} onClick={() => !i.exists && toggle(i.template_id)}>
              <td><input type="checkbox" disabled={i.exists} checked={!i.exists && !!sel[i.template_id]} onChange={() => toggle(i.template_id)} onClick={e => e.stopPropagation()} aria-label={i.title} /></td>
              <td>{i.due_date ? shortDate(i.due_date) : "T" + (i.offset_days >= 0 ? "+" : "") + i.offset_days}</td>
              <td>{i.category}</td>
              <td>{i.title}{i.exists && <small className="block">已在專案中</small>}</td>
              <td className="hide-sm">{i.priority}</td>
            </tr>
          ))}</tbody></table></div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" disabled={busy || !count || !data.start_date} onClick={add}>{busy ? "加入中…" : "加入 " + count + " 項工作"}</button>
        </div>
      </>}
    </Modal>
  );
}

/** 從報價參考加入預算：搜尋品項，每項選用公司估算或某家廠商的價格、填數量；預估成本 = 單價 × 數量。 */
function PricePicker({ project, categories, onClose, onDone }: { project: any; categories: string[]; onClose: () => void; onDone: () => void }) {
  const { data, error, loading } = useLoad<any[]>("priceRef.compare");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("硬體設備");
  const [picked, setPicked] = useState<Record<string, { ref: string; qty: string }>>({});
  const { busy, run } = useAction();
  const groups = (data || []).filter(g => !q || [g.item, g.type].some(v => String(v || "").toLowerCase().includes(q.toLowerCase())));
  const keyOf = (g: any) => g.item + "|" + (g.type || "");
  const options = (g: any) => [...(g.estimate ? [g.estimate] : []), ...g.quotes].filter((x: any) => x.unit_price != null);
  const priceOf = (g: any, id: string) => options(g).find((x: any) => x.id === id)?.unit_price || 0;
  const chosen = (data || []).filter(g => picked[keyOf(g)] && Number(picked[keyOf(g)].qty) > 0);
  const total = chosen.reduce((s, g) => s + priceOf(g, picked[keyOf(g)].ref) * Number(picked[keyOf(g)].qty), 0);
  const quoteTotal = chosen.reduce((s, g) => s + (g.quote_price || 0) * Number(picked[keyOf(g)].qty), 0);
  const set = (g: any, patch: Partial<{ ref: string; qty: string }>) => {
    const k = keyOf(g);
    const cur = picked[k] || { ref: (g.lowest || g.estimate || options(g)[0] || {}).id || "", qty: "" };
    setPicked({ ...picked, [k]: { ...cur, ...patch } });
  };
  const add = async () => {
    const items = chosen.map(g => ({ price_ref_id: picked[keyOf(g)].ref, quantity: Number(picked[keyOf(g)].qty) }));
    const r = await run(() => call("budget.addFromPrices", { project_id: project.id, category, items }), "已加入 " + items.length + " 個科目，毛利已重算");
    if (r) onDone();
  };
  return (
    <Modal title="從報價參考加入預算" onClose={onClose} wide>
      <div className="toolbar">
        <input type="search" placeholder="搜尋品項" value={q} onChange={e => setQ(e.target.value)} />
        <label className="small">加入科目 <select value={category} onChange={e => setCategory(e.target.value)}>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && (data.length === 0 ? <p className="muted">還沒有報價資料。請到「費用 → 報價參考」匯入或新增。</p> :
        <div className="table-wrap"><table><thead><tr><th>品項</th><th>成本用哪個價格</th><th className="num">對客戶報價</th><th className="num">數量</th><th className="num">成本／報價小計</th></tr></thead>
          <tbody>{groups.map(g => {
            const k = keyOf(g), p = picked[k], opts = options(g);
            return (
              <tr key={k}>
                <td><b>{g.item}</b><small className="muted block">{g.type || ""}</small></td>
                <td>{opts.length ? <select value={p?.ref || (g.lowest || g.estimate || opts[0]).id} onChange={e => set(g, { ref: e.target.value })}>
                  {opts.map((x: any) => <option key={x.id} value={x.id}>{(x.vendor_name || "公司估算") + "：" + money(x.unit_price) + " / " + (x.unit || g.unit || "")}</option>)}
                </select> : <span className="muted">沒有單價</span>}</td>
                <td className="num">{g.quote_price != null ? money(g.quote_price) : <span className="muted">未填</span>}</td>
                <td className="num"><input type="number" min="0" style={{ width: 90 }} value={p?.qty || ""} disabled={!opts.length} onChange={e => set(g, { qty: e.target.value })} aria-label={g.item + " 數量"} /></td>
                <td className="num">{p && Number(p.qty) > 0 ? <>{money(priceOf(g, p.ref) * Number(p.qty))}<small className="muted block">{g.quote_price != null ? money(g.quote_price * Number(p.qty)) : "—"}</small></> : "—"}</td>
              </tr>
            );
          })}</tbody></table></div>)}
      <div className="modal-foot">
        <span className="muted small">已選 {chosen.length} 項，預估成本 {money(total)} 元・對客戶報價 {money(quoteTotal)} 元{quoteTotal > 0 ? "・毛利率 " + pct((quoteTotal - total) / quoteTotal) : ""}</span>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn primary" disabled={busy || !chosen.length} onClick={add}>{busy ? "加入中…" : "加入預算"}</button>
      </div>
    </Modal>
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
  const [fromPrices, setFromPrices] = useState(false);
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
      <div className="toolbar"><h3>預算科目</h3><span className="spacer" /><button className="btn" onClick={() => setChange(true)}>＋ 增減項</button><button className="btn" onClick={() => setFromPrices(true)}>從報價參考加入</button><button className="btn primary" onClick={() => setEditing(null)}>＋ 科目</button></div>
      {fromPrices && <PricePicker project={project} categories={cats.data || []} onClose={() => setFromPrices(false)} onDone={() => { setFromPrices(false); done(); }} />}
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
