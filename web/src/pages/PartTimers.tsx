/** 工讀生：名冊（聯絡方式、專長、語言）、合作紀錄與評價。找人時可依專長、地區、評分篩選。 */
import { useState } from "react";
import { call } from "../api";
import { Badge, Field, Loading, Modal, Page, RecordForm, Table, shortDate, useAction, useLoad, useLookups } from "../ui";
import { ContactInfo } from "./Partners";

const stars = (n: number | null) => n == null ? "尚無評價" : "★".repeat(Math.round(n)) + "☆".repeat(5 - Math.round(n)) + " " + n;

export default function PartTimers() {
  const list = useLoad<any[]>("partTimer.list");
  const opts = useLoad<any>("partTimer.options");
  const [q, setQ] = useState("");
  const [skill, setSkill] = useState("");
  const [status, setStatus] = useState("可合作");
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const [viewing, setViewing] = useState<any | null>(null);
  const { busy, run } = useAction();
  const rows = (list.data || []).filter(p => (!status || p.status === status) && (!skill || String(p.skills || "").includes(skill)) &&
    (!q || [p.name, p.region, p.school, p.skills, p.languages, p.mobile, p.phone].some(v => String(v || "").toLowerCase().includes(q.toLowerCase()))))
    .sort((a, b) => (b.avg_rating ?? 0) - (a.avg_rating ?? 0));
  const fields: Field[] = [
    { name: "name", label: "姓名", required: true }, { name: "status", label: "狀態", type: "select", options: opts.data?.statuses || [] },
    { name: "mobile", label: "手機" }, { name: "phone", label: "電話" }, { name: "email", label: "Email", type: "email" }, { name: "line_id", label: "LINE ID" },
    { name: "region", label: "地區" }, { name: "school", label: "學校／科系" },
    { name: "skills", label: "專長", type: "multi", options: opts.data?.skills || [], full: true },
    { name: "languages", label: "語言", type: "multi", options: opts.data?.languages || [], full: true },
    { name: "account", label: "系統帳號（有派遣帳號才填）" }, { name: "note", label: "備註（可配合時段、注意事項）", type: "textarea" },
  ];
  const save = async (v: any) => {
    const r = await run(() => editing ? call("partTimer.update", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: v }) : call("partTimer.create", { record: v }), "已儲存");
    if (r) { setEditing(undefined); list.reload(); }
  };
  return (
    <Page title="工讀生" sub="工讀生名冊與合作紀錄。每次合作後記一筆評價，下次找人時依專長與評分挑選。至少要填一種聯絡方式。"
      actions={<button className="btn primary" onClick={() => setEditing(null)}>＋ 新增工讀生</button>}>
      <div className="toolbar">
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label="狀態"><option value="">全部狀態</option>{(opts.data?.statuses || []).map((s: string) => <option key={s}>{s}</option>)}</select>
        <select value={skill} onChange={e => setSkill(e.target.value)} aria-label="專長"><option value="">全部專長</option>{(opts.data?.skills || []).map((s: string) => <option key={s}>{s}</option>)}</select>
        <input type="search" placeholder="搜尋姓名、地區、學校、語言" value={q} onChange={e => setQ(e.target.value)} />
        <span className="muted">{rows.length} 人</span>
      </div>
      <Loading error={list.error} loading={list.loading && !list.data} />
      {list.data && <Table rows={rows} onRow={p => setViewing(p)} empty="沒有符合的工讀生。" columns={[
        { key: "name", label: "姓名", render: p => <><b>{p.name}</b>{p.status !== "可合作" && <> <Badge text={p.status} tone={p.status === "不再合作" ? "red" : ""} /></>}
          <small className="muted block">{[p.region, p.school].filter(Boolean).join("・")}</small></> },
        { key: "reach", label: "聯絡方式", render: p => <ContactInfo phone={p.phone} mobile={p.mobile} email={p.email} line={p.line_id} /> },
        { key: "skills", label: "專長／語言", hideSm: true, render: p => [p.skills, p.languages].filter(Boolean).join("；") || "—" },
        { key: "rating", label: "評價", render: p => <><span className="stars">{stars(p.avg_rating)}</span><small className="muted block">合作 {p.job_count} 次{p.last_work_date ? "・最近 " + shortDate(p.last_work_date) : ""}</small></> },
      ]} />}
      {editing !== undefined && <Modal title={editing ? editing.name : "新增工讀生"} onClose={() => setEditing(undefined)} wide>
        <RecordForm busy={busy} initial={editing || { status: "可合作" }} onCancel={() => setEditing(undefined)} onSubmit={save} fields={fields} />
      </Modal>}
      {viewing && <Jobs person={viewing} onEdit={() => { setEditing(viewing); setViewing(null); }} onClose={() => { setViewing(null); list.reload(); }} />}
    </Page>
  );
}

function Jobs({ person, onEdit, onClose }: { person: any; onEdit: () => void; onClose: () => void }) {
  const lk = useLookups();
  const jobs = useLoad<any[]>("partTimer.jobs", { part_timer_id: person.id });
  const [editing, setEditing] = useState<any | null | undefined>(undefined);
  const { busy, run } = useAction();
  const save = async (v: any) => {
    const r = await run(() => editing
      ? call("partTimer.updateJob", { id: editing.id, expectedUpdatedAt: editing.updated_at, patch: v })
      : call("partTimer.addJob", { record: Object.assign({ part_timer_id: person.id }, v) }), "已儲存");
    if (r) { setEditing(undefined); jobs.reload(); }
  };
  const remove = async () => {
    if (!editing || !confirm("確定刪除這筆合作紀錄？")) return;
    const r = await run(() => call("partTimer.deleteJob", { id: editing.id, expectedUpdatedAt: editing.updated_at }), "已刪除");
    if (r) { setEditing(undefined); jobs.reload(); }
  };
  return (
    <Modal title={person.name} onClose={onClose} wide>
      <dl className="dl">
        <dt>聯絡</dt><dd><ContactInfo phone={person.phone} mobile={person.mobile} email={person.email} line={person.line_id} /></dd>
        <dt>專長</dt><dd>{person.skills || "—"}</dd><dt>語言</dt><dd>{person.languages || "—"}</dd>
        <dt>評價</dt><dd>{stars(person.avg_rating)}（{person.job_count} 次）</dd>
        {person.note && <><dt>備註</dt><dd className="pre">{person.note}</dd></>}
      </dl>
      <div className="toolbar"><h3>合作案例與評價</h3><span className="spacer" />
        <button className="btn small" onClick={onEdit}>編輯基本資料</button>
        <button className="btn small primary" onClick={() => setEditing(null)}>＋ 新增合作紀錄</button></div>
      <Loading error={jobs.error} loading={jobs.loading && !jobs.data} />
      {jobs.data && <Table rows={jobs.data} onRow={j => setEditing(j)} empty="還沒有合作紀錄。" columns={[
        { key: "d", label: "日期", render: j => shortDate(j.work_date) },
        { key: "p", label: "專案／工作", render: j => <><b>{j.project_name || "（未指定專案）"}</b><small className="muted block">{j.role || ""}</small></> },
        { key: "r", label: "評分", render: j => j.rating ? "★".repeat(j.rating) : "—" },
        { key: "c", label: "評語", render: j => <>{j.comment || "—"}{j.rated_by && <small className="muted block">{lk.nameOf(j.rated_by)} 評</small>}</> },
      ]} />}
      {editing !== undefined && <Modal title={editing ? "合作紀錄" : "新增合作紀錄"} onClose={() => setEditing(undefined)}>
        <RecordForm busy={busy} initial={editing ? { ...editing, rating: editing.rating ? String(editing.rating) : null } : undefined} onCancel={() => setEditing(undefined)} onSubmit={save} fields={[
          { name: "project_id", label: "專案", type: "project" }, { name: "work_date", label: "日期", type: "date", required: true },
          { name: "role", label: "工作內容（報到台、引導…）" },
          { name: "rating", label: "評分", type: "select", options: [["5", "★★★★★ 非常好，優先找"], ["4", "★★★★ 好"], ["3", "★★★ 普通"], ["2", "★★ 待加強"], ["1", "★ 不建議再合作"]] },
          { name: "comment", label: "評語", type: "textarea" },
        ]} extra={editing && <button type="button" className="btn danger-link" onClick={remove}>刪除這筆</button>} />
      </Modal>}
    </Modal>
  );
}
