import { useContext, useRef } from "react";
import { AnimatePresence, useTransform } from "motion/react";
import { useNowPlaying } from "../platform/media";
import { LiveActivity } from "../features/now-playing/LiveActivity";
import { LiveTimer, useTimerLive } from "../features/timer/LiveTimer";
import { LiveDiscord } from "../features/discord/LiveDiscord";
import { useDiscordCall } from "../features/discord/store";
import { LiveGaming } from "../features/system/LiveGaming";
import { LiveStats } from "../features/system/LiveStats";
import { useGamingLive } from "../features/system/gaming";
import { gamingGeometry, liveGeometry } from "./geometry";
import { settings } from "../settings/store";
import { LiveSpread, ShapeWidth } from "./liveEdges";

/**
 * Which live activity the closed notch shows. Exactly one, by priority:
 * gaming mode (turned on deliberately) before time-critical (timer, call) before
 * background (music). Add new activities here. The ID is also the tool that opens.
 */
export function useLiveActivity(): { id: string | null } {
  const gaming = useGamingLive();
  const timerLive = useTimerLive();
  const call = useDiscordCall();
  const np = useNowPlaying();
  const showStats = settings.use().display.stats;
  if (gaming) return { id: "system" };
  if (timerLive) return { id: "timer" };
  if (call) return { id: "discord" };
  if (np?.isPlaying) return { id: "media" };
  if (showStats) return { id: "stats" };
  return { id: null };
}

/**
 * The activity sits in a fixed box the size of the closed live notch, centered. Its two
 * sides (LiveEdge) follow the shape's edges by transform as it opens, closes or peeks.
 * Pinned to the edges by layout instead, they crept in pixel steps (issue #3).
 */
export function LiveSlot({ id }: { id: string | null }) {
  const np = useNowPlaying();
  const call = useDiscordCall();
  // Keep the last size while an activity fades out (id is null when the notch opens).
  const last = useRef(id);
  if (id) last.current = id;
  // Activity boxes track the idle size (Idle Appearance) + fixed slot space.
  const { idleW, idleH } = settings.use().display;
  const box = last.current === "system" || last.current === "stats" ? gamingGeometry(idleW, idleH) : liveGeometry(idleW, idleH);
  const boxW = useRef(box.w);
  boxW.current = box.w;
  const spread = useTransform(useContext(ShapeWidth), (w) =>
    Math.max(0, (w - boxW.current) / 2),
  );
  return (
    <LiveSpread.Provider value={spread}>
      <div
        className="absolute top-0 left-1/2"
        style={{ width: box.w, height: box.h, marginLeft: -box.w / 2 }}
      >
        <AnimatePresence initial={false}>
          {id === "system" && <LiveGaming key="system" />}
          {id === "stats" && <LiveStats key="stats" />}
          {id === "timer" && <LiveTimer key="timer" />}
          {id === "discord" && call && (
            <LiveDiscord key="discord" call={call} />
          )}
          {id === "media" && np && <LiveActivity key="media" np={np} />}
        </AnimatePresence>
      </div>
    </LiveSpread.Provider>
  );
}
