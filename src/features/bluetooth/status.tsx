import { useContext, useEffect, useState } from "react";
import { motion, useTransform } from "motion/react";
import { Bluetooth, type Icon } from "@phosphor-icons/react";
import { content } from "../../design/motion";
import { LiveEdge, LiveSpread, ShapeWidth } from "../../notch/liveEdges";
import { bluetooth } from "../../platform/services";
import { settings } from "../../settings/store";
import { describe, useForecast } from "../weather/store";
import { formatTemp } from "../../lib/format";

/*
 * Closed-notch companions: the connected headset's battery on the left,
 * the weather on the right. One home (no import cycles with notch/live):
 * the audio view and the idle layer below both use these.
 */

/** Connected device + battery %, refreshed every minute. Null when unknown. */
export interface BtBattery {
  name: string;
  level: number;
}

export function useBtBattery(): BtBattery | null {
  const [info, setInfo] = useState<BtBattery | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const connected = (await bluetooth.list()).devices.find((d) => d.connected);
        if (!connected) {
          if (alive) setInfo(null);
          return;
        }
        const level = await bluetooth.battery(connected.address);
        if (alive) setInfo(level === null ? null : { name: connected.name, level });
      } catch {
        if (alive) setInfo(null);
      }
    };
    void load();
    const id = setInterval(() => void load(), 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return info;
}

export function BatteryPill({ level, name }: { level: number; name: string }) {
  return (
    <span className="flex items-center gap-1" title={name}>
      <Bluetooth size={11} weight="bold" className="text-label-2" />
      <span className="tabular text-caption font-semibold text-label-2">{level}%</span>
    </span>
  );
}

export function WeatherPill({ icon: WxIcon, text, temp }: { icon: Icon; text: string; temp: number }) {
  return (
    <span className="flex items-center gap-1" title={text}>
      <WxIcon size={13} weight="fill" className="text-label-2" />
      <span className="tabular text-caption font-semibold text-label-2">{formatTemp(temp)}</span>
    </span>
  );
}

/** Weather for the pills; null while loading, failed or unset. */
export function useWeatherPill(): { icon: Icon; text: string; temp: number } | null {
  const forecast = useForecast();
  if (!forecast || forecast === "error") return null;
  const w = describe(forecast.current.code, forecast.current.day);
  return { icon: w.icon, text: w.text, temp: forecast.current.temp };
}

/** Fixed box for the idle status layer; edges follow the shape via spread. */
const STATUS_W = 120;

/**
 * Idle closed notch with something to show: battery on the left edge, weather
 * on the right. Rendered by Notch only when no live activity takes the stage;
 * the audio view embeds the same pills beside cover/equalizer instead.
 */
export function LiveStatus() {
  const bt = useBtBattery();
  const wx = useWeatherPill();
  const { idleW, idleH } = settings.use().display;
  const spread = useTransform(useContext(ShapeWidth), (w) => Math.max(0, (w - STATUS_W) / 2));
  // Too narrow for two pills side by side; the audio view still shows them.
  if (idleW < 140) return null;
  if (!bt && !wx) return null;
  return (
    <LiveSpread.Provider value={spread}>
      <motion.div
        className="absolute top-0 left-1/2"
        style={{ width: STATUS_W, height: idleH, marginLeft: -STATUS_W / 2 }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1, transition: content.enter }}
      >
        <div className="absolute inset-0 flex items-center justify-between px-1">
          <LiveEdge side="left">{bt && <BatteryPill level={bt.level} name={bt.name} />}</LiveEdge>
          <LiveEdge side="right">{wx && <WeatherPill icon={wx.icon} text={wx.text} temp={wx.temp} />}</LiveEdge>
        </div>
      </motion.div>
    </LiveSpread.Provider>
  );
}
