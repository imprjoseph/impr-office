import { useState } from "react";
import { call } from "../api";
import { Badge, Loading, Modal, Page, RecordForm, Table, Tabs, money, shortDate, useAction, useLoad, useLookups } from "../ui";
import { Mine as MyAttendance } from "./Attendance";

export function Dispatch() {
  const lk = useLookups();
  const [tab, setTab] = useState("assign");
  const { data, error, loading, reload } = useLoad<any[]>("dispatch.list");
  const reports = useLoad<any[]>(tab === "reports" ? "dispatch.reports" : null);
  const issues = useLoad<any[]>(tab === "issues" ? "dispatch.issues" : null);
  const [adding, setAdding] = useState(false);
  const { busy, run } = useAction();
  const finance = lk.can("admin", "manager", "accountant");
  const assign = async (v: any) => {
    const r = await run(() => call("dispatch.assign", { record: v }), "已排班");
    if (r) { setAdding(false); reload(); }
  };
  const cancel = async (a: any) => {
    if (!confirm("取消 " + a.name + " 在「" + a.project_name + "」的排班？")) return;
    const r = await run(() => call("dispatch.cancel", { id: a.id, expectedUpdatedAt: a.updated_at }), "已取消排班");
    if (r) reload();
  };
  const reply = async (i: any) => {
    const text = prompt("回覆「" + i.title + "」");
    if (!text) return;
    const r = await run(() => call("dispatch.replyIssue", { id: i.id, expectedUpdatedAt: i.updated_at, reply: text }), "已回覆");
    if (r) issues.reload();
  };
  return (
    <Page title="派遣" sub="派遣人員要先排班才能打卡；工時 × 時薪自動計入專案人力成本。"
      actions={tab === "assign" && <button className="btn primary" onClick={() => setAdding(true)}>＋ 排班</button>}>
      <Tabs tabs={[["assign", "排班"], ["roster", "派遣名冊"], ["reports", "工作回報"], ["issues", "問題回報"]]} value={tab} onChange={setTab} />
      {tab === "assign" && <>
        <Loading error={error} loading={loading && !data} />
        {data && <Table rows={data} empty="還沒有排班。" columns={[
          { key: "status", label: "狀態", render: a => <Badge text={a.status} tone={a.status === "派遣中" ? "green" : ""} /> },
          { key: "name", label: "人員", render: a => <><b>{a.name}</b><small className="muted block">{a.role || ""}</small></> },
          { key: "project", label: "專案", render: a => a.project_name },
          { key: "range", label: "期間", render: a => shortDate(a.start_date) + "–" + shortDate(a.end_date) },
          ...(finance ? [{ key: "wage", label: "時薪", num: true, render: (a: any) => money(a.hourly_wage) }] : []),
          { key: "x", label: "", render: a => a.status === "派遣中" ? <button className="btn small" disabled={busy} onClick={() => cancel(a)}>取消</button> : null },
        ]} />}
      </>}
      {tab === "roster" && <Table rows={lk.people.filter(p => p.kind === "派遣")} empty="沒有派遣人員。請在帳號中心新增類型為「派遣」的帳號，再到人員頁同步。" columns={[
        { key: "name", label: "姓名" }, { key: "region", label: "地區" }, { key: "phone", label: "電話" },
        { key: "contract", label: "合約", render: p => (p.contract_start || "—") + " ～ " + (p.contract_end || "—") },
      ]} />}
      {tab === "reports" && <><Loading error={reports.error} loading={reports.loading && !reports.data} />{reports.data && <Table rows={reports.data} empty="沒有工作回報。" columns={[
        { key: "d", label: "日期", render: r => shortDate(r.report_date) }, { key: "who", label: "人員", render: r => lk.nameOf(r.account) },
        { key: "p", label: "專案", render: r => lk.projectName(r.project_id) }, { key: "content", label: "內容" }, { key: "hours", label: "時數", num: true },
      ]} />}</>}
      {tab === "issues" && <><Loading error={issues.error} loading={issues.loading && !issues.data} />{issues.data && <Table rows={issues.data} empty="沒有問題回報。" columns={[
        { key: "s", label: "狀態", render: i => <Badge text={i.status} /> }, { key: "who", label: "人員", render: i => lk.nameOf(i.account) },
        { key: "t", label: "問題", render: i => <><b>{i.title}</b><small className="muted block">{i.detail || ""}{i.reply ? "　回覆：" + i.reply : ""}</small></> },
        { key: "x", label: "", render: i => i.status !== "已處理" ? <button className="btn small" onClick={() => reply(i)}>回覆</button> : null },
      ]} />}</>}
      {adding && (
        <Modal title="排班" onClose={() => setAdding(false)}>
          <RecordForm busy={busy} initial={undefined} onCancel={() => setAdding(false)} onSubmit={assign} submitLabel="排班" fields={[
            { name: "account", label: "派遣人員", type: "person", required: true, filter: p => p.kind === "派遣" },
            { name: "project_id", label: "專案", type: "project", required: true },
            { name: "start_date", label: "開始", type: "date", required: true }, { name: "end_date", label: "結束", type: "date", required: true },
            { name: "role", label: "工作內容" }, ...(finance ? [{ name: "hourly_wage", label: "時薪（計算專案人力成本）", type: "number" as const }] : []),
            { name: "note", label: "備註", type: "textarea" },
          ]} />
        </Modal>
      )}
    </Page>
  );
}

/** 派遣人員自己的頁面：今天的排班、打卡、工作回報、問題回報、請假。 */
export function DispatchMe() {
  const { data, error, loading, reload } = useLoad<any>("dispatch.mine");
  const [tab, setTab] = useState("today");
  const [form, setForm] = useState<string | null>(null);
  const { busy, run } = useAction();
  const punch = async (p: string) => {
    const geo = await new Promise<any>(res => navigator.geolocation ? navigator.geolocation.getCurrentPosition(x => res({ lat: x.coords.latitude, lng: x.coords.longitude }), () => res({}), { timeout: 8000 }) : res({}));
    const r = await run(() => call<any>("dispatch.punch", Object.assign({ punch: p }, geo)), (p === "IN" ? "上班" : "下班") + "打卡成功");
    if (r) reload();
  };
  const submit = async (kind: string, v: any) => {
    const r = await run(() => call(kind === "report" ? "dispatch.report" : "dispatch.raiseIssue", { record: Object.assign({ project_id: data?.todayAssignment?.project_id || null }, v) }), "已送出");
    if (r) { setForm(null); reload(); }
  };
  if (!data) return <Page title="我的派遣"><Loading error={error} loading={loading} /></Page>;
  const a = data.todayAssignment;
  const t = (p: string) => data.punches.find((x: any) => x.punch === p)?.punch_time?.slice(0, 5) || "—";
  return (
    <Page title="我的派遣">
      <Tabs tabs={[["today", "今天"], ["schedule", "我的排班"], ["leave", "請假與紀錄"]]} value={tab} onChange={setTab} />
      {tab === "today" && <>
        <div className="punch card">
          <div>{a ? <><b>{a.project_name}</b><p className="muted">{a.venue || "地點請洽負責同仁"}・{a.role || ""}</p></> : <b>今天沒有排班</b>}
            <p className="muted">上班 {t("IN")}・下班 {t("OUT")}</p></div>
          <div className="punch-btns">
            <button className="btn primary big" disabled={busy || !a} onClick={() => punch("IN")}>上班打卡</button>
            <button className="btn big" disabled={busy || !a} onClick={() => punch("OUT")}>下班打卡</button>
          </div>
        </div>
        <div className="toolbar"><button className="btn" onClick={() => setForm("report")}>工作回報</button><button className="btn" onClick={() => setForm("issue")}>問題回報</button></div>
        <h3>最近的回報</h3>
        <Table rows={data.reports} empty="還沒有回報。" columns={[{ key: "d", label: "日期", render: r => shortDate(r.report_date) }, { key: "content", label: "內容" }, { key: "hours", label: "時數", num: true }]} />
        <h3>我的問題</h3>
        <Table rows={data.issues} empty="沒有問題回報。" columns={[{ key: "s", label: "狀態", render: i => <Badge text={i.status} /> }, { key: "title", label: "問題" }, { key: "reply", label: "回覆" }]} />
      </>}
      {tab === "schedule" && <Table rows={data.assignments} empty="目前沒有排班。" columns={[
        { key: "range", label: "日期", render: x => shortDate(x.start_date) + "–" + shortDate(x.end_date) }, { key: "project_name", label: "活動" },
        { key: "venue", label: "地點" }, { key: "role", label: "工作內容" }, { key: "wage", label: "時薪", num: true, render: x => money(x.hourly_wage) },
      ]} />}
      {tab === "leave" && <MyAttendance api="dispatch." />}
      {form && (
        <Modal title={form === "report" ? "工作回報" : "問題回報"} onClose={() => setForm(null)}>
          <RecordForm busy={busy} initial={undefined} onCancel={() => setForm(null)} onSubmit={v => submit(form, v)} submitLabel="送出" fields={form === "report"
            ? [{ name: "content", label: "今天做了什麼", type: "textarea", required: true }, { name: "hours", label: "時數", type: "number" }]
            : [{ name: "title", label: "問題", required: true, full: true }, { name: "detail", label: "說明", type: "textarea" }]} />
        </Modal>
      )}
    </Page>
  );
}

