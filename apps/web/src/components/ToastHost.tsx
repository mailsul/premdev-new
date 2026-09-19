import { useEffect, useState } from "react";
import { CheckCircle2, X, XCircle } from "lucide-react";

type Toast = {
  id: number;
  kind: "error" | "success";
  message: string;
  requestId?: string;
};

export function toast(message: string, kind: Toast["kind"] = "success") {
  window.dispatchEvent(new CustomEvent("premdev:toast", { detail: { kind, message } }));
}

export function ToastHost() {
  const [items, setItems] = useState<Toast[]>([]);

  useEffect(() => {
    const onToast = (event: Event) => {
      const detail = (event as CustomEvent).detail ?? {};
      const item: Toast = {
        id: Date.now() + Math.random(),
        kind: detail.kind === "success" ? "success" : "error",
        message: String(detail.message ?? "Something went wrong"),
        requestId: detail.requestId,
      };
      setItems((current) => [...current.slice(-3), item]);
      window.setTimeout(() => {
        setItems((current) => current.filter((candidate) => candidate.id !== item.id));
      }, 6000);
    };
    window.addEventListener("premdev:toast", onToast);
    return () => window.removeEventListener("premdev:toast", onToast);
  }, []);

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[100] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {items.map((item) => (
        <div key={item.id} className={`pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-xl ${
          item.kind === "error"
            ? "border-danger/40 bg-danger/10 text-danger"
            : "border-success/40 bg-success/10 text-success"
        }`}>
          {item.kind === "error" ? <XCircle size={15} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={15} className="mt-0.5 shrink-0" />}
          <span className="min-w-0 flex-1 break-words">{item.message}{item.requestId ? ` (${item.requestId.slice(0, 8)})` : ""}</span>
          <button aria-label="Dismiss notification" onClick={() => setItems((current) => current.filter((candidate) => candidate.id !== item.id))}><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}