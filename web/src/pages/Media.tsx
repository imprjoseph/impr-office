/** 媒體：記者與媒體窗口的聯絡名單，發新聞稿、邀採訪時用。 */
import { CrudPage } from "../ui";
import { ContactInfo } from "./Partners";

const OUTLET_KINDS = ["報紙", "電視", "廣播", "通訊社", "網路媒體", "雜誌", "專業媒體", "其他"];
const BEATS = ["政治", "財經", "產業科技", "醫療健康", "生活消費", "文化藝術", "教育", "環境永續", "地方", "國際", "其他"];

export default function Media() {
  return (
    <CrudPage title="媒體" sub="記者與媒體窗口的聯絡方式。電話、手機可直接撥打，Email 可直接寄信；聯絡後請更新「最近聯絡日」。"
      prefix="media" canWrite searchKeys={["outlet", "name", "title", "beat", "phone", "mobile", "email", "note"]} fields={[
        { name: "outlet", label: "媒體名稱", required: true }, { name: "beat", label: "路線", type: "select", options: BEATS },
        { name: "name", label: "記者／窗口姓名" }, { name: "title", label: "職稱" },
        { name: "phone", label: "電話（含分機）" }, { name: "mobile", label: "手機" },
        { name: "email", label: "Email", type: "email" }, { name: "line_id", label: "LINE ID" },
        { name: "last_contact", label: "最近聯絡日", type: "date" },
        { name: "note", label: "備註（媒體類型：" + OUTLET_KINDS.join("、") + "；合作紀錄…）", type: "textarea" },
      ]} columns={[
        { key: "outlet", label: "媒體", render: m => <><b>{m.outlet}</b><small className="muted block">{m.beat || ""}</small></> },
        { key: "name", label: "記者／窗口", render: m => m.name ? <><b>{m.name}</b><small className="muted block">{m.title || ""}</small></> : "—" },
        { key: "reach", label: "聯絡方式", render: m => <ContactInfo phone={m.phone} mobile={m.mobile} email={m.email} line={m.line_id} /> },
        { key: "last_contact", label: "最近聯絡", hideSm: true },
      ]} />
  );
}
