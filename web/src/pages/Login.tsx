/**
 * 新系統自己的登入畫面與改密碼視窗。帳號密碼仍由帳號中心管理（管理員維護，同仁只能改自己的密碼），
 * 登入後的憑證和其他 imprjoseph.github.io 系統共用，所以登入一次，其他系統也不用再登入。
 */
import { FormEvent, useState } from "react";
import { changePassword, login } from "../api";
import { Modal } from "../ui";

export function Login({ onDone }: { onDone: () => void }) {
  const [account, setAccount] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!account.trim() || !password) { setMsg("請輸入帳號與密碼"); return; }
    setBusy(true); setMsg("");
    try {
      await login(account.trim(), password);
      onDone();
    } catch (err: any) {
      setMsg(err.message); setPassword(""); setBusy(false);
    }
  };
  return (
    <div className="login-bg">
      <form className="login-card" onSubmit={submit}>
        <img src="./logo.png" alt="imPR 新動力公關" width={170} height={34} />
        <h1>imPR 公司系統</h1>
        <p className="muted">請用公司帳號登入</p>
        <label className="field"><span>帳號</span>
          <input autoFocus autoComplete="username" value={account} onChange={e => setAccount(e.target.value)} />
        </label>
        <label className="field"><span>密碼</span>
          <input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
        </label>
        {msg && <p className="error" role="alert">{msg}</p>}
        <button className="btn primary big" disabled={busy}>{busy ? "登入中…" : "登入"}</button>
        <p className="muted small">忘記密碼請找系統管理員重設。</p>
      </form>
    </div>
  );
}

export function PasswordModal({ onClose }: { onClose: () => void }) {
  const [v, setV] = useState({ old: "", next: "", again: "" });
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: any) => setV({ ...v, [k]: e.target.value });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setOk(false);
    if (v.next.length < 6) { setMsg("新密碼至少 6 個字元"); return; }
    if (v.next !== v.again) { setMsg("兩次輸入的新密碼不一致"); return; }
    setBusy(true); setMsg("");
    try {
      await changePassword(v.old, v.next);
      setV({ old: "", next: "", again: "" }); setOk(true);
    } catch (err: any) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="變更密碼" onClose={onClose}>
      <form onSubmit={submit} className="login-form">
        <p className="muted small">新密碼會套用到所有公司系統。</p>
        <label className="field"><span>目前密碼</span><input type="password" autoComplete="current-password" value={v.old} onChange={set("old")} /></label>
        <label className="field"><span>新密碼（至少 6 個字元）</span><input type="password" autoComplete="new-password" value={v.next} onChange={set("next")} /></label>
        <label className="field"><span>再輸入一次新密碼</span><input type="password" autoComplete="new-password" value={v.again} onChange={set("again")} /></label>
        {msg && <p className="error" role="alert">{msg}</p>}
        {ok && <p className="ok-msg">密碼已變更，下次登入請使用新密碼。</p>}
        <div className="modal-foot"><button type="button" className="btn" onClick={onClose}>關閉</button><button className="btn primary" disabled={busy}>{busy ? "處理中…" : "變更密碼"}</button></div>
      </form>
    </Modal>
  );
}
