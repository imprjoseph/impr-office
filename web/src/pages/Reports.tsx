import { Loading, Page, Table, money, pct, useLoad, useLookups } from "../ui";

export default function Reports() {
  const lk = useLookups();
  const { data, error, loading } = useLoad<any[]>("budget.report");
  const rows = data || [];
  const sum = (k: string) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  return (
    <Page title="毛利報表" sub="每個專案的報價、成本與毛利；成本含已核准費用與派遣人力。">
      <Loading error={error} loading={loading && !data} />
      {data && <>
        <div className="stats">
          <div className="stat"><b>{money(sum("quote_total"))}</b><span>報價合計</span></div>
          <div className="stat"><b>{money(sum("cost_actual_total"))}</b><span>實際成本合計</span></div>
          <div className="stat"><b className="red">{rows.filter(r => r.margin_alert).length}</b><span>毛利警示專案</span></div>
        </div>
        <Table rows={rows} onRow={r => { location.hash = "#/projects/" + r.id; }} columns={[
          { key: "name", label: "專案", render: r => <><b>{r.name}</b><small className="muted block">{r.code}・{r.stage}・PM {lk.nameOf(r.pm_account)}</small></> },
          { key: "contract", label: "合約", num: true, hideSm: true, render: r => money(r.contract_amount) },
          { key: "quote", label: "報價", num: true, render: r => money(r.quote_total) },
          { key: "est", label: "預估成本", num: true, hideSm: true, render: r => money(r.cost_estimate_total) },
          { key: "act", label: "實際成本", num: true, render: r => money(r.cost_actual_total) },
          { key: "m", label: "毛利率", num: true, render: r => <span className={r.margin_alert ? "red" : ""}>{pct(r.margin_rate)}</span> },
        ]} />
      </>}
    </Page>
  );
}
