/** 公開標案：政府標案資料庫（每天自動收錄與本司業務相關的政府採購公告），覺得值得投就按「追蹤」轉進標案管理。 */
import { useState } from "react";
import { call } from "../api";
import { Badge, Loading, Page, Table, money, shortDate, todayIso, useAction, useLoad } from "../ui";

export default function PublicTenders() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [minScore, setMinScore] = useState(0);
  const [includeClosed, setIncludeClosed] = useState(false);
  const { data, error, loading, reload } = useLoad<any>("publicTender.list", { q: query, group, minScore, includeClosed });
  const { busy, run } = useAction();
  const track = async (t: any) => {
    const r = await run(() => call<any>("publicTender.track", { key: t.key }));
    if (r) { reload(); location.hash = "#/tenders"; }
  };
  const daysLeft = (d?: string) => d ? Math.round((Date.parse(d) - Date.parse(todayIso())) / 864e5) : null;
  return (
    <Page title="公開標案" sub="政府電子採購網上與本司業務相關的公告，每天自動更新。值得投的按「追蹤」，會建立到「標案」並由你負責。"
      actions={data?.sheetUrl && <a className="btn" href={data.sheetUrl} target="_blank" rel="noreferrer">開啟原始資料表 ↗</a>}>
      <form className="toolbar" onSubmit={e => { e.preventDefault(); setQuery(q.trim()); }}>
        <input type="search" placeholder="搜尋案名、機關、關鍵字、案號" value={q} onChange={e => setQ(e.target.value)} />
        <select value={group} onChange={e => setGroup(e.target.value)}>
          <option value="">全部類別</option>
          {(data?.groups || []).map((g: string) => <option key={g}>{g}</option>)}
        </select>
        <select value={minScore} onChange={e => setMinScore(Number(e.target.value))}>
          <option value={0}>不限分數</option><option value={10}>分數 10 以上</option><option value={15}>分數 15 以上</option><option value={20}>分數 20 以上</option>
        </select>
        <label className="check" style={{ margin: 0 }}><input type="checkbox" checked={includeClosed} onChange={e => setIncludeClosed(e.target.checked)} /> 含已截標</label>
        <button className="btn">搜尋</button>
      </form>
      <Loading error={error} loading={loading && !data} />
      {data && <p className="muted small">符合 {data.total} 筆（資料庫共 {data.totalAll} 筆）{data.total > data.rows.length ? "，只列最新 " + data.rows.length + " 筆，請用搜尋縮小範圍" : ""}。</p>}
      {data && <Table rows={data.rows} empty="沒有符合的公開標案。" columns={[
        { key: "title", label: "案名", render: t => <>
          {t.url ? <a href={t.url} target="_blank" rel="noreferrer"><b>{t.title}</b></a> : <b>{t.title}</b>}
          <small className="muted block">{t.agency}・{t.tender_no}{t.keywords ? "・" + t.keywords : ""}</small>
        </> },
        { key: "budget", label: "預算", num: true, render: t => money(t.budget) },
        { key: "deadline_date", label: "截標", render: t => {
          const n = daysLeft(t.deadline_date);
          return <>{shortDate(t.deadline_date)}{n !== null && <small className={"block " + (n < 0 ? "muted" : n <= 3 ? "red" : "muted")}>{n < 0 ? "已截標" : n === 0 ? "今天" : "剩 " + n + " 天"}</small>}</>;
        } },
        { key: "score", label: "分數", num: true, hideSm: true },
        { key: "announce_date", label: "公告", hideSm: true, render: t => shortDate(t.announce_date) },
        { key: "x", label: "", render: t => t.tracked_id
          ? <a className="btn small" href="#/tenders"><Badge text="追蹤中" tone="green" /></a>
          : t.owner ? <Badge text={(t.status || "處理中") + "・" + t.owner} />
          : <button className="btn small primary" disabled={busy} onClick={() => track(t)}>追蹤</button> },
      ]} />}
    </Page>
  );
}
