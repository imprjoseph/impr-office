import { useEffect, useState } from "react";
import { call } from "../api";
import { Badge, Loading, Modal, Page, RecordForm, Table, Tabs, useAction, useLoad, useLookups } from "../ui";

const FLAG: Record<string, string> = { LATE: "遲到", EARLY: "早退", UNAPPROVED_OT: "未申請延時" };
const MODE: Record<string, string> = { OFFICE: "辦公室", TRIP: "出差", FIX: "補卡", SITE: "派遣現場" };
const thisMonth = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);

/** 打卡設備識別碼：存在瀏覽器裡，管理者在系統設定登記後，這台設備在辦公室網路打卡才算辦公室打卡。 */
function deviceKey(): string {
  let k = localStorage.getItem("impr_device_key");
  if (!k) { k = "dev-" + crypto.randomUUID(); localStorage.setItem("impr_device_key", k); }
  return k;
}

export default function Attendance() {
  const lk = useLookups();
  const tabs: [string, string][] = [["mine", "我的出勤"]];
  if (lk.can("admin", "manager")) tabs.push(["review", "待我審核"]);
  if (lk.can("admin", "manager", "accountant")) tabs.push(["monthly", "月報"]);
  const [tab, setTab] = useState("mine");
  return (
    <Page title="考勤" sub="辦公室網路＋登記設備打卡算辦公室打卡，其他地方打卡算出差、需主管確認；加班須事前申請。">
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "mine" && <Mine />}
      {tab === "review" && <Review />}
      {tab === "monthly" && <Monthly />}
    </Page>
  );
}

/** 我的出勤。派遣人員用 dispatch.* 的同一套功能（api 前綴不同），打卡在「今天」分頁。 */
export function Mine({ api = "attendance." }: { api?: string }) {
  const self = api === "attendance." ? { mine: "attendance.mine", options: "attendance.options" } : { mine: api + "attendanceMine", options: api + "attendanceOptions" };
  const lk = useLookups();
  const [month, setMonth] = useState(thisMonth());
  const { data, error, loading, reload } = useLoad<any>(self.mine, { month });
  const opts = useLoad<any>(self.options);
  const [form, setForm] = useState<string | null>(null);
  const [trip, setTrip] = useState<string | null>(null);
  const [ip, setIp] = useState("");
  const { busy, run } = useAction();
  useEffect(() => { fetch("https://api.ipify.org?format=json").then(r => r.json()).then(j => setIp(j.ip)).catch(() => setIp("")); }, []);
  const punch = async (p: string, extra?: any) => {
    const r = await run(() => call<any>("attendance.punch", Object.assign({ punch: p, ip, device_key: deviceKey() }, extra || {})));
    if (r) { alert((p === "IN" ? "上班" : "下班") + "打卡成功 " + r.record.punch_time.slice(0, 5) + (r.record.mode === "TRIP" ? "（出差，待主管確認）" : "") + (r.flags.length ? "・" + r.flags.join("、") : "")); setTrip(null); reload(); }
    else if (!extra) setTrip(p); // 不在辦公室：改填出差資訊
  };
  const tripSubmit = async (v: any) => {
    const geo = await new Promise<any>(res => navigator.geolocation ? navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }), () => res({}), { timeout: 8000 }) : res({}));
    punch(trip!, Object.assign({}, v, geo));
  };
  const apply = async (kind: string, v: any) => {
    const action = api + ({ leave: "applyLeave", overtime: "applyOvertime", correction: "applyCorrection" } as Record<string, string>)[kind];
    const r = await run(() => call(action, { record: v }), "已送出，等待主管審核");
    if (r) { setForm(null); reload(); }
  };
  const cancelLeave = async (l: any) => {
    const r = await run(() => call(api + "cancelLeave", { id: l.id, expectedUpdatedAt: l.updated_at }), "已取消假單");
    if (r) reload();
  };
  const today = data?.today;
  const todayRecs = (data?.attendance || []).filter((a: any) => a.work_date === today);
  return (
    <>
      {api === "attendance." && <div className="punch card">
        <div>
          <b>今天 {today ? today.replace(/-/g, "/") : ""}</b>
          <p className="muted">上班 {todayRecs.find((a: any) => a.punch === "IN")?.punch_time?.slice(0, 5) || "—"}・下班 {todayRecs.find((a: any) => a.punch === "OUT")?.punch_time?.slice(0, 5) || "—"}・補休餘額 {data?.compBalance ?? "—"} 小時</p>
        </div>
        <div className="punch-btns">
          <button className="btn primary big" disabled={busy} onClick={() => punch("IN")}>上班打卡</button>
          <button className="btn big" disabled={busy} onClick={() => punch("OUT")}>下班打卡</button>
        </div>
      </div>}
      <div className="toolbar">
        <input type="month" value={month} onChange={e => setMonth(e.target.value)} aria-label="月份" />
        <span className="spacer" />
        <button className="btn" onClick={() => setForm("leave")}>請假</button>
        <button className="btn" onClick={() => setForm("overtime")}>申請加班</button>
        <button className="btn" onClick={() => setForm("correction")}>補卡</button>
      </div>
      <Loading error={error} loading={loading && !data} />
      {data && <>
        <h3>打卡紀錄</h3>
        <Table rows={data.attendance} empty="這個月沒有打卡紀錄。" columns={[
          { key: "d", label: "日期", render: a => a.work_date.slice(5).replace("-", "/") },
          { key: "p", label: "", render: a => a.punch === "IN" ? "上班" : "下班" },
          { key: "t", label: "時間", render: a => a.punch_time.slice(0, 5) },
          { key: "m", label: "方式", render: a => MODE[a.mode] || a.mode },
          { key: "s", label: "狀態", render: a => <>{a.status !== "正常" && <Badge text={a.status} />} {String(a.flag || "").split(",").filter(Boolean).map((f: string) => <Badge key={f} text={FLAG[f]} tone="red" />)}</> },
        ]} />
        <h3>請假、加班、補卡</h3>
        <Table rows={[...data.leaves.map((l: any) => ({ ...l, k: "請假" })), ...data.overtime.map((o: any) => ({ ...o, k: "加班" })), ...data.corrections.map((c: any) => ({ ...c, k: "補卡" }))]}
          empty="這個月沒有申請。" columns={[
            { key: "k", label: "類型", render: r => r.k + (r.leave_type ? "・" + r.leave_type : "") },
            { key: "when", label: "時間", render: r => r.k === "請假" ? r.start_date.slice(5) + " " + r.start_time + "～" + r.end_date.slice(5) + " " + r.end_time : r.k === "加班" ? r.work_date.slice(5) + " " + r.plan_start + "–" + r.plan_end : r.work_date.slice(5) + " " + r.request_time },
            { key: "h", label: "時數", num: true, render: r => r.hours ?? r.actual_hours ?? "—" },
            { key: "s", label: "狀態", render: r => <><Badge text={r.status} />{r.review_note && <small className="muted block">{r.review_note}</small>}</> },
            { key: "x", label: "", render: r => r.k === "請假" && r.status === "待審" ? <button className="btn small" onClick={() => cancelLeave(r)}>取消</button> : null },
          ]} />
      </>}
      {trip && (
        <Modal title="出差打卡" onClose={() => setTrip(null)}>
          <p className="muted">目前不是在辦公室網路的登記設備上，會記成出差打卡，由主管確認。</p>
          <RecordForm busy={busy} initial={undefined} onCancel={() => setTrip(null)} onSubmit={tripSubmit} submitLabel="打卡" fields={[
            { name: "location", label: "地點", required: true, full: true },
            { name: "reason", label: "事由", type: "select", options: opts.data?.tripReasons || [], required: true },
            { name: "reason_note", label: "說明（事由選其他時必填）", full: true },
          ]} />
        </Modal>
      )}
      {form === "leave" && <Modal title="請假" onClose={() => setForm(null)}><RecordForm busy={busy} initial={undefined} onCancel={() => setForm(null)} onSubmit={v => apply("leave", v)} submitLabel="送出" fields={[
        { name: "leave_type", label: "假別", type: "select", options: opts.data?.leaveTypes || [], required: true },
        { name: "start_date", label: "開始日", type: "date", required: true }, { name: "start_time", label: "開始時間", type: "time", required: true, hint: "以 30 分鐘為單位" },
        { name: "end_date", label: "結束日", type: "date", required: true }, { name: "end_time", label: "結束時間", type: "time", required: true },
        { name: "reason", label: "事由", type: "textarea", required: true },
      ]} /></Modal>}
      {form === "overtime" && <Modal title="申請加班（須事前申請）" onClose={() => setForm(null)}><RecordForm busy={busy} initial={undefined} onCancel={() => setForm(null)} onSubmit={v => apply("overtime", v)} submitLabel="送出" fields={[
        { name: "work_date", label: "日期", type: "date", required: true }, { name: "project_id", label: "專案", type: "project" },
        { name: "plan_start", label: "開始", type: "time", required: true }, { name: "plan_end", label: "結束", type: "time", required: true },
        { name: "reason", label: "事由", type: "textarea", required: true },
      ]} /></Modal>}
      {form === "correction" && <Modal title="補卡" onClose={() => setForm(null)}><RecordForm busy={busy} initial={undefined} onCancel={() => setForm(null)} onSubmit={v => apply("correction", v)} submitLabel="送出" fields={[
        { name: "work_date", label: "日期", type: "date", required: true }, { name: "punch", label: "補哪一張卡", type: "select", options: [["IN", "上班卡"], ["OUT", "下班卡"]], required: true },
        { name: "request_time", label: "實際時間", type: "time", required: true }, { name: "reason", label: "原因", type: "textarea", required: true },
      ]} /></Modal>}
    </>
  );
}

function Review() {
  const lk = useLookups();
  const { data, error, loading, reload } = useLoad<any>("attendance.pending");
  const { busy, run } = useAction();
  const review = async (kind: string, r: any, approve: boolean) => {
    const note = prompt((approve ? "核准" : "駁回") + "理由（至少 5 個字）");
    if (note === null) return;
    const ok = await run(() => call("attendance.review", { kind, id: r.id, expectedUpdatedAt: r.updated_at, approve, note }), approve ? "已核准" : "已駁回");
    if (ok) reload();
  };
  const trips = async (approve: boolean) => {
    const note = approve ? "" : prompt("退回理由（至少 5 個字）");
    if (note === null) return;
    const ok = await run(() => call("attendance.reviewTrips", { ids: data.trips.map((t: any) => t.id), approve, note }), approve ? "已確認出差打卡" : "已退回");
    if (ok) reload();
  };
  if (!data) return <Loading error={error} loading={loading} />;
  const actions = (kind: string) => (r: any) => <><button className="btn small" disabled={busy} onClick={() => review(kind, r, false)}>駁回</button> <button className="btn small primary" disabled={busy} onClick={() => review(kind, r, true)}>核准</button></>;
  return (
    <>
      <h3>請假（{data.leaves.length}）</h3>
      <Table rows={data.leaves} empty="沒有待審假單。" columns={[
        { key: "who", label: "申請人", render: r => lk.nameOf(r.account) }, { key: "t", label: "假別", render: r => r.leave_type + " " + r.hours + " 小時" },
        { key: "w", label: "時間", render: r => r.start_date.slice(5) + " " + r.start_time + "～" + r.end_date.slice(5) + " " + r.end_time },
        { key: "reason", label: "事由", hideSm: true }, { key: "a", label: "", render: actions("leave") },
      ]} />
      <h3>加班（{data.overtime.length}）</h3>
      <Table rows={data.overtime} empty="沒有待審加班。" columns={[
        { key: "who", label: "申請人", render: r => lk.nameOf(r.account) }, { key: "w", label: "時間", render: r => r.work_date.slice(5) + " " + r.plan_start + "–" + r.plan_end },
        { key: "reason", label: "事由" }, { key: "a", label: "", render: actions("overtime") },
      ]} />
      <h3>補卡（{data.corrections.length}）</h3>
      <Table rows={data.corrections} empty="沒有待審補卡。" columns={[
        { key: "who", label: "申請人", render: r => lk.nameOf(r.account) }, { key: "w", label: "時間", render: r => r.work_date.slice(5) + " " + (r.punch === "IN" ? "上班" : "下班") + " " + r.request_time },
        { key: "reason", label: "原因" }, { key: "a", label: "", render: actions("correction") },
      ]} />
      <div className="toolbar"><h3>出差打卡（{data.trips.length}）</h3><span className="spacer" />
        {data.trips.length > 0 && <><button className="btn small" disabled={busy} onClick={() => trips(false)}>全部退回</button><button className="btn small primary" disabled={busy} onClick={() => trips(true)}>全部確認</button></>}
      </div>
      <Table rows={data.trips} empty="沒有待確認的出差打卡。" columns={[
        { key: "who", label: "同仁", render: r => lk.nameOf(r.account) }, { key: "w", label: "時間", render: r => r.work_date.slice(5) + " " + (r.punch === "IN" ? "上班" : "下班") + " " + r.punch_time.slice(0, 5) },
        { key: "location", label: "地點" }, { key: "reason", label: "事由", hideSm: true },
      ]} />
    </>
  );
}

function Monthly() {
  const [month, setMonth] = useState(thisMonth());
  const { data, error, loading } = useLoad<any[]>("attendance.monthly", { month });
  return (
    <>
      <div className="toolbar"><input type="month" value={month} onChange={e => setMonth(e.target.value)} aria-label="月份" /></div>
      <Loading error={error} loading={loading && !data} />
      {data && <Table rows={data} columns={[
        { key: "name", label: "姓名" }, { key: "dept", label: "部門", hideSm: true }, { key: "days", label: "出勤天數", num: true },
        { key: "late", label: "遲到", num: true, render: r => <span className={r.late ? "red" : ""}>{r.late}</span> },
        { key: "early", label: "早退", num: true }, { key: "unapprovedOt", label: "未申請延時", num: true },
        { key: "leaveHours", label: "請假時數", num: true }, { key: "overtimeHours", label: "加班時數", num: true },
      ]} />}
    </>
  );
}
