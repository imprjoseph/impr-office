/**
 * 會議紀錄：跨專案彙整每一場會議的摘要、決議與待辦。
 * 待辦就是專案工作（帶 meeting_id），在這裡改狀態和在專案的「工作」分頁改是同一筆。
 */
import { useState } from "react";
import { call } from "../api";
import { Badge, Loading, Modal, Page, Table, Tabs, shortDate, useAction, useLoad, useLookups } from "../ui";

const DONE = ["已完成", "取消"];
const STATUSES = ["未開始", "進行中", "待內部確認", "待客戶確認", "待廠商回覆", "卡關", "已完成", "取消"];
const today = () => new Date().toISOString().slice(0, 10);

export default function MeetingsPage() {
  const [tab, setTab] = useState("meetings");
  return (
    <Page title="會議紀錄" sub="每場會議的摘要、決議事項與待辦；待辦會直接成為專案工作，負責人在「我的工作台」也看得到。原始紀錄可以按「AI 整理」產生摘要與待辦，確認後再存。">
      <Tabs tabs={[["meetings", "會議彙整"], ["actions", "待辦事項"]]} value={tab} onChange={setTab} />
      {tab === "meetings" ? <MeetingList /> : <ActionItems />}
    </Page>
  );
}

/** 會議列表；給 projectId 時只列該專案（專案頁的「會議」分頁用）。 */
export function MeetingList({ projectId, onChanged }: { projectId?: string; onChanged?: () => void }) {
  const lk = useLookups();
  const { data, error, loading, reload } = useLoad<any[]>("meeting.list");
  const [q, setQ] = useState("");
  const [proj, setProj] = useState("");
  const [viewing, setViewing] = useState<string | null>(null);
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const all = (data || []).filter(m => !projectId || m.project_id === projectId);
  const rows = all.filter(m => (!proj || m.project_id === proj) &&
    (!q || [m.title, m.summary, m.decisions, m.notes, m.attendees, m.project_name].some(v => String(v || "").toLowerCase().includes(q.toLowerCase()))));
  const projects = Array.from(new Set(all.map(m => m.project_id).filter(Boolean))) as string[];
  const changed = () => { reload(); onChanged && onChanged(); };
  return <>
    <div className="toolbar">
      {!projectId && <select value={proj} onChange={e => setProj(e.target.value)} aria-label="專案"><option value="">全部專案</option>
        {projects.map(p => <option key={p} value={p}>{lk.projectName(p)}</option>)}</select>}
      <input type="search" placeholder="搜尋會議、摘要、決議、出席" value={q} onChange={e => setQ(e.target.value)} />
      <span className="muted small">{rows.length} 場</span>
      <span className="spacer" />
      <button className="btn primary" onClick={() => setEditing(null)}>＋ 會議紀錄</button>
    </div>
    <Loading error={error} loading={loading && !data} />
    {data && <Table rows={rows} onRow={m => setViewing(m.id)} empty="還沒有會議紀錄。" columns={[
      { key: "d", label: "日期", render: m => shortDate(m.meeting_date) },
      { key: "t", label: "會議", render: m => <><b>{m.title}</b>{m.meeting_type && <small className="muted"> {m.meeting_type}</small>}
        <small className="muted block clamp2">{m.summary || m.notes || ""}</small></> },
      ...(projectId ? [] : [{ key: "p", label: "專案", hideSm: true, render: (m: any) => m.project_name || <span className="muted">—</span> }]),
      { key: "a", label: "待辦", num: true, render: m => m.task_total
        ? <>{m.task_total - m.task_open}/{m.task_total} 完成{m.task_overdue > 0 && <small className="red block">逾期 {m.task_overdue}</small>}</>
        : <span className="muted">—</span> },
    ]} />}
    {viewing && <MeetingDetail id={viewing} onClose={() => setViewing(null)} onChanged={changed}
      onEdit={m => { setViewing(null); setEditing(m); }} />}
    {editing !== undefined && <MeetingForm meeting={editing} projectId={projectId} onClose={() => setEditing(undefined)}
      onSaved={id => { setEditing(undefined); changed(); setViewing(id); }} />}
  </>;
}

function lines(text?: string | null): string[] {
  return String(text || "").split(/\n/).map(s => s.replace(/^[-・•\d.、\s]+/, "").trim()).filter(Boolean);
}

/** 給客戶或同仁的會議摘要文字（複製後貼到 Email 或 LINE）。 */
function summaryText(m: any, tasks: any[], nameOf: (a?: string | null) => string): string {
  const out = ["【會議摘要】" + m.title, "日期：" + m.meeting_date + (m.location ? "　地點：" + m.location : "")];
  if (m.attendees) out.push("出席：" + m.attendees);
  if (m.summary) out.push("", "■ 摘要", m.summary);
  const d = lines(m.decisions);
  if (d.length) out.push("", "■ 決議事項", ...d.map((x, i) => (i + 1) + ". " + x));
  if (tasks.length) out.push("", "■ 待辦事項", ...tasks.map((t, i) => (i + 1) + ". " + t.title + "（" + (t.owner_account ? nameOf(t.owner_account) : "未指定") + (t.due_date ? "，" + t.due_date + " 前" : "") + "）" + (DONE.includes(t.status) ? " ✔" : "")));
  if (m.next_meeting_date) out.push("", "下次會議：" + m.next_meeting_date);
  return out.join("\n");
}

function MeetingDetail({ id, onClose, onChanged, onEdit }: { id: string; onClose: () => void; onChanged: () => void; onEdit: (m: any) => void }) {
  const lk = useLookups();
  const { data, error, reload } = useLoad<any>("meeting.get", { id });
  const { busy, run } = useAction();
  const [adding, setAdding] = useState<any[] | null>(null);
  if (!data) return <Modal title="會議紀錄" onClose={onClose}><Loading error={error} loading /></Modal>;
  const m = data.meeting;
  const setStatus = async (t: any, status: string) => {
    const r = await run(() => call("task.update", { id: t.id, expectedUpdatedAt: t.updated_at, patch: { status } }), "已更新");
    if (r) { reload(); onChanged(); }
  };
  const addTasks = async () => {
    const tasks = (adding || []).filter(i => i.title).map(i => ({ title: i.title, owner_account: i.owner_account || null, due_date: i.due_date || null, project_id: i.project_id || null }));
    const r = await run(() => call("meeting.addTasks", { meeting_id: id, tasks }), "已加入 " + tasks.length + " 項待辦");
    if (r) { setAdding(null); reload(); onChanged(); }
  };
  const remove = async () => {
    if (!confirm("刪除這場會議紀錄？它產生的待辦會保留在專案工作裡。")) return;
    const r = await run(() => call("meeting.delete", { id, expectedUpdatedAt: m.updated_at }), "已刪除");
    if (r) { onChanged(); onClose(); }
  };
  const copy = async () => {
    const text = summaryText(m, data.tasks, lk.nameOf);
    try { await navigator.clipboard.writeText(text); alert("已複製會議摘要，可以貼到 Email 或 LINE。"); }
    catch { prompt("複製下面的文字：", text); }
  };
  const decisions = lines(m.decisions);
  return (
    <Modal wide title={m.title} onClose={onClose}>
      <p className="muted small">{shortDate(m.meeting_date)}{m.meeting_type ? "・" + m.meeting_type : ""}{m.location ? "・" + m.location : ""}{m.project_name ? "・" + m.project_name : ""}{m.attendees ? "・出席：" + m.attendees : ""}</p>
      <h3>會議摘要</h3>
      {m.summary ? <p className="pre">{m.summary}</p> : <p className="muted">還沒有摘要。按「編輯」可以用 AI 從原始紀錄整理。</p>}
      {decisions.length > 0 && <><h3>決議事項</h3><ol>{decisions.map((d, i) => <li key={i}>{d}</li>)}</ol></>}
      <div className="toolbar"><h3>待辦事項</h3><span className="spacer" />
        <button className="btn small" onClick={() => setAdding([{ title: "", owner_account: "", due_date: "", project_id: "" }])}>＋ 追加待辦</button></div>
      <Table rows={data.tasks} empty="這場會議沒有待辦。" columns={[
        { key: "t", label: "待辦", render: t => <><b className={DONE.includes(t.status) ? "muted" : ""}>{t.title}</b>{!m.project_id && t.project_name && <small className="muted block">{t.project_name}</small>}</> },
        { key: "o", label: "負責人", render: t => t.owner_account ? lk.nameOf(t.owner_account) : <span className="muted">未指定</span> },
        { key: "d", label: "截止", render: t => <span className={t.light === "已逾期" ? "red" : ""}>{t.due_date ? shortDate(t.due_date) : "—"}</span> },
        { key: "s", label: "狀態", render: t => <select value={t.status} disabled={busy} onChange={e => setStatus(t, e.target.value)} aria-label="狀態">
          {STATUSES.map(s => <option key={s}>{s}</option>)}</select> },
      ]} />
      {adding && <div className="card">
        <TaskRows items={adding} setItems={setAdding} needProject={!m.project_id} />
        <div className="page-actions"><button className="btn" onClick={() => setAdding(null)}>取消</button><button className="btn primary" disabled={busy} onClick={addTasks}>加入待辦</button></div>
      </div>}
      {m.next_meeting_date && <p>下次會議：<b>{shortDate(m.next_meeting_date)}</b></p>}
      {m.notes && <details><summary className="muted">原始紀錄</summary><p className="pre small">{m.notes}</p></details>}
      <div className="modal-foot">
        <button className="btn danger-link" disabled={busy} onClick={remove}>刪除</button>
        <span className="spacer" />
        <button className="btn" onClick={copy}>複製會議摘要</button>
        <button className="btn primary" onClick={() => onEdit(m)}>編輯</button>
      </div>
    </Modal>
  );
}

function TaskRows({ items, setItems, needProject }: { items: any[]; setItems: (v: any[]) => void; needProject: boolean }) {
  const lk = useLookups();
  const set = (i: number, k: string, v: string) => setItems(items.map((x, j) => j === i ? { ...x, [k]: v } : x));
  return <>
    {items.map((it, i) => (
      <div className={needProject ? "row4" : "row3"} key={i}>
        <input placeholder="待辦事項" value={it.title} onChange={e => set(i, "title", e.target.value)} aria-label="待辦事項" />
        <select value={it.owner_account} onChange={e => set(i, "owner_account", e.target.value)} aria-label="負責人">
          <option value="">負責人</option>{lk.people.filter(p => p.kind !== "派遣").map(p => <option key={p.account} value={p.account}>{p.name}</option>)}
        </select>
        <input type="date" value={it.due_date} onChange={e => set(i, "due_date", e.target.value)} aria-label="截止日" />
        {needProject && <select value={it.project_id || ""} onChange={e => set(i, "project_id", e.target.value)} aria-label="專案" required={!!it.title}>
          <option value="">歸到哪個專案</option>{lk.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>}
      </div>
    ))}
    <button type="button" className="btn small" onClick={() => setItems([...items, { title: "", owner_account: "", due_date: "", project_id: "" }])}>＋ 再一項</button>
  </>;
}

/** 新增或編輯會議。新增時可一併填待辦；「AI 整理」把原始紀錄整理成摘要、決議與待辦，同仁確認後再存。 */
export function MeetingForm({ meeting, projectId, onClose, onSaved }: { meeting: any | null; projectId?: string; onClose: () => void; onSaved: (id: string) => void }) {
  const lk = useLookups();
  const types = useLoad<string[]>("meeting.types");
  const isNew = !meeting;
  const [m, setM] = useState<any>(() => meeting ? { ...meeting } : {
    project_id: projectId || "", title: "", meeting_date: today(), meeting_type: "", location: "", attendees: "", notes: "", summary: "", decisions: "", next_meeting_date: "",
  });
  const [items, setItems] = useState<any[]>([{ title: "", owner_account: "", due_date: "", project_id: "" }]);
  const { busy, run } = useAction();
  const [aiBusy, setAiBusy] = useState(false);
  const set = (k: string, v: any) => setM((x: any) => ({ ...x, [k]: v }));
  const aiTidy = async () => {
    setAiBusy(true);
    try {
      const r = await call<any>("ai.meetingSummary", { notes: m.notes, title: m.title || null, meeting_date: m.meeting_date || null, attendees: m.attendees || null, project_id: m.project_id || null });
      setM((x: any) => ({ ...x, summary: r.summary, decisions: r.decisions.join("\n"), next_meeting_date: r.next_meeting_date || x.next_meeting_date }));
      if (r.actions.length) {
        if (isNew) setItems(r.actions.map((a: any) => ({ ...a, project_id: "" })));
        else alert("AI 另外建議了 " + r.actions.length + " 項待辦：\n" + r.actions.map((a: any) => "・" + a.title).join("\n") + "\n\n存檔後可以在會議裡按「追加待辦」加入。");
      }
    } catch (e) { alert((e as Error).message); }
    setAiBusy(false);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const fields = ["project_id", "title", "meeting_date", "meeting_type", "location", "attendees", "notes", "summary", "decisions", "next_meeting_date"];
    if (isNew) {
      const rec: any = {};
      fields.forEach(f => { if (m[f]) rec[f] = m[f]; });
      const tasks = items.filter(i => i.title).map(i => ({ title: i.title, owner_account: i.owner_account || null, due_date: i.due_date || null, project_id: i.project_id || null }));
      const r = await run(() => call<any>("meeting.create", { meeting: rec, tasks }), "已記錄會議" + (tasks.length ? "，產生 " + tasks.length + " 項待辦" : ""));
      if (r) onSaved(r.meeting.id);
    } else {
      const patch: any = {};
      fields.forEach(f => { if ((meeting[f] ?? "") !== (m[f] ?? "")) patch[f] = m[f] || null; });
      if (!Object.keys(patch).length) { onClose(); return; }
      const r = await run(() => call<any>("meeting.update", { id: meeting.id, expectedUpdatedAt: meeting.updated_at, patch }), "已儲存");
      if (r) onSaved(meeting.id);
    }
  };
  return (
    <Modal wide title={isNew ? "新增會議紀錄" : "編輯會議紀錄"} onClose={onClose}>
      <form onSubmit={save}>
        <div className="form-grid">
          <label className="field"><span>會議名稱 *</span><input required value={m.title} onChange={e => set("title", e.target.value)} /></label>
          <label className="field"><span>日期 *</span><input type="date" required value={m.meeting_date || ""} onChange={e => set("meeting_date", e.target.value)} /></label>
          <label className="field"><span>類型</span><select value={m.meeting_type || ""} onChange={e => set("meeting_type", e.target.value)}>
            <option value="">（不指定）</option>{(types.data || []).map(t => <option key={t}>{t}</option>)}</select></label>
          {!projectId && <label className="field"><span>專案</span><select value={m.project_id || ""} onChange={e => set("project_id", e.target.value)}>
            <option value="">（不屬於專案，例如公司內部會議）</option>{lk.projects.map(p => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}</select></label>}
          <label className="field"><span>地點</span><input value={m.location || ""} onChange={e => set("location", e.target.value)} placeholder="例如：客戶辦公室、Google Meet" /></label>
          <label className="field"><span>出席</span><input value={m.attendees || ""} onChange={e => set("attendees", e.target.value)} placeholder="例如：王科長、Hazel、Amy" /></label>
          <label className="field full"><span>原始紀錄</span><textarea rows={6} value={m.notes || ""} onChange={e => set("notes", e.target.value)} placeholder="會議中的討論，條列或逐字都可以；打完按下面「AI 整理」" /></label>
        </div>
        <div className="toolbar">
          <button type="button" className="btn" disabled={aiBusy || String(m.notes || "").trim().length < 20} onClick={aiTidy}>{aiBusy ? "整理中…" : "✨ AI 整理摘要與待辦"}</button>
          <small className="muted">AI 只給建議，請確認內容再存</small>
        </div>
        <div className="form-grid">
          <label className="field full"><span>會議摘要</span><textarea rows={4} value={m.summary || ""} onChange={e => set("summary", e.target.value)} /></label>
          <label className="field full"><span>決議事項（一行一項）</span><textarea rows={3} value={m.decisions || ""} onChange={e => set("decisions", e.target.value)} /></label>
          <label className="field"><span>下次會議日期</span><input type="date" value={m.next_meeting_date || ""} onChange={e => set("next_meeting_date", e.target.value)} /></label>
        </div>
        {isNew && <>
          <h3>待辦事項（會直接成為專案工作）</h3>
          <TaskRows items={items} setItems={setItems} needProject={!m.project_id} />
        </>}
        <div className="modal-foot"><button type="button" className="btn" onClick={onClose}>取消</button><button className="btn primary" disabled={busy}>儲存</button></div>
      </form>
    </Modal>
  );
}

/** 待辦事項總表：所有會議產生的待辦，可篩我的、逾期，直接改狀態。 */
function ActionItems() {
  const lk = useLookups();
  const [showDone, setShowDone] = useState(false);
  const { data, error, loading, reload } = useLoad<any[]>("meeting.actionItems", { includeDone: showDone });
  const [who, setWho] = useState("mine");
  const [q, setQ] = useState("");
  const { busy, run } = useAction();
  const rows = (data || []).filter(t => (who === "all" || (who === "mine" ? t.owner_account === lk.me.account : who === "overdue" ? t.light === "已逾期" : !t.owner_account)) &&
    (!q || [t.title, t.meeting_title, t.project_name].some(v => String(v || "").toLowerCase().includes(q.toLowerCase()))));
  const setStatus = async (t: any, status: string) => {
    const r = await run(() => call("task.update", { id: t.id, expectedUpdatedAt: t.updated_at, patch: { status } }), "已更新");
    if (r) reload();
  };
  return <>
    <div className="toolbar">
      <Tabs tabs={[["mine", "我的"], ["overdue", "逾期"], ["none", "未指定負責人"], ["all", "全部"]]} value={who} onChange={setWho} />
      <input type="search" placeholder="搜尋待辦、會議、專案" value={q} onChange={e => setQ(e.target.value)} />
      <label className="check"><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)} /> 含已完成</label>
      <span className="muted small">{rows.length} 項</span>
    </div>
    <Loading error={error} loading={loading && !data} />
    {data && <Table rows={rows} empty="沒有符合的待辦。" columns={[
      { key: "t", label: "待辦", render: t => <><b className={DONE.includes(t.status) ? "muted" : ""}>{t.title}</b><small className="muted block">{shortDate(t.meeting_date)} {t.meeting_title}{t.project_name ? "・" + t.project_name : ""}</small></> },
      { key: "o", label: "負責人", render: t => t.owner_account ? lk.nameOf(t.owner_account) : <span className="muted">未指定</span> },
      { key: "d", label: "截止", render: t => <span className={t.light === "已逾期" ? "red" : ""}>{t.due_date ? shortDate(t.due_date) : "—"}</span> },
      { key: "l", label: "燈號", hideSm: true, render: t => t.light ? <Badge text={t.light} /> : null },
      { key: "s", label: "狀態", render: t => <select value={t.status} disabled={busy} onChange={e => setStatus(t, e.target.value)} aria-label="狀態">
        {STATUSES.map(s => <option key={s}>{s}</option>)}</select> },
    ]} />}
  </>;
}
