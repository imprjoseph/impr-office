import { Badge, Empty, Loading, Page, money, pct, shortDate, useLoad, useLookups } from "../ui";
import { DispatchMe } from "./Dispatch";

export default function Dashboard() {
  const { me } = useLookups();
  // 派遣人員的首頁是「我的派遣」，不讀內部工作台（後端也只回派遣資料）。
  const { data, error, loading } = useLoad<any>(me.role === "dispatch" ? null : "dashboard.me");
  if (me.role === "dispatch") return <DispatchMe />;
  return (
    <Page title={"早安，" + me.name} sub={data?.today ? "今天 " + data.today.replace(/-/g, "/") : undefined}>
      <Loading error={error} loading={loading && !data} />
      {data?.lights && (
        <>
          <div className="stats">
            <a className="stat" href="#/projects"><b className="red">{data.lights.red}</b><span>紅燈專案</span></a>
            <a className="stat" href="#/projects"><b className="yellow">{data.lights.yellow}</b><span>黃燈專案</span></a>
            <a className="stat" href="#/projects"><b>{data.myTasks.length}</b><span>我的未完成工作</span></a>
            {data.approvals && <a className="stat" href="#/expenses"><b>{data.approvals.expenses + data.approvals.leaves + data.approvals.overtime + data.approvals.corrections + data.approvals.trips}</b><span>待我審核</span></a>}
            {data.finance && data.finance.toPay !== null && <a className="stat" href="#/expenses"><b>{data.finance.toPay}</b><span>待付款</span></a>}
          </div>
          <div className="grid2">
            <section className="card">
              <h2>我的工作</h2>
              {data.myTasks.length ? (
                <ul className="list">
                  {data.myTasks.map((t: any) => (
                    <li key={t.id}><a href={"#/projects/" + t.project_id}>
                      <b>{t.title}</b>
                      <span className="meta"><Badge text={t.light} /> {t.due_date ? "截止 " + shortDate(t.due_date) : "沒有截止日"}・{t.project_name}{t.next_step ? "・下一步：" + t.next_step : ""}</span>
                    </a></li>
                  ))}
                </ul>
              ) : <Empty text="目前沒有指派給你、還沒完成的工作。" />}
            </section>
            <section className="card">
              <h2>我是 PM 的專案</h2>
              {data.myProjects.length ? (
                <ul className="list">
                  {data.myProjects.map((p: any) => (
                    <li key={p.id}><a href={"#/projects/" + p.id}>
                      <b>{p.name}</b>
                      <span className="meta"><Badge text={p.light} /> {p.stage}・完成 {p.stats.done}/{p.stats.total}{p.margin_rate != null ? "・毛利 " + pct(p.margin_rate) : ""}</span>
                    </a></li>
                  ))}
                </ul>
              ) : <Empty text="目前沒有你負責的進行中專案。" />}
            </section>
            <section className="card">
              <h2>這 7 天的活動</h2>
              {data.thisWeek.length ? (
                <ul className="list">{data.thisWeek.map((p: any) => (
                  <li key={p.id}><a href={"#/projects/" + p.id}><b>{p.name}</b><span className="meta">{shortDate(p.start_date)}・{p.venue || "地點未定"}・PM {p.pm_account || "—"}</span></a></li>
                ))}</ul>
              ) : <Empty text="這 7 天內沒有活動。" />}
            </section>
            {data.tenders.length > 0 && (
              <section className="card">
                <h2>標案截標（14 天內）</h2>
                <ul className="list">{data.tenders.map((t: any) => (
                  <li key={t.id}><a href="#/tenders"><b>{t.title}</b><span className="meta">截標 {shortDate(t.deadline_date)}・{t.agency}</span></a></li>
                ))}</ul>
              </section>
            )}
            {data.finance && data.finance.marginAlerts.length > 0 && (
              <section className="card">
                <h2>毛利警示</h2>
                <ul className="list">{data.finance.marginAlerts.map((p: any) => (
                  <li key={p.id}><a href={"#/projects/" + p.id}><b>{p.name}</b><span className="meta red">毛利率 {pct(p.margin_rate)}</span></a></li>
                ))}</ul>
              </section>
            )}
            {(data.myExpenses.length > 0 || data.myLoans.length > 0) && (
              <section className="card">
                <h2>我的請款與借用</h2>
                <ul className="list">
                  {data.myExpenses.map((e: any) => <li key={e.id}><a href="#/expenses"><b>{e.description}</b><span className="meta">{money(e.amount)} 元・<Badge text={EXPENSE_LABEL[e.status] || e.status} /></span></a></li>)}
                  {data.myLoans.map((l: any) => <li key={l.id}><a href="#/resources"><b>借用：{l.item_name} × {l.quantity}</b><span className={"meta" + (l.overdue ? " red" : "")}>{l.due_date ? "歸還日 " + shortDate(l.due_date) : "未定歸還日"}{l.overdue ? "・已逾期" : ""}</span></a></li>)}
                </ul>
              </section>
            )}
          </div>
        </>
      )}
    </Page>
  );
}

export const EXPENSE_LABEL: Record<string, string> = { draft: "草稿", submitted: "待主管核准", approved: "待付款", paid: "已付款", rejected: "已退回" };
