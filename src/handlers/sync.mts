/**
 * `sync.pull`：抓页面 → 解析 → 映射成事件 → 交回宿主。
 *
 * ## 为什么不开 `eventsComplete`
 *
 * 这个源只列「可認購」+「待上市」两段，**是一个滚动窗口，不是全量集合**。
 * 新股上市之后就从页面上消失了——那是「已经发生」，不是「被撤回」。开了
 * `eventsComplete` 的话，每只票一上市，宿主就会把它的四个事件全部置成
 * `canceled`，用户回头看历史会看到一片「已取消」。
 *
 * 契约 §5.1.1 明确警告过这一点，这个插件正是那条警告的典型场景。
 *
 * ## 那真的撤回怎么办
 *
 * 撤回（招股失败、延期）确实会发生，所以用 `host.setState` 记账区分两种消失：
 *
 * - 上次见过、这次没有、**上市日还在未来** → 真的撤回了，报 `deletedExternalIds`
 * - 上次见过、这次没有、上市日已过 → 正常上市完成，只从记账里移除，不报删除
 *
 * 记账只存 `代码 → 上市日`，一只票十几个字节，几百只也远在 64KB 之内。
 */

import { context, logger, setState } from "../sdk/index.mjs";
import type { ExternalEvent, PullRequest, PullResult } from "../sdk/index.mjs";

import { DEFAULT_SOURCE_URL, fetchIpoPage } from "../ipo/fetch.mjs";
import {
  ALL_MILESTONES,
  mapEvents,
  parseHolidays,
  type Milestone,
} from "../ipo/events.mjs";
import { looksLikeIpoPage, parseIpoRows, type IpoPhase, type IpoRow } from "../ipo/parse.mjs";

/** 外部日历的稳定 id。只有一个日历，写死即可。 */
export const CALENDAR_EXTERNAL_ID = "hk-ipo";

const DEFAULT_CALENDAR_NAME = "港股新股";
const DEFAULT_TIMEOUT_SECONDS = 20;
const MIN_TIMEOUT_SECONDS = 5;
const MAX_TIMEOUT_SECONDS = 60;
const DEFAULT_DARK_POOL_WINDOW = "16:15-18:30";

const ALL_PHASES: IpoPhase[] = ["subscribing", "pending-listed"];

/** 一次同步用到的全部配置，已经从两级设置合并并归一化。 */
export interface Settings {
  sourceUrl: string;
  calendarName: string;
  phases: IpoPhase[];
  milestones: Milestone[];
  darkPoolWindow: string;
  holidays: Set<string>;
  timeoutMs: number;
  userAgent: string | undefined;
}

/** 插件的持久化记账：代码 → 上市日。 */
interface TrackedState {
  tracked?: Record<string, string>;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 多选字段。宿主给的是取值数组；非法项丢掉，全丢光就退回默认全选。 */
function pickList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T[],
): T[] {
  if (!Array.isArray(value)) return fallback;
  const picked = value.filter((item): item is T =>
    allowed.includes(item as T),
  );
  return picked.length > 0 ? picked : fallback;
}

/**
 * 归一化配置。
 *
 * **用 `request.config`，不要用 `context().config`**：一个插件进程服务该插件下的
 * 所有实例，init 时那份配置代表不了具体某一个（契约 §5.1）。
 */
export function settingsFrom(raw: Record<string, unknown> | undefined): Settings {
  const config = raw ?? {};
  const timeoutSeconds = Number(config.httpTimeoutSeconds);
  const clamped = Number.isFinite(timeoutSeconds)
    ? Math.min(Math.max(timeoutSeconds, MIN_TIMEOUT_SECONDS), MAX_TIMEOUT_SECONDS)
    : DEFAULT_TIMEOUT_SECONDS;

  return {
    sourceUrl: text(config.sourceUrl) ?? DEFAULT_SOURCE_URL,
    calendarName: text(config.calendarName) ?? DEFAULT_CALENDAR_NAME,
    phases: pickList(config.phases, ALL_PHASES, ALL_PHASES),
    milestones: pickList(config.milestones, ALL_MILESTONES, ALL_MILESTONES),
    darkPoolWindow: text(config.darkPoolWindow) ?? DEFAULT_DARK_POOL_WINDOW,
    holidays: parseHolidays(config.holidays),
    timeoutMs: clamped * 1000,
    userAgent: text(config.userAgent),
  };
}

/** 抓 + 解析。config 校验的 action 也用它，所以单独一个函数。 */
export async function loadRows(settings: Settings): Promise<IpoRow[]> {
  const html = await fetchIpoPage({
    url: settings.sourceUrl,
    timeoutMs: settings.timeoutMs,
    ...(settings.userAgent ? { userAgent: settings.userAgent } : {}),
  });
  if (!looksLikeIpoPage(html)) {
    // 抓到登录页、错误页或改版后的页面。空列表是正常业务结果，这个不是
    throw new Error(
      "页面里找不到「可認購」段，可能是数据源改版或被拦截，请检查地址",
    );
  }
  const rows = parseIpoRows(html);
  const wanted = new Set(settings.phases);
  return rows.filter((row) => wanted.has(row.phase));
}

/** 今天的 `YYYY-MM-DD`（港股时区）。 */
function todayInHongKong(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * 比对记账，算出「真的撤回了」的事件 id。
 *
 * 返回新的记账表与要报删除的 externalId 列表。纯函数，便于测试。
 */
export function diffTracked(
  previous: Record<string, string>,
  rows: IpoRow[],
  milestones: Milestone[],
  today: string,
): { tracked: Record<string, string>; deletedExternalIds: string[] } {
  const tracked: Record<string, string> = {};
  for (const row of rows) {
    tracked[row.stockCode] = row.listedDate;
  }

  const deleted: string[] = [];
  for (const [stockCode, listedDate] of Object.entries(previous)) {
    if (tracked[stockCode]) continue;
    // 上市日已过：正常滚出窗口，不是撤回。从记账里移除就好
    if (listedDate < today) continue;
    for (const milestone of milestones) {
      deleted.push(`${stockCode}:${suffixOf(milestone)}`);
    }
  }
  return { tracked, deletedExternalIds: deleted };
}

/** 时点 → externalId 后缀。与 `events.mts` 里拼的必须一致。 */
function suffixOf(milestone: Milestone): string {
  switch (milestone) {
    case "applyEnd":
      return "apply-end";
    case "result":
      return "result";
    case "darkPool":
      return "dark-pool";
    case "listing":
      return "listing";
  }
}

export async function pull(request: PullRequest): Promise<PullResult> {
  const settings = settingsFrom(request.config);
  const rows = await loadRows(settings);

  const events: ExternalEvent[] = mapEvents(rows, {
    milestones: settings.milestones,
    darkPoolWindow: settings.darkPoolWindow,
    holidays: settings.holidays,
    calendarExternalId: CALENDAR_EXTERNAL_ID,
    sourceUrl: settings.sourceUrl,
  });

  const state = (context().state ?? {}) as TrackedState;
  const { tracked, deletedExternalIds } = diffTracked(
    state.tracked ?? {},
    rows,
    settings.milestones,
    todayInHongKong(),
  );

  if (deletedExternalIds.length > 0) {
    logger.info(
      `${deletedExternalIds.length} 个事件对应的新股已从页面移除且上市日未到，按撤回处理`,
      { traceId: request.traceId },
    );
  }
  setState({
    ...(request.integrationId ? { integrationId: request.integrationId } : {}),
    state: { tracked },
  });

  logger.info(
    `港股新股 ${rows.length} 只 → ${events.length} 个事件` +
      `（阶段 ${settings.phases.join("/")}，时点 ${settings.milestones.join("/")}）`,
    { traceId: request.traceId },
  );

  return {
    items: [],
    calendars: [
      { externalId: CALENDAR_EXTERNAL_ID, name: settings.calendarName },
    ],
    events,
    // 刻意不开 eventsComplete，理由见文件头
    eventsComplete: false,
    hasMore: false,
    ...(deletedExternalIds.length > 0 ? { deletedExternalIds } : {}),
  };
}
