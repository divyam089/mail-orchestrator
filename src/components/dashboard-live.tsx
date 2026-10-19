"use client";

import { useEffect, useRef, useState } from "react";
import { DashboardView } from "@/components/dashboard-view";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";

export function DashboardLive({ initial }: { initial: DashboardSnapshot }) {
  const [data, setData] = useState(initial);
  const [live, setLive] = useState<"connecting" | "live" | "reconnecting">("connecting");
  const range = useRef({ from: initial.from, to: initial.to });
  range.current = { from: data.from, to: data.to };

  useEffect(() => {
    const source = new EventSource("/api/dashboard/stream");
    const refresh = () => {
      const { from, to } = range.current;
      void fetch(`/api/dashboard?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
        .then((response) => (response.ok ? response.json() : null))
        .then((next: DashboardSnapshot | null) => {
          if (next) setData(next);
        })
        .catch(() => setLive("reconnecting"));
    };
    source.addEventListener("ready", () => setLive("live"));
    source.addEventListener("change", () => {
      setLive("live");
      refresh();
    });
    source.onerror = () => setLive("reconnecting");
    return () => source.close();
  }, []);

  return <DashboardView data={data} live={live} />;
}
