import { useState } from "react";
import { call } from "../api";
import { Loading, Page, Table, Tabs, useAction, useLoad, useLookups } from "../ui";

function monday(d = new Date()): string {
  const t = new Date(d.getTime() + 8 * 3600e3);
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() - day + 1);
  return t.toISOString().slice(0, 10);
}

export default function Timesheet() {
  const lk = useLookups();
  const [tab, setTab] = useState("mine");
  const [week, setWeek] = useState(monday());
  const mine = useLoad<any[]>("timesheet.mine");
  const team = useLoad<any[]>(tab === "team" ? "timesheet.week" : null, { week_start: week });
  const [entries, setEntries] = useState<any[]>([{ project_id: "", hours: "", blocker: "" }]);
  const { busy, run } = useAction();
  const save = async () => {
    const list = entries.filter(e => Number(e.hours) > 0).map(e => ({ project_id: e.project_id || null, hours: Number(e.hours), blocker: e.blocker || null }));
    const r = await run(() => call("timesheet.save", { week_start: week, entries: list }), "已送出本週工時");
    if (r) mine.reload();
  };
  const load = (w: string) => {
    setWeek(w);
    const rows = (mine.data || []).filter(t => t.week_start === w);
    setEntries(rows.length ? rows.map(r => ({ project_id: r.project_id || "", hours: r.hours, blocker: r.blocker || "" })) : [{ project_id: "", hours: "", blocker: "" }]);
  };
  const tabs: [string, string][] = [["mine", "我的工時"]];
  if (lk.can("admin", "manager")) tabs.push(["team", "團隊"]);
  return (
    <Page title="工時週報" sub="每週填一次各專案投入的時數與卡點；重填會整週取代。">
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="toolbar"><label>週別（週一）<input type="date" value={week} onChange={e => load(e.target.value)} /></label></div>
      {tab === "mine" && <>
        <div className="card">
          {entries.map((e, i) => (
            <div className="row3" key={i}>
              <select value={e.project_id} onChange={x => setEntries(entries.map((y, j) => j === i ? { ...y, project_id: x.target.value } : y))} aria-label="專案">
                <option value="">非專案（行政、內部）</option>{lk.projects.map(p => <option key={p.id} value={p.id}>{p.code} {p.name}</option>)}
              </select>
              <input type="number" min="0" step="0.5" placeholder="小時" value={e.hours} onChange={x => setEntries(entries.map((y, j) => j === i ? { ...y, hours: x.target.value } : y))} aria-label="時數" />
              <input placeholder="卡點（選填）" value={e.blocker} onChange={x => setEntries(entries.map((y, j) => j === i ? { ...y, blocker: x.target.value } : y))} aria-label="卡點" />
            </div>
          ))}
          <div className="toolbar"><button className="btn" onClick={() => setEntries([...entries, { project_id: "", hours: "", blocker: "" }])}>＋ 一列</button><span className="spacer" />
            <b>合計 {entries.reduce((s, e) => s + (Number(e.hours) || 0), 0)} 小時</b><button className="btn primary" disabled={busy} onClick={save}>送出本週</button></div>
        </div>
        <h3>歷史</h3>
        <Loading error={mine.error} loading={mine.loading && !mine.data} />
        {mine.data && <Table rows={mine.data} columns={[{ key: "week_start", label: "週別" }, { key: "p", label: "專案", render: t => t.project_id ? lk.projectName(t.project_id) : "非專案" }, { key: "hours", label: "時數", num: true }, { key: "blocker", label: "卡點" }]} />}
      </>}
      {tab === "team" && <><Loading error={team.error} loading={team.loading && !team.data} />{team.data && <Table rows={team.data} columns={[
        { key: "name", label: "姓名" }, { key: "hours", label: "時數", num: true },
        { key: "missing", label: "", render: r => r.missing ? <span className="red">尚未填報</span> : "" },
      ]} />}</>}
    </Page>
  );
}
