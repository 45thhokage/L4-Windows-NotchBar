import { motion } from "motion/react";
import { LockSimple } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { locale, t } from "../../i18n";
import { settings } from "../../settings/store";
import { fps, useFpsPolling } from "./gaming";
import { system, useSystemShown } from "./store";
import { levelColor } from "./SystemView";
import { LiveEdge } from "../../notch/liveEdges";

/*
 * Always-on hardware strip in the closed notch (Display → Kennzahlen):
 * FPS, CPU + temp, GPU + temp, RAM, downlink, clock. Same monochrome voice as
 * LiveGaming; values only turn orange/red when things get tight. Opt-in because
 * it polls the full counters (GPU, ping, sensors, net) once a second.
 */
export function LiveStats() {
  useFpsPolling();
  useSystemShown();
  const f = fps.use();
  const { stats } = system.use();
  const units = settings.use().units;
  const mem = stats ? (stats.memUsed / stats.memTotal) * 100 : null;
  const now = Date.now();

  return (
    <motion.div
      className="absolute inset-0 flex items-center justify-center gap-4 px-[12px]"
      initial={{ opacity: 0, filter: "blur(4px)" }}
      animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
      exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
    >
      <LiveEdge side="left" className="flex items-center gap-4">
        <span className="flex items-baseline gap-1" title={f.error === "no-admin" ? t("FPS freischalten: Einstellungen → Darstellung") : undefined}>
          <span className="tabular text-footnote font-semibold text-label">
            {f.error === "no-admin" ? (
              <LockSimple size={11} weight="bold" className="self-center text-label-3" />
            ) : (
              (f.value === null ? "–" : Math.round(f.value))
            )}
          </span>
          <span className="text-caption font-medium text-label-3">FPS</span>
        </span>
        <Stat label="CPU" value={stats?.cpu ?? null} temp={temp(stats?.cpuTemp ?? null, units.temp)} />
        <Stat label="GPU" value={stats?.gpu ?? null} temp={temp(stats?.gpuTemp ?? null, units.temp)} />
        <Stat label="RAM" value={mem} />
      </LiveEdge>
      <LiveEdge side="right" className="flex items-center gap-4">
        <span className="tabular text-footnote font-semibold text-label">
          {stats?.downBps == null ? "–" : `↓ ${((stats.downBps * 8) / 1e6).toFixed(1)} Mbps`}
        </span>
        <span className="tabular text-footnote font-semibold text-label">{clock(now, units.clock)}</span>
      </LiveEdge>
    </motion.div>
  );
}

function temp(celsius: number | null, unit: "c" | "f"): string | null {
  if (celsius === null) return null;
  const v = unit === "f" ? (celsius * 9) / 5 + 32 : celsius;
  return `${Math.round(v)}°`;
}

function clock(now: number, clock: "24" | "12"): string {
  return new Intl.DateTimeFormat(locale(), {
    hour: "2-digit",
    minute: "2-digit",
    hour12: clock === "12",
  }).format(now);
}

function Stat({ label, value, temp: tp }: { label: string; value: number | null; temp?: string | null }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-caption font-medium text-label-3">{label}</span>
      <span className="tabular text-footnote font-semibold transition-colors duration-300" style={{ color: levelColor(value ?? 0) }}>
        {value === null ? "–" : `${Math.round(value)}%`}
      </span>
      {tp && <span className="tabular text-caption text-label-3">{tp}</span>}
    </span>
  );
}
