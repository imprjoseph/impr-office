import { useEffect, useState } from "react";
import { call } from "../api";
import { MeetingList } from "./Meetings";
import { Badge, Field, Loading, Modal, Page, RecordForm, Table, Tabs, money, pct, shortDate, useAction, useLoad, useLookups, useSaveQueue } from "../ui";

// 活動類型：和後端 PROJECT_TYPES 一致（「頒獎典禮」已改為「典禮」）
export const PROJECT_TYPES = ["論壇", "研討會", "記者會", "展覽", "典禮", "訪查", "媒體宣傳", "教育訓練", "尾牙", "其他"];

/** 客戶窗口的建議清單跟著選的客戶走（客戶的主要窗口＋聯絡人）。 */
function useClientContacts(initialClientId?: string | null) {
  const [clientId, setClientId] = useState<string | null>(initialClientId || null);
  const [contacts, setContacts] = useState<any[]>([]);
  useEffect(() => {
    if (!clientId) { setContacts([]); return; }
    let alive = true;
    call<any[]>("project.clientContacts", { client_id: clientId }).then(r => { if (alive) setContacts(r); }).catch(() => setContacts([]));
    return () => { alive = false; };
  }, [clientId]);
  return { contacts, setClientId };
}

function projectFields(contacts: any[]): Field[] {
  return [
  { name: "name", label: "專案名稱", required: true, full: true },
  { name: "client_id", label: "客戶", type: "client", hint: "清單裡沒有的客戶，請先到「資源 → 客戶」新增" },
  { name: "client_contact", label: "客戶窗口", type: "combo", options: contacts.map(c => [c.name, [c.title, c.info].filter(Boolean).join("・")] as [string, string]),
    hint: contacts.length ? "可從客戶的聯絡人選，選了會自動帶職稱與聯絡方式；也可以直接打名字" : "直接打名字；客戶資料有聯絡人時可以用選的" },
  { name: "client_contact_title", label: "窗口職稱" },
  { name: "client_contact_info", label: "窗口電話／Email" },
  { name: "project_type", label: "活動類型", type: "select", options: PROJECT_TYPES, hint: "依類型代入參考工作項目" },
  { name: "venue", label: "地點" },
  { name: "start_date", label: "活動日期", type: "date", hint: "套用範本時，工作截止日以這天為 T 日" },
  { name: "end_date", label: "結束日期", type: "date" },
  { name: "pm_account", label: "PM", type: "person", filter: (p: any) => p.office_role !== "admin" && p.kind !== "派遣" },
  { name: "drive_folder_url", label: "專案資料夾網址", type: "url", full: true },
  ];
}
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
  const newContacts = useClientContacts(null);
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
          <RecordForm fields={projectFields(newContacts.contacts).concat(lk.can("admin", "manager", "accountant") ? FINANCE_FIELDS : [])} initial={undefined}
            onSubmit={create} onCancel={() => setCreating(false)} busy={busy} submitLabel="建立"
            onValuesChange={(name, v) => { if (name === "project_type") setNewType(v || ""); if (name === "client_id") newContacts.setClientId(v || null); }}
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
  const { data, error, loading, reload, setData } = useLoad<any>("project.get", { id });
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
  const canDelete = lk.can("admin", "manager") || p.pm_account === lk.me.account;
  const removeProject = async () => {
    const typed = prompt("刪除後，這個專案的工作、會議、預算科目都會一起刪除，供應商檔期會取消。\n確定要刪除請輸入專案名稱：「" + p.name + "」");
    if (typed === null) return;
    if (typed.trim() !== p.name.trim()) { alert("名稱不符，沒有刪除。"); return; }
    const r = await run(() => call<any>("project.delete", { id: p.id, expectedUpdatedAt: p.updated_at }), "已刪除專案「" + p.name + "」");
    if (r) { lk.refresh(["projects"]); location.hash = "#/projects"; }
  };
  // 階段先換到畫面上，背景寫入；失敗再換回來
  const setStage = async (stage: string) => {
    const before = p.stage;
    setData((d: any) => d && { ...d, project: { ...d.project, stage } });
    try {
      await call("project.setStage", { id: p.id, expectedUpdatedAt: p.updated_at, stage });
      reload();
    } catch (e) {
      setData((d: any) => d && { ...d, project: { ...d.project, stage: before } });
      alert("階段沒有改成功：" + (e as Error).message);
    }
  };
  return (
    <Page title={p.name} sub={p.code + "・" + (p.client_name || "客戶未填") + (p.client_contact ? "（窗口 " + p.client_contact + (p.client_contact_info ? " " + p.client_contact_info : "") + "）" : "") + "・" + (p.start_date ? p.start_date.replace(/-/g, "/") : "日期未定") + (p.venue ? "・" + p.venue : "")}
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
        .concat(data.canSeeFinance ? [["budget", "報價單與毛利"]] : []).concat([["close", "結案"]])} />
      {tab === "tasks" && <Tasks project={p} tasks={data.tasks} options={opts.data} reload={reload} />}
      {tab === "meetings" && <Meetings project={p} meetings={data.meetings} reload={reload} />}
      {tab === "suppliers" && <Bookings project={p} bookings={data.bookings} reload={reload} />}
      {tab === "budget" && <Budget project={p} reload={reload} />}
      {tab === "close" && <Close project={p} bookings={data.bookings} reload={reload} />}
      {editing && (
        <Modal title="編輯專案" onClose={() => setEditing(false)}>
          <ProjectEditForm project={p} finance={data.canSeeFinance} onSubmit={saveProject} onCancel={() => setEditing(false)} busy={busy}
            extra={canDelete && <button type="button" className="btn danger-link" disabled={busy} onClick={removeProject}>刪除這個專案</button>} />
        </Modal>
      )}
    </Page>
  );
}

function ProjectEditForm({ project, finance, onSubmit, onCancel, busy, extra }: { project: any; finance: boolean; onSubmit: (v: any) => void; onCancel: () => void; busy: boolean; extra?: any }) {
  const cc = useClientContacts(project.client_id);
  return <RecordForm fields={projectFields(cc.contacts).concat(finance ? FINANCE_FIELDS : [])} initial={project} onSubmit={onSubmit} onCancel={onCancel} busy={busy}
    onValuesChange={(name, v) => { if (name === "client_id") cc.setClientId(v || null); }} extra={extra} />;
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
  // 狀態與進度改動先顯示在畫面上，停手 1.5 秒後一次寫入
  const queue = useSaveQueue("task.updateMany", reload);
  // 已完成、取消的燈號就是狀態本身；其他燈號等伺服器重算
  const shown = queue.apply(tasks).map(t => ["已完成", "取消"].includes(t.status) ? { ...t, light: t.status } : t);
  const rows = shown.filter(t => filter === "all" || (filter === "mine" ? t.owner_account === lk.me.account : !["已完成", "取消"].includes(t.status)));
  const save = async (values: any) => {
    if (editing) {
      if (values.status === "卡關" && !(values.blocker ?? editing.blocker)) { alert("改成「卡關」要填卡關原因"); return; }
      queue.enqueue(editing, values);
      setEditing(undefined);
      return;
    }
    const r = await run(() => call("task.create", { project_id: project.id, record: values }), "已新增");
    if (r) { setEditing(undefined); reload(); }
  };
  const quick = (t: any, status: string) => {
    // 卡關一定要寫原因：直接打開編輯視窗
    if (status === "卡關" && !t.blocker) { setEditing({ ...t, status }); return; }
    queue.enqueue(t, { status });
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
        {(queue.waiting > 0 || queue.saving > 0) && <span className="muted small save-state">{queue.saving > 0 ? "儲存中…" : queue.waiting + " 項待儲存"}</span>}
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
          <select value={t.status} onClick={e => e.stopPropagation()} onChange={e => quick(t, e.target.value)} aria-label="狀態">
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

function Meetings({ project, reload }: { project: any; meetings: any[]; reload: () => void }) {
  return <MeetingList projectId={project.id} onChanged={reload} />;
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

const QUOTE_TONE: Record<string, string> = { "草稿": "", "送審中": "yellow", "已核定": "green", "退回修改": "red" };

/** 報價單：每一行有項目、規格、說明、單價、數量、總價、優惠價、預估成本、實際成本。主管核定後鎖住。 */
function Budget({ project, reload }: { project: any; reload: () => void }) {
  const lk = useLookups();
  const b = useLoad<any>("budget.get", { project_id: project.id });
  const cats = useLoad<string[]>("budget.categories");
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [change, setChange] = useState(false);
  const [fromPrices, setFromPrices] = useState(false);
  const [info, setInfo] = useState(false);
  const { busy, run } = useAction();
  const done = () => { b.reload(); reload(); };
  const save = async (v: any) => {
    const r = await run(() => editing ? call("budget.updateLine", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: v })
      : call("budget.addLine", { project_id: project.id, record: v }), "已儲存，毛利已重算");
    if (r) { setEditing(undefined); done(); }
  };
  const remove = async () => {
    if (!editing || !confirm("刪除「" + editing.item + "」？")) return;
    const r = await run(() => call("budget.deleteLine", { id: editing.id, expectedUpdatedAt: editing.updated_at }), "已刪除");
    if (r) { setEditing(undefined); done(); }
  };
  const addChange = async (v: any) => {
    const r = await run(() => call("budget.addChange", { project_id: project.id, record: v }), "已記錄增減項，毛利已重算");
    if (r) { setChange(false); done(); }
  };
  const quoteAct = async (action: string, ok: string, ask?: string) => {
    let note: string | null = null;
    if (ask) { note = prompt(ask); if (note === null) return; }
    const r = await run(() => call("quote." + action, { project_id: project.id, note }), ok);
    if (r) done();
  };
  const saveInfo = async (v: any) => {
    const r = await run(() => call("quote.setInfo", { project_id: project.id, record: v }), "已儲存");
    if (r) { setInfo(false); b.reload(); }
  };
  if (!b.data) return <Loading error={b.error} loading />;
  const t = b.data.totals;
  const q = b.data.quote;
  const locked = q.status === "送審中" || q.status === "已核定";
  const boss = lk.can("admin", "manager");
  const listTotal = b.data.lines.reduce((s: number, l: any) => s + (l.list_total ?? (Number(l.quote_amount) || 0)), 0);
  const lineFields: Field[] = locked ? [
    { name: "cost_actual", label: "實際成本（手填，例如廠商發票）", type: "number", hint: "掛在這一項的已核准請款會自動加上，不用重填" },
    { name: "supplier_id", label: "供應商", type: "supplier" },
    { name: "note", label: "備註", type: "textarea" },
  ] : [
    { name: "category", label: "科目", type: "select", options: cats.data || [], required: true },
    { name: "item", label: "項目", required: true },
    { name: "spec", label: "規格" },
    { name: "unit", label: "單位（式、場、組…）" },
    { name: "description", label: "說明（會印在報價單上）", type: "textarea" },
    { name: "unit_price", label: "單價", type: "number" },
    { name: "quantity", label: "數量（空白＝1）", type: "number" },
    { name: "discount_price", label: "優惠價（這一項的金額；空白＝總價）", type: "number", hint: "總價 = 單價 × 數量；有填優惠價，報價合計用優惠價" },
    { name: "cost_estimate", label: "預估成本（主管核定後就是這一項可請款的金額）", type: "number" },
    { name: "cost_actual", label: "實際成本（手填，例如廠商發票）", type: "number", hint: "掛在這一項的已核准請款會自動加上，不用重填" },
    { name: "supplier_id", label: "供應商", type: "supplier" },
    { name: "note", label: "內部備註（不印在報價單上）", type: "textarea" },
  ];
  const overBadge = (e: any) => e.over_budget ? <Badge text={"超出核定 " + money(e.over_budget.over)} tone="red" /> : null;
  return (
    <>
      <div className="card quote-head">
        <div>
          <b>報價單</b> <Badge text={q.status} tone={QUOTE_TONE[q.status]} />
          {q.status === "已核定" && <small className="muted">　{lk.nameOf(q.approved_by)} 核定於 {shortDate(String(q.approved_at || "").slice(0, 10))}・核定報價 {money(q.approved_total)}・核定成本 {money(q.cost_approved_total)}</small>}
          {q.status === "送審中" && <small className="muted">　{shortDate(String(q.submitted_at || "").slice(0, 10))} 送審，等主管核定；送審中與核定後不能改報價與預估成本</small>}
          {q.review_note && <small className={q.status === "退回修改" ? "red block" : "muted block"}>主管意見：{q.review_note}</small>}
        </div>
        <div className="page-actions">
          {(q.status === "草稿" || q.status === "退回修改") && <button className="btn primary" disabled={busy || !b.data.lines.length} onClick={() => quoteAct("submit", "已送主管核定")}>送主管核定</button>}
          {boss && q.status === "送審中" && <>
            <button className="btn" disabled={busy} onClick={() => quoteAct("return", "已退回修改", "退回原因（PM 會看到）")}>退回修改</button>
            <button className="btn primary" disabled={busy} onClick={() => quoteAct("approve", "已核定，報價與預估成本已鎖定")}>核定</button>
          </>}
          {boss && q.status === "已核定" && <button className="btn" disabled={busy} onClick={() => quoteAct("return", "已退回成可修改", "為什麼要重新修改報價單？（會留紀錄）")}>退回修改</button>}
          <button className="btn" onClick={() => setInfo(true)}>報價日期與條款</button>
          <button className="btn" onClick={() => printQuote(project, b.data, lk)}>列印報價單</button>
        </div>
      </div>
      <div className="stats">
        <div className="stat"><b>{money(t.quote)}</b><span>報價合計（優惠後，含增減項）</span></div>
        <div className="stat"><b>{money(t.estimate)}</b><span>預估成本</span></div>
        <div className="stat"><b>{money(t.actual)}</b><span>實際成本（含費用、派遣）</span></div>
        <div className="stat"><b>{money(t.current)}</b><span>目前成本</span></div>
        <div className="stat"><b className={project.margin_alert ? "red" : ""}>{money(t.margin)}・{pct(t.marginRate)}</b><span>目前毛利</span></div>
      </div>
      <p className="muted small">目前成本：每一項取「預估」與「實際」較大者，再加上沒指定項目的費用、派遣人力（{money(b.data.labor.cost)} 元，{b.data.labor.hours} 小時）與增減項成本。請款可以分次申請，同一項累計超過預估成本（核定金額）會標紅。</p>
      <div className="toolbar"><h3>報價項目</h3><span className="spacer" />
        <button className="btn" onClick={() => setChange(true)}>＋ 增減項</button>
        {!locked && <><button className="btn" onClick={() => setFromPrices(true)}>從報價參考加入</button><button className="btn primary" onClick={() => setEditing(null)}>＋ 項目</button></>}
      </div>
      {fromPrices && <PricePicker project={project} categories={cats.data || []} onClose={() => setFromPrices(false)} onDone={() => { setFromPrices(false); done(); }} />}
      <Table rows={b.data.lines} onRow={l => setEditing(l)} empty="還沒有報價項目。" columns={[
        { key: "item", label: "項目", render: l => <><b>{l.item}</b><small className="muted block">{[l.category, l.spec, l.description].filter(Boolean).join("・")}{l.supplier_id ? "・" + (lk.suppliers.find(s => s.id === l.supplier_id)?.name || "") : ""}</small></> },
        { key: "unit_price", label: "單價", num: true, hideSm: true, render: l => l.unit_price != null ? money(l.unit_price) : "—" },
        { key: "quantity", label: "數量", num: true, hideSm: true, render: l => l.unit_price != null ? (l.quantity ?? 1) + (l.unit ? " " + l.unit : "") : "—" },
        { key: "total", label: "總價", num: true, render: l => money(l.list_total ?? l.quote_amount) },
        { key: "discount", label: "優惠價", num: true, render: l => l.discount_price != null ? <b>{money(l.discount_price)}</b> : <span className="muted">—</span> },
        { key: "cost_estimate", label: "預估成本", num: true, render: l => money(l.cost_estimate) },
        { key: "claimed", label: "已申請／實際", num: true, render: l => {
          const over = l.cost_estimate != null && l.claimed > Number(l.cost_estimate);
          return <><span className={over ? "red" : ""}>{money(l.claimed)}</span>{over && <small className="red block">超出 {money(l.claimed - Number(l.cost_estimate))}</small>}
            {l.claimed !== (Number(l.cost_actual) || 0) + l.expense_actual && <small className="muted block">已核准 {money((Number(l.cost_actual) || 0) + l.expense_actual)}</small>}</>;
        } },
      ]} />
      <p className="muted small">原價合計 {money(listTotal)}・優惠後合計 {money(b.data.lines.reduce((s: number, l: any) => s + (Number(l.quote_amount) || 0), 0))}{locked ? "・報價單已鎖定，點項目只能填實際成本、供應商、備註" : ""}</p>
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
      {(b.data.expenses.length > 0 || b.data.pendingExpenses.length > 0) && <>
        <h3>請款 <span className="muted small">{b.data.unlinkedExpenses.length ? b.data.unlinkedExpenses.length + " 筆已核准的還沒指定項目" : ""}</span></h3>
        <p className="muted small">已核准、已付款的計入實際成本；送審中的先列出來，算在「已申請」。每筆可以指定對沖哪一項，改了馬上重算毛利。</p>
        <Table rows={[...b.data.pendingExpenses, ...b.data.expenses]} columns={[
          { key: "description", label: "內容", render: e => <><b>{e.description}</b><small className="muted block">{e.category}・{lk.nameOf(e.claimant_account)}{e.receipt_date ? "・" + shortDate(e.receipt_date) : ""}</small></> },
          { key: "status", label: "狀態", render: e => <span className="quote-list"><Badge text={e.status === "submitted" ? "待主管核准" : e.status === "paid" ? "已付款" : "已核准"} tone={e.status === "submitted" ? "yellow" : "green"} />{overBadge(e)}</span> },
          { key: "amount", label: "金額", num: true, render: e => money(e.amount) },
          { key: "line", label: "對沖項目", render: e => (
            <select value={e.budget_line_id || ""} disabled={busy} aria-label="對沖項目"
              onChange={async ev => { const r = await run(() => call("expense.setBudgetLine", { id: e.id, budget_line_id: ev.target.value || null }), "已更新對沖項目，毛利已重算"); if (r) done(); }}>
              <option value="">（未指定）</option>
              {b.data.lines.map((l: any) => <option key={l.id} value={l.id}>{l.category}／{l.item}</option>)}
            </select>) },
        ]} />
      </>}
      {editing !== undefined && (
        <Modal title={editing ? (locked ? "填實際成本：" + editing.item : "編輯項目") : "新增報價項目"} onClose={() => setEditing(undefined)}>
          {locked && editing && <p className="muted small">報價單{q.status}，報價與預估成本不能改。單價 {money(editing.unit_price)} × {editing.quantity ?? 1}，預估成本 {money(editing.cost_estimate)}。</p>}
          <RecordForm busy={busy} initial={editing || undefined} onSubmit={save} onCancel={() => setEditing(undefined)}
            extra={editing && !locked && <button type="button" className="btn danger-link" onClick={remove}>刪除這一項</button>} fields={lineFields} />
        </Modal>
      )}
      {info && (
        <Modal title="報價日期與條款" onClose={() => setInfo(false)}>
          <RecordForm busy={busy} initial={{ quote_date: q.quote_date, quote_valid_until: q.valid_until, quote_terms: q.terms }} onSubmit={saveInfo} onCancel={() => setInfo(false)} fields={[
            { name: "quote_date", label: "報價日期（空白＝列印當天）", type: "date" },
            { name: "quote_valid_until", label: "報價有效期限", type: "date" },
            { name: "quote_terms", label: "付款條件與備註（印在報價單下方）", type: "textarea", hint: "例如：簽約付 50%，活動結束後 30 天內付清；以上金額未稅" },
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

/** 給客戶的報價單：只印項目、規格、說明、單價、數量、總價、優惠價；不印成本。未核定的加「草稿」浮水印。 */
function printQuote(project: any, data: any, lk: any) {
  const esc = (v: any) => String(v ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const n = (v: any) => v == null || v === "" ? "" : Number(v).toLocaleString("zh-TW");
  const q = data.quote;
  const today = new Date().toISOString().slice(0, 10);
  const lines = data.lines as any[];
  const listTotal = lines.reduce((s, l) => s + (l.list_total ?? (Number(l.quote_amount) || 0)), 0);
  const finalTotal = lines.reduce((s, l) => s + (Number(l.quote_amount) || 0), 0);
  const rows = lines.map((l, i) => `<tr><td>${i + 1}</td><td><b>${esc(l.item)}</b>${l.description ? `<div class="d">${esc(l.description).replace(/\n/g, "<br>")}</div>` : ""}</td>
    <td>${esc(l.spec)}</td><td class="n">${n(l.unit_price)}</td><td class="n">${l.unit_price != null ? esc((l.quantity ?? 1) + (l.unit ? " " + l.unit : "")) : ""}</td>
    <td class="n">${n(l.list_total ?? l.quote_amount)}</td><td class="n">${l.discount_price != null ? n(l.discount_price) : ""}</td></tr>`).join("");
  const logo = new URL("./logo.png", location.href).href;
  const html = `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>報價單 ${esc(project.code)} ${esc(project.name)}</title><style>
    body{font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;color:#222;margin:32px;font-size:13px}
    h1{font-size:22px;margin:0 0 4px}.top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px}
    .meta{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:4px 12px;margin:12px 0 16px}.meta b{color:#555;font-weight:500}
    table{width:100%;border-collapse:collapse}th,td{border:1px solid #bbb;padding:6px 8px;vertical-align:top}th{background:#f2f2f2;text-align:left}
    .n{text-align:right;white-space:nowrap}.d{color:#555;font-size:12px;margin-top:2px}.tot td{font-weight:600}
    .terms{margin-top:16px;white-space:pre-wrap}.sign{margin-top:40px;display:flex;justify-content:space-between}
    .draft{position:fixed;top:40%;left:0;right:0;text-align:center;font-size:120px;color:rgba(200,0,0,.08);transform:rotate(-20deg);pointer-events:none}
    @media print{body{margin:12mm}}
  </style></head><body>${q.status === "已核定" ? "" : '<div class="draft">草稿</div>'}
  <div class="top"><div><h1>報價單</h1><div>${esc(project.code)}</div></div><img src="${logo}" alt="imPR 新動力公關" height="36"></div>
  <div class="meta"><b>客戶</b><span>${esc(project.client_name)}</span><b>報價日期</b><span>${esc(q.quote_date || today)}</span>
    <b>窗口</b><span>${esc([project.client_contact, project.client_contact_title].filter(Boolean).join(" "))}</span><b>有效期限</b><span>${esc(q.valid_until || "")}</span>
    <b>專案</b><span>${esc(project.name)}</span><b>活動日期</b><span>${esc(project.start_date || "")}${project.venue ? "・" + esc(project.venue) : ""}</span>
    <b>聯絡方式</b><span>${esc(project.client_contact_info)}</span><b>承辦</b><span>${esc(lk.nameOf(project.pm_account))}</span></div>
  <table><thead><tr><th>#</th><th>項目／說明</th><th>規格</th><th class="n">單價</th><th class="n">數量</th><th class="n">總價</th><th class="n">優惠價</th></tr></thead>
  <tbody>${rows}<tr class="tot"><td colspan="5" class="n">合計</td><td class="n">${n(listTotal)}</td><td class="n">${finalTotal !== listTotal ? n(finalTotal) : ""}</td></tr></tbody></table>
  <p>報價金額：新台幣 <b>${n(finalTotal)}</b> 元</p>
  ${q.terms ? `<div class="terms">${esc(q.terms)}</div>` : ""}
  <div class="sign"><span>報價單位：imPR 新動力公關</span><span>客戶確認簽章：＿＿＿＿＿＿＿＿＿＿</span></div>
  <script>window.onload=()=>setTimeout(()=>window.print(),300)</script></body></html>`;
  const w = window.open("", "_blank");
  if (!w) { alert("瀏覽器擋住了新視窗，請允許彈出視窗後再按一次。"); return; }
  w.document.open(); w.document.write(html); w.document.close();
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
