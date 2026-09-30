export function Flash({ ok, err }: { ok?: string; err?: string }) {
  if (ok) return <div className="msg success">{ok}</div>;
  if (err) return <div className="msg error">{err}</div>;
  return null;
}
