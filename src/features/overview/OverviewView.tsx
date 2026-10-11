import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowClockwise, Bluetooth, BluetoothConnected, BluetoothSlash, CaretDown, DeviceMobile, Eye, EyeSlash, GearSix, Headphones, Keyboard, LockSimple, Moon, MoonStars, MouseSimple, MusicNoteSimple, SpeakerHigh, SpeakerLow, SpeakerNone, SpeakerSimpleSlash, SunDim, Timer } from "@phosphor-icons/react";
import { DiscordLogo } from "../../ui/brands";
import { content, popover, springs } from "../../design/motion";
import { HeaderActions, HeaderButton } from "../../notch/header";
import { navigate } from "../../notch/nav";
import { togglePresentation, usePresenting } from "../privacy/store";
import { useNowPlaying } from "../../platform/media";
import { bluetooth, systemControls, type BtState, type FocusState, type VolumeState } from "../../platform/services";
import { hitExtra } from "../../platform/native";
import { useDiscordCall } from "../discord/store";
import { Equalizer } from "../now-playing/Equalizer";
import { ARTWORK_LAYOUT_ID } from "../now-playing/NowPlayingView";
import { formatClock, timer, useRemaining } from "../timer/store";
import { describe, useForecast } from "../weather/store";
import { settings } from "../../settings/store";
import { formatTemp, formatTimeParts } from "../../lib/format";
import { locale, t, tBackend } from "../../i18n";

/*
 *   14:32                                    ☀ 18°
 *   Sunday, 5 October                Vienna · Clear
 *   ┌──────────────────────────────────────────────┐
 *   │ ▣ Song – Artist                        ▮▮▮▮  │   ← what's playing (click opens the tool)
 *   └──────────────────────────────────────────────┘
 *   [☾ Focus  ]  [🔊 ━━━━━━━━━━━━━━━━━━━━━━━  42 %]
 *
 * Like Control Center: an overview plus the two toggles you need all the time.
 */
export function OverviewView() {
  const presenting = usePresenting();
  return (
    <div className="flex h-full flex-col gap-2.5 px-4 pt-1 pb-3">
      <HeaderActions>
        <HeaderButton label={presenting ? t("Präsentationsmodus beenden") : t("Präsentationsmodus")} active={presenting} onClick={togglePresentation}>
          {presenting ? <EyeSlash size={14} weight="fill" /> : <Eye size={14} weight="bold" />}
        </HeaderButton>
        <HeaderButton label={t("Sperren")} onClick={() => void systemControls.lock()}>
          <LockSimple size={14} weight="bold" />
        </HeaderButton>
        <HeaderButton label={t("Energie sparen")} onClick={() => void systemControls.sleep()}>
          <MoonStars size={14} weight="bold" />
        </HeaderButton>
      </HeaderActions>
      <Header />
      <Activity />
      <div className="flex gap-2">
        <FocusTile />
        <VolumeTile />
        <BrightnessTile />
      </div>
      <BluetoothTile />
    </div>
  );
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Header() {
  const now = useNow();
  const forecast = useForecast();
  const place = settings.use().weather;
  const weather = forecast && forecast !== "error" ? describe(forecast.current.code, forecast.current.day) : null;
  const { time, period } = formatTimeParts(now);
  const date = new Intl.DateTimeFormat(locale(), { weekday: "long", day: "numeric", month: "long" }).format(now);

  return (
    <div className="flex items-end justify-between">
      <div>
        <div className="tabular text-[34px] leading-none font-semibold tracking-[-0.03em] text-label">
          {time}
          {period && <span className="ml-1 text-title font-semibold tracking-normal text-label-3">{period}</span>}
        </div>
        <div className="mt-1 text-footnote text-label-3">{date}</div>
      </div>
      <button onClick={() => navigate("weather")} className="pressable flex flex-col items-end text-right" title={t("Wetter öffnen")}>
        <AnimatePresence mode="popLayout" initial={false}>
          {weather && forecast && forecast !== "error" ? (
            <motion.div
              key="w"
              className="flex items-center gap-1.5"
              initial={{ opacity: 0, filter: "blur(4px)" }}
              animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            >
              <weather.icon size={22} weight="fill" className="text-label" />
              <span className="tabular text-[22px] leading-none font-semibold tracking-[-0.02em] text-label">{formatTemp(forecast.current.temp)}</span>
            </motion.div>
          ) : (
            <motion.div key="s" className="h-[22px] w-16 rounded-[6px] bg-fill-1" exit={{ opacity: 0, transition: content.exit }} />
          )}
        </AnimatePresence>
        <div className="mt-1 max-w-[220px] truncate text-footnote text-label-3">
          {place ? `${place.name}${weather ? ` · ${weather.text}` : ""}` : t("Ort wird erkannt …")}
        </div>
      </button>
    </div>
  );
}

/** What's running, in the same priority as the closed notch: timer, call, music. */
function Activity() {
  const np = useNowPlaying();
  const call = useDiscordCall();
  const tm = timer.use();
  const remaining = useRemaining();
  const timerLive = tm.endsAt !== null || tm.finished;

  let item: { key: string; tab: string; icon: ReactNode; title: string; detail: string; trailing?: ReactNode } | null = null;
  if (timerLive) {
    item = {
      key: "timer",
      tab: "timer",
      icon: <Timer size={18} weight="bold" className={tm.mode === "focus" ? "text-orange" : "text-green"} />,
      title: tm.finished ? t(tm.mode === "focus" ? "Fokus abgelaufen" : "Pause abgelaufen") : t(tm.mode === "focus" ? "Fokus" : "Pause"),
      detail: tm.finished ? t("Zum Schließen öffnen") : t("noch {time}", { time: formatClock(remaining) }),
    };
  } else if (call) {
    item = {
      key: "discord",
      tab: "discord",
      icon: <DiscordLogo size={18} weight="fill" className="text-label" />,
      title: call.channelName,
      detail: [call.guildName, t(call.members.length === 1 ? "{n} Person" : "{n} Personen", { n: call.members.length })].filter(Boolean).join(" · "),
      trailing: <Equalizer playing={call.members.some((m) => m.speaking)} tint="bg-green" />,
    };
  } else if (np) {
    item = {
      key: "media",
      tab: "media",
      icon: np.artwork ? (
        // Same layoutId as the cover in Now Playing, so a click flies it there.
        <motion.img layoutId={ARTWORK_LAYOUT_ID} transition={springs.morph} src={np.artwork} alt="" draggable={false} className="size-7 rounded-[6px] object-cover" />
      ) : (
        <MusicNoteSimple size={18} weight="fill" className="text-label-2" />
      ),
      title: np.title,
      detail: np.artist,
      trailing: <Equalizer playing={np.isPlaying} />,
    };
  }

  return (
    <div className="relative h-11 overflow-hidden rounded-[12px] bg-fill-1">
      <AnimatePresence mode="popLayout" initial={false}>
        {item ? (
          <motion.button
            key={item.key}
            onClick={() => navigate(item.tab)}
            className="pressable pressable-wide pressable-fill absolute inset-0 flex items-center gap-2.5 px-2.5 text-left"
            initial={{ opacity: 0, filter: "blur(4px)" }}
            animate={{ opacity: 1, filter: "blur(0px)", transition: content.enter }}
            exit={{ opacity: 0, filter: "blur(4px)", transition: content.exit }}
          >
            <span className="flex size-7 shrink-0 items-center justify-center">{item.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-footnote font-medium text-label">{item.title}</span>
              <span className="block truncate text-caption text-label-3">{item.detail}</span>
            </span>
            {item.trailing && <span className="shrink-0 pr-1">{item.trailing}</span>}
          </motion.button>
        ) : (
          <motion.div
            key="idle"
            className="absolute inset-0 flex items-center justify-center text-footnote text-label-3"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: content.enter }}
            exit={{ opacity: 0, transition: content.exit }}
          >
            {t("Gerade läuft nichts")}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Windows focus on/off. Light = on (like Control Center). */
function FocusTile() {
  const [focus, setFocus] = useState<FocusState | null>(null);
  useEffect(() => {
    const load = () => void systemControls.focus().then(setFocus).catch(() => setFocus(null));
    load();
    // Also toggled elsewhere (taskbar, Clock app) → follow it.
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);
  const active = !!focus?.active;
  const label = focus?.kind === "dnd" ? t("Nicht stören") : t("Fokus");

  return (
    <button
      aria-pressed={active}
      disabled={!focus}
      onClick={() => {
        setFocus((f) => f && { ...f, active: !active });
        void systemControls.setFocus(!active).then(setFocus).catch(() => systemControls.focus().then(setFocus));
      }}
      className={`pressable flex h-10 w-[150px] shrink-0 items-center gap-2.5 rounded-[12px] px-2.5 transition-colors duration-200 disabled:opacity-40 ${
        active ? "bg-label text-black" : "bg-fill-1 text-label"
      }`}
    >
      <motion.span
        className={`flex size-6 items-center justify-center rounded-full ${active ? "bg-black/10" : "bg-fill-2"}`}
        animate={{ rotate: active ? 0 : -30 }}
        transition={springs.snappy}
      >
        <Moon size={14} weight="fill" />
      </motion.span>
      <span className="min-w-0 text-left">
        <span className="block truncate text-footnote font-semibold">{label}</span>
        <span className={`block text-caption ${active ? "text-black/55" : "text-label-3"}`}>{active ? t("An") : t("Aus")}</span>
      </span>
    </button>
  );
}

/** Thick volume slider like Control Center: drag anywhere, icon = mute. */
function VolumeTile() {
  const [vol, setVol] = useState<VolumeState | null>(null);
  const dragging = useRef(false);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => !dragging.current && void systemControls.volume().then(setVol).catch(() => {});
    load();
    // Keyboard volume keys or taskbar → follow them.
    const id = setInterval(load, 1000);
    return () => clearInterval(id);
  }, []);

  const level = vol ? (vol.muted ? 0 : vol.level) : 0;
  const set = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const l = Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * 100) / 100;
    setVol({ level: l, muted: false });
    void systemControls.setVolume({ level: l });
  };
  const Icon = vol?.muted || level === 0 ? SpeakerSimpleSlash : level < 0.34 ? SpeakerNone : level < 0.67 ? SpeakerLow : SpeakerHigh;

  return (
    <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-fill-1 pr-3 pl-1.5">
      <button
        aria-label={vol?.muted ? t("Stummschaltung aufheben") : t("Stumm")}
        disabled={!vol}
        onClick={() => vol && void systemControls.setVolume({ muted: !vol.muted }).then(setVol)}
        className={`pressable flex size-7 shrink-0 items-center justify-center rounded-full ${vol?.muted ? "text-red" : "text-label-2 hover:text-label"}`}
      >
        <Icon size={15} weight="fill" />
      </button>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={t("Lautstärke")}
        aria-valuenow={Math.round(level * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-6 min-w-0 flex-1 cursor-pointer touch-none overflow-hidden rounded-full bg-fill-2 outline-none"
        onPointerDown={(e) => {
          if (!vol) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          set(e.clientX);
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && set(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onWheel={(e) => {
          if (!vol) return;
          const l = Math.min(1, Math.max(0, level + (e.deltaY < 0 ? 0.02 : -0.02)));
          setVol({ level: l, muted: false });
          void systemControls.setVolume({ level: l });
        }}
        onKeyDown={(e) => {
          if (!vol || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
          const l = Math.min(1, Math.max(0, level + (e.key === "ArrowRight" ? 0.05 : -0.05)));
          setVol({ level: l, muted: false });
          void systemControls.setVolume({ level: l });
        }}
      >
        <motion.div
          className="absolute inset-0 origin-left rounded-full bg-label"
          initial={false}
          animate={{ transform: `scaleX(${level})` }}
          transition={dragging.current ? { duration: 0 } : springs.snappy}
        />
      </div>
      <span className="tabular w-8 shrink-0 text-right text-caption font-semibold text-label-2">{vol ? Math.round(level * 100) : "–"}</span>
    </div>
  );
}

/** Screen brightness slider (power scheme), same mounted-only polling as volume. */
function BrightnessTile() {
  const [level, setLevel] = useState<number | null>(null);
  const dragging = useRef(false);
  const track = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => !dragging.current && void systemControls.brightness().then((b) => setLevel(b.level)).catch(() => {});
    load();
    // Brightness keys or Settings → follow them.
    const id = setInterval(load, 1000);
    return () => clearInterval(id);
  }, []);

  const set = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const l = Math.round(Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * 100) / 100;
    setLevel(l);
    void systemControls.setBrightness(l).then((b) => setLevel(b.level));
  };

  return (
    <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[12px] bg-fill-1 pr-3 pl-1.5">
      <span className="flex size-7 shrink-0 items-center justify-center text-label-2">
        <SunDim size={15} weight="fill" />
      </span>
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={t("Helligkeit")}
        aria-valuenow={level === null ? undefined : Math.round(level * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-6 min-w-0 flex-1 cursor-pointer touch-none overflow-hidden rounded-full bg-fill-2 outline-none"
        onPointerDown={(e) => {
          if (level === null) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          set(e.clientX);
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && set(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onKeyDown={(e) => {
          if (level === null || (e.key !== "ArrowRight" && e.key !== "ArrowLeft")) return;
          const l = Math.min(1, Math.max(0, level + (e.key === "ArrowRight" ? 0.05 : -0.05)));
          setLevel(l);
          void systemControls.setBrightness(l).then((b) => setLevel(b.level));
        }}
      >
        <motion.div
          className="absolute inset-0 origin-left rounded-full bg-label"
          initial={false}
          animate={{ transform: `scaleX(${level ?? 0})` }}
          transition={dragging.current ? { duration: 0 } : springs.snappy}
        />
      </div>
      <span className="tabular w-8 shrink-0 text-right text-caption font-semibold text-label-2">{level === null ? "–" : Math.round(level * 100)}</span>
    </div>
  );
}

/** Device icon from the Bluetooth class-of-device (major class = bits 8–12). */
function BtIcon({ cod }: { cod: number }) {
  const major = (cod >> 8) & 0x1f;
  if (major === 0x04) return <Headphones size={16} weight="fill" />;
  if (major === 0x02) return <DeviceMobile size={16} weight="bold" />;
  if (major === 0x05) return ((cod >> 2) & 0x3f) === 0x20 ? <MouseSimple size={16} weight="fill" /> : <Keyboard size={16} weight="bold" />;
  return <Bluetooth size={16} weight="bold" />;
}

/** Bluetooth tile + paired-device dropdown. On demand only: lists once on
 *  mount and every 5 s while the panel is open, never in the background. */
function BluetoothTile() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<BtState | null>(null);
  const [connecting, setConnecting] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => {
      void bluetooth
        .list()
        .then((s) => {
          if (alive) {
            setState(s);
            setError(null);
          }
        })
        .catch(() => {
          if (alive) setState(null);
        });
    };
    load();
    if (!open) return () => void (alive = false);
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [open ]);

  useLayoutEffect(() => {
    if (!open) return;
    const trigger = ref.current?.getBoundingClientRect();
    if (!trigger) return;
    const maxY =
      Math.min(ref.current?.closest("[data-notch-hit]")?.getBoundingClientRect().bottom ?? window.innerHeight, window.innerHeight) - 8;
    setPos({
      left: trigger.left,
      width: trigger.width,
      top: trigger.bottom + 6,
      maxHeight: Math.max(120, Math.min(264, maxY - trigger.bottom - 6)),
    });
  }, [open ]);

  // The panel hangs below the notch shape: union it into the Rust hit rect
  // (see useNativeBridge), or the cursor leaving the shape makes the window
  // click-through and the notch auto-close. A few px of margin cover the
  // enter animation and sub-pixel edges.
  useLayoutEffect(() => {
    if (!open || !pos) {
      hitExtra.set(null);
      return;
    }
    const m = menu.current?.getBoundingClientRect();
    const r =
      m && m.height > 0
        ? { x: m.left, y: m.top, w: m.width, h: m.height }
        : { x: pos.left, y: pos.top, w: pos.width, h: pos.maxHeight };
    hitExtra.set({ x: r.x - 4, y: r.y - 4, w: r.w + 8, h: r.h + 8 });
    return () => void hitExtra.set(null);
  }, [open, pos, state ]);

  // Same dismissal as the Select in ui/controls.tsx: outside click, resize.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menu.current?.contains(t)) setOpen(false);
    };
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", close);
    };
  }, [open ]);

  const host = ref.current?.closest("[data-notch-hit]") ?? document.body;
  const devices = state?.devices ?? [];
  const connected = devices.find((d) => d.connected);

  // The panel unmounts when the notch closes: stop the settle loop then
  // instead of polling in the background.
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  // Connecting takes a moment (service call + radio + headset); A2DP can lag
  // several more seconds behind the call. Poll until the device reports
  // connected and never flash the feedback for less than a moment.
  const connect = (address: number) => {
    if (connecting !== null) return;
    const started = Date.now();
    setConnecting(address);
    setError(null);
    void (async () => {
      try {
        let s = await bluetooth.connect(address);
        for (let i = 0; i < 5; i++) {
          if (!alive.current) return;
          if (s.devices.some((x) => x.address === address && x.connected)) break;
          await new Promise((r) => setTimeout(r, 2000));
          if (!alive.current) return;
          s = await bluetooth.list();
        }
        const wait = 1200 - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (!alive.current) return;
        setState(s);
        if (!s.devices.some((x) => x.address === address && x.connected)) {
          setError(t("Verbindung fehlgeschlagen"));
        }
        setConnecting(null);
      } catch (e) {
        const wait = 1200 - (Date.now() - started);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        if (!alive.current) return;
        setConnecting(null);
        setError(tBackend(typeof e === "string" ? e : t("Verbindung fehlgeschlagen")));
      }
    })();
  };
  const sub =
    state === null
      ? "–"
      : !state.radio
        ? t("Nicht verfügbar")
        : connected
          ? connected.name
          : devices.length === 0
            ? t("Keine gekoppelten Geräte")
            : t("{n} Geräte", { n: devices.length });

  return (
    <div ref={ref} className="relative">
      <button
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="pressable flex h-10 w-full items-center gap-2.5 rounded-[12px] bg-fill-1 px-2.5 text-left"
      >
        <span className="flex size-6 items-center justify-center rounded-full bg-fill-2 text-label-2">
          {state && !state.radio ? (
            <BluetoothSlash size={14} weight="bold" />
          ) : connected ? (
            <BluetoothConnected size={14} weight="fill" />
          ) : (
            <Bluetooth size={14} weight="bold" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-footnote font-semibold text-label">{t("Bluetooth")}</span>
          <span className="block truncate text-caption text-label-3">{sub}</span>
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={springs.snappy} className="text-label-3">
          <CaretDown size={13} weight="bold" />
        </motion.span>
      </button>
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={menu}
              className="pointer-events-auto fixed z-[60] overflow-y-auto rounded-[14px] bg-elevated p-1.5 shadow-[0_10px_30px_rgb(0_0_0/0.6)] ring-1 ring-separator [scrollbar-width:none]"
              style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
              initial={{ opacity: 0, transform: "scale(0.98) translateY(-4px)" }}
              animate={{ opacity: 1, transform: "scale(1) translateY(0px)", transition: popover.enter }}
              exit={{ opacity: 0, transform: "scale(0.98)", transition: popover.exit }}
            >
              {state === null ? (
                <div className="flex flex-col gap-1.5 p-1">
                  <div className="h-12 rounded-[10px] bg-fill-1" />
                  <div className="h-12 rounded-[10px] bg-fill-1" />
                </div>
              ) : devices.length === 0 ? (
                <div className="px-2 py-3 text-center text-footnote text-label-3">
                  {state.radio ? t("Keine gekoppelten Geräte") : t("Nicht verfügbar")}
                </div>
              ) : (
                devices.map((d) => (
                  <div key={d.address} className="flex h-12 items-center gap-2.5 rounded-[10px] px-2">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-fill-2 text-label-2">
                      <BtIcon cod={d.class} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-footnote font-semibold text-label">{d.name}</span>
                      <span className="block text-caption">
                        {connecting === d.address ? (
                          <span className="text-link">{t("Verbinde …")}</span>
                        ) : d.connected ? (
                          <span className="text-green">{t("Verbunden")}</span>
                        ) : (
                          <span className="text-label-3">{t("Nicht verbunden")}</span>
                        )}
                      </span>
                    </span>
                    {connecting === d.address ? (
                      <motion.span
                        animate={{ rotate: 360 }}
                        transition={{ duration: 0.9, ease: "linear", repeat: Infinity }}
                        className="flex size-[18px] shrink-0 items-center justify-center rounded-full border-2 border-fill-2 border-t-label-2"
                        role="status"
                        aria-label={t("Verbinde …")}
                      />
                    ) : (
                      !d.connected && (
                        <button
                          disabled={connecting !== null}
                          onClick={() => connect(d.address)}
                          className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-[8px] px-2 text-footnote font-medium text-label disabled:opacity-40"
                        >
                          {t("Verbinden")}
                        </button>
                      )
                    )}
                  </div>
                ))
              )}
              {error && <div className="px-2 pt-1 pb-0.5 text-caption text-red">{error}</div>}
              <div className="mt-1 flex items-center justify-between border-t border-separator px-1 pt-1">
                <button
                  onClick={() => void bluetooth.settings()}
                  className="pressable flex h-7 items-center gap-1.5 rounded-[8px] px-2 text-footnote text-label-2 hover:text-label"
                >
                  <GearSix size={13} weight="bold" />
                  {t("Bluetooth-Einstellungen")}
                </button>
                <button
                  aria-label={t("Aktualisieren")}
                  disabled={connecting !== null}
                  onClick={() => {
                    setError(null);
                    void bluetooth
                      .list()
                      .then((s) => {
                        setState(s);
                        setError(null);
                      })
                      .catch(() => {});
                  }}
                  className="pressable flex size-7 items-center justify-center rounded-[8px] text-label-2 hover:text-label disabled:opacity-40"
                >
                  <ArrowClockwise size={13} weight="bold" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>,
        host,
      )}
    </div>
  );
}
