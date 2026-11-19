/**
 * 外框：左側選單（依角色顯示）、頁首、hash 路由（#/projects/xxx）。
 * 用 hash 路由是因為 GitHub Pages 沒有伺服器端改寫，重新整理子頁面才不會 404。
 */
import { useEffect, useState } from "react";
import { BarChart3, Briefcase, Building2, CalendarClock, ClipboardList, FileText, Gavel, Home, KeyRound, LogOut, Menu, Package,
  Receipt, Settings, Sparkles, Truck, Users, UserRoundCog, X } from "lucide-react";
import { call, hasValidToken, LOGIN_EVENT, logout, Me } from "./api";
import { Login, PasswordModal } from "./pages/Login";
import { LookupProvider, ToastProvider, useLookups } from "./ui";
import Dashboard from "./pages/Dashboard";
import { ProjectDetail, ProjectList } from "./pages/Projects";
import Tenders from "./pages/Tenders";
import { Clients, Suppliers } from "./pages/Partners";
import People from "./pages/People";
import Expenses from "./pages/Expenses";
import Attendance from "./pages/Attendance";
import { Dispatch, DispatchMe } from "./pages/Dispatch";
import Timesheet from "./pages/Timesheet";
import Resources from "./pages/Resources";
import Ai from "./pages/Ai";
import Admin from "./pages/Admin";
import Reports from "./pages/Reports";

interface NavItem { path: string; label: string; icon: any; roles?: string[] }
const INTERNAL = ["admin", "manager", "accountant", "staff"];
const NAV: { group: string; items: NavItem[] }[] = [
  { group: "", items: [{ path: "", label: "我的工作台", icon: Home }] },
  { group: "專案", items: [
    { path: "projects", label: "專案與工作", icon: Briefcase, roles: INTERNAL },
    { path: "tenders", label: "標案", icon: Gavel, roles: INTERNAL },
    { path: "ai", label: "AI 文件與設計", icon: Sparkles, roles: INTERNAL },
  ] },
  { group: "費用", items: [
    { path: "expenses", label: "請款與報帳", icon: Receipt, roles: INTERNAL },
    { path: "reports", label: "毛利報表", icon: BarChart3, roles: ["admin", "manager", "accountant"] },
  ] },
  { group: "人力", items: [
    { path: "attendance", label: "考勤", icon: CalendarClock },
    { path: "dispatch", label: "派遣", icon: Truck, roles: INTERNAL },
    { path: "dispatch-me", label: "我的派遣", icon: Truck, roles: ["dispatch"] },
    { path: "timesheet", label: "工時週報", icon: ClipboardList, roles: INTERNAL },
    { path: "people", label: "人員", icon: Users, roles: INTERNAL },
  ] },
  { group: "資源", items: [
    { path: "clients", label: "客戶", icon: Building2, roles: INTERNAL },
    { path: "suppliers", label: "供應商", icon: UserRoundCog, roles: INTERNAL },
    { path: "resources", label: "資材與知識", icon: Package, roles: INTERNAL },
  ] },
  { group: "管理", items: [{ path: "admin", label: "系統設定", icon: Settings, roles: ["admin"] }] },
];

function useHash(): string[] {
  const read = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => { setParts(read()); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

function Shell() {
  const { me } = useLookups();
  const [section, id] = useHash();
  const [open, setOpen] = useState(false);
  const [pwd, setPwd] = useState(false);
  const allowed = (i: NavItem) => !i.roles || i.roles.includes(me.role);
  const route = section || "";
  const page = (() => {
    const item = NAV.flatMap(g => g.items).find(i => i.path === route);
    if (item && !allowed(item)) return <p className="error">你沒有這個功能的權限。</p>;
    switch (route) {
      case "": return <Dashboard />;
      case "projects": return id ? <ProjectDetail id={id} /> : <ProjectList />;
      case "tenders": return <Tenders />;
      case "ai": return <Ai />;
      case "expenses": return <Expenses />;
      case "reports": return <Reports />;
      case "attendance": return <Attendance />;
      case "dispatch": return <Dispatch />;
      case "dispatch-me": return <DispatchMe />;
      case "timesheet": return <Timesheet />;
      case "people": return <People />;
      case "clients": return <Clients />;
      case "suppliers": return <Suppliers />;
      case "resources": return <Resources />;
      case "admin": return <Admin />;
      default: return <p className="error">找不到這個頁面。</p>;
    }
  })();
  return (
    <div className="shell">
      <aside className={"nav" + (open ? " open" : "")}>
        <div className="nav-head">
          <a href="#/" onClick={() => setOpen(false)}><img src="./logo.png" alt="imPR 新動力公關" width={150} height={30} /></a>
          <button className="icon-btn only-sm" onClick={() => setOpen(false)} aria-label="關閉選單"><X size={20} /></button>
        </div>
        <nav>
          {NAV.map(g => {
            const items = g.items.filter(allowed);
            if (!items.length) return null;
            return (
              <div key={g.group} className="nav-group">
                {g.group && <div className="nav-label">{g.group}</div>}
                {items.map(i => {
                  const Icon = i.icon;
                  return (
                    <a key={i.path} href={"#/" + i.path} className={route === i.path ? "on" : ""} onClick={() => setOpen(false)}>
                      <Icon size={18} aria-hidden /> {i.label}
                    </a>
                  );
                })}
              </div>
            );
          })}
        </nav>
        <div className="nav-foot">
          <button className="linkish" onClick={() => { setOpen(false); setPwd(true); }}><KeyRound size={16} aria-hidden /> 變更密碼</button>
          <button className="linkish" onClick={() => logout()}><LogOut size={16} aria-hidden /> 登出</button>
        </div>
      </aside>
      {open && <div className="nav-scrim" onClick={() => setOpen(false)} />}
      <div className="main">
        <header className="top">
          <button className="icon-btn only-sm" onClick={() => setOpen(true)} aria-label="開啟選單"><Menu size={22} /></button>
          <span className="spacer" />
          <span className="who">{me.name}<small>{ROLE_LABEL[me.role]}</small></span>
        </header>
        <main>{page}</main>
      </div>
      {pwd && <PasswordModal onClose={() => setPwd(false)} />}
    </div>
  );
}

export const ROLE_LABEL: Record<string, string> = { admin: "管理者", manager: "主管", accountant: "會計", staff: "同仁", dispatch: "派遣" };

export default function App() {
  const [needLogin, setNeedLogin] = useState(!hasValidToken());
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  // 任何 API 回「登入失效」或按登出，都會送出 LOGIN_EVENT，外框就換成登入畫面。
  useEffect(() => {
    const show = () => { setMe(null); setError(""); setNeedLogin(true); };
    window.addEventListener(LOGIN_EVENT, show);
    return () => window.removeEventListener(LOGIN_EVENT, show);
  }, []);
  useEffect(() => {
    if (needLogin) return;
    call<Me>("session.me").then(setMe).catch(e => { if (e.code !== "TOKEN") setError(e.message); });
  }, [needLogin]);
  if (needLogin) return <Login onDone={() => setNeedLogin(false)} />;
  if (error) return (
    <div className="boot"><FileText size={28} /><p>{error}</p>
      <div className="page-actions"><button className="btn" onClick={() => location.reload()}>重新整理</button><button className="btn" onClick={() => logout()}>換個帳號登入</button></div>
    </div>
  );
  if (!me) return <div className="boot"><p className="muted">載入中…</p></div>;
  return (
    <ToastProvider>
      <LookupProvider me={me}><Shell /></LookupProvider>
    </ToastProvider>
  );
}
