/**
 * 把一只新股的四个时点映射成一念的日历事件。
 *
 * | 时点 | 形态 | 来源 |
 * |---|---|---|
 * | 認購截止 | 定时（页面给了时刻）或全天 | 页面「認購截止時間」列 |
 * | 公布結果 | 全天 | 页面「公布結果」列 |
 * | 暗盤 | 定时，默认 16:15–18:30 | 页面「暗盤時間」列，缺失时推导 |
 * | 上市 | 全天 | 页面「上市」列 |
 *
 * 一只票产四个事件而不是一个跨天事件：它们是**四件要分别做的事**——今天下午三点前
 * 要下单、后天晚上暗盘能挂、周一开盘。压成一条跨天块的话，日历上只会看到一根横条，
 * 反而看不出哪天该干什么。`externalId` 用 `<代码>:<时点>` 拼，见契约 §5.1.1。
 *
 * ## 忙闲一律 free
 *
 * 这些是**信息提示**，不是占用你时间的会议。标成 busy 会把接下来一周的忙闲视图
 * 全涂满，忙闲就没有意义了。
 *
 * ## 暗盘时间为什么要推导
 *
 * 暗盘（Grey Market）不是港交所盘内交易，而是券商在上市前一晚撮合的场外交易，
 * 时间固定在上市日**前一个港股交易日** 16:15–18:30。页面的「暗盤時間」列大多数
 * 时候是 `--`（券商开放前不填），只用上游值等于绝大部分时候没有暗盘提醒。
 *
 * 但插件里没有港股交易日历（那需要农历库算农历节日，与「零运行时依赖」冲突），
 * 所以推导只做到「前一个非周末日」，并允许用户在设置里补公众假期。
 * **推导出来的事件会在标题与来源字段里明确标注**——一个推导错的暗盘时间比没有更糟，
 * 用户得知道这个值需要跟券商公告核对。
 */

import type { ExternalDetailField, ExternalEvent } from "../sdk/index.mjs";

import type { IpoRow } from "./parse.mjs";

/** 要生成哪些时点。设置面板上是一个多选。 */
export type Milestone = "applyEnd" | "result" | "darkPool" | "listing";

export const ALL_MILESTONES: Milestone[] = [
  "applyEnd",
  "result",
  "darkPool",
  "listing",
];

/** 暗盘日期的来历。进展示字段，让用户知道这个值可不可信。 */
export type DarkPoolSource = "upstream" | "derived";

export interface MappingOptions {
  /** 生成哪些时点。 */
  milestones: Milestone[];
  /** 暗盘时段，`HH:mm-HH:mm`。 */
  darkPoolWindow: string;
  /** 额外的港股休市日 `YYYY-MM-DD`，参与暗盘推导时跳过。 */
  holidays: Set<string>;
  /** 外部日历的 externalId，事件都挂在它下面。 */
  calendarExternalId: string;
  /** 原始页面地址，进 `externalUrl`。 */
  sourceUrl: string;
  /** 港股时区偏移，固定 `+08:00`；留成参数只为测试好写。 */
  utcOffset?: string;
}

const HK_OFFSET = "+08:00";
const DEFAULT_DARK_POOL_WINDOW = "16:15-18:30";
const WINDOW_PATTERN = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

/** 认购截止没给时刻时，按港股惯例的截单时间兜一个。 */
const APPLY_END_FALLBACK_TIME = "12:00";

/** 认购截止事件的时长（分钟）。它是一个时刻，给个短块让它在时间轴上看得见。 */
const APPLY_END_DURATION_MINUTES = 30;

export function parseWindow(
  value: string | undefined,
): { start: string; end: string } | null {
  const matched = String(value || "").trim().match(WINDOW_PATTERN);
  if (!matched) return null;
  const pad = (raw: string) => raw.padStart(2, "0");
  const start = `${pad(matched[1] ?? "")}:${matched[2]}`;
  const end = `${pad(matched[3] ?? "")}:${matched[4]}`;
  return end > start ? { start, end } : null;
}

/** `YYYY-MM-DD` 加减天数。用 UTC 运算避免本机时区把日期挪走。 */
export function shiftDate(date: string, days: number): string {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(time)) return date;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}

/** 全天事件的右开结束日：只占一天就是次日。 */
function exclusiveEnd(date: string): string {
  return shiftDate(date, 1);
}

function isWeekend(date: string): boolean {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * 上市日之前最近的一个「可交易日」。
 *
 * 只排除周末与用户配置的休市日——**不认公众假期**（见文件头）。
 * 最多往回找 14 天，找不到就退回上市日前一天：宁可给个明显偏早的日期，
 * 也不要返回上市日当天（那一定是错的，暗盘在上市前）。
 */
export function previousTradingDay(
  listedDate: string,
  holidays: Set<string>,
): string {
  let cursor = shiftDate(listedDate, -1);
  for (let step = 0; step < 14; step += 1) {
    if (!isWeekend(cursor) && !holidays.has(cursor)) return cursor;
    cursor = shiftDate(cursor, -1);
  }
  return shiftDate(listedDate, -1);
}

function timestamp(date: string, time: string, offset: string): string {
  return `${date}T${time}:00${offset}`;
}

function addMinutes(time: string, minutes: number): string {
  const [hourRaw, minuteRaw] = time.split(":");
  const total = Number(hourRaw) * 60 + Number(minuteRaw) + minutes;
  // 不跨天：认购截止如果落在 23:45，加半小时会溢出到次日，那要改成全天事件才对；
  // 这里直接压到 23:59 而不是溢出，保证 endAt 仍在同一天且晚于 startAt
  const clamped = Math.min(total, 23 * 60 + 59);
  const hour = String(Math.floor(clamped / 60)).padStart(2, "0");
  const minute = String(clamped % 60).padStart(2, "0");
  return `${hour}:${minute}`;
}

/** 展示字段：一只票的公共信息，四个事件都带上，方便在任一事件里看全貌。 */
function commonDetails(row: IpoRow): ExternalDetailField[] {
  const fields: ExternalDetailField[] = [
    { label: "股票代码", value: row.stockCode },
    { label: "上市日", value: row.listedDate },
  ];
  if (row.applyEndAt) fields.push({ label: "认购截止", value: row.applyEndAt });
  if (row.resultDate) fields.push({ label: "公布结果", value: row.resultDate });
  return fields;
}

/**
 * 认购截止事件。
 *
 * 页面给了时刻就做成定时事件（这是一条真正有截止时刻的事），
 * 只给日期时也做成定时事件但用兜底时刻——做成全天会让「今天几点前要下单」这个
 * 最关键的信息消失。
 */
function applyEndEvent(row: IpoRow, options: MappingOptions): ExternalEvent | null {
  if (!row.applyEndAt) return null;
  const offset = options.utcOffset ?? HK_OFFSET;
  const [datePart, timePart] = row.applyEndAt.split(/\s+/);
  if (!datePart) return null;
  const start = timePart ?? APPLY_END_FALLBACK_TIME;
  const details = commonDetails(row);
  if (!timePart) {
    details.push({
      label: "提示",
      value: `页面只给了日期，时刻按 ${APPLY_END_FALLBACK_TIME} 估算，请以券商公告为准`,
    });
  }
  return {
    externalId: `${row.stockCode}:apply-end`,
    calendarExternalId: options.calendarExternalId,
    externalUrl: options.sourceUrl,
    title: `认购截止 ${row.stockCode} ${row.stockName}`,
    notes: `${row.stockName}（${row.stockCode}）认购截止，上市日 ${row.listedDate}。`,
    allDay: false,
    startAt: timestamp(datePart, start, offset),
    endAt: timestamp(datePart, addMinutes(start, APPLY_END_DURATION_MINUTES), offset),
    busyStatus: "free",
    isOrganizer: false,
    remoteData: row,
    details,
  };
}

/** 公布结果：只有日期，做成全天。 */
function resultEvent(row: IpoRow, options: MappingOptions): ExternalEvent | null {
  if (!row.resultDate) return null;
  return {
    externalId: `${row.stockCode}:result`,
    calendarExternalId: options.calendarExternalId,
    externalUrl: options.sourceUrl,
    title: `公布结果 ${row.stockCode} ${row.stockName}`,
    notes: `${row.stockName}（${row.stockCode}）公布中签结果，上市日 ${row.listedDate}。`,
    allDay: true,
    startDate: row.resultDate,
    endDate: exclusiveEnd(row.resultDate),
    busyStatus: "free",
    isOrganizer: false,
    remoteData: row,
    details: commonDetails(row),
  };
}

/**
 * 暗盘：定时事件，时段来自设置。
 *
 * 标题把时间写在股票名之前——日历格子窄的时候先截掉的是名字，
 * 而 `16:15-18:30` 是这条事件最不能丢的信息。
 */
function darkPoolEvent(row: IpoRow, options: MappingOptions): ExternalEvent | null {
  const offset = options.utcOffset ?? HK_OFFSET;
  const window =
    parseWindow(row.darkPoolWindow ?? undefined) ??
    parseWindow(options.darkPoolWindow) ??
    parseWindow(DEFAULT_DARK_POOL_WINDOW);
  if (!window) return null;

  const source: DarkPoolSource = row.darkPoolDate ? "upstream" : "derived";
  const date = row.darkPoolDate ?? previousTradingDay(row.listedDate, options.holidays);

  const details = commonDetails(row);
  details.push({
    label: "暗盘时间来源",
    value:
      source === "upstream"
        ? `来自页面（${row.darkPoolRaw ?? "已给出"}）`
        : "推导值：上市日前一个非周末日，请以券商公告为准",
  });

  return {
    externalId: `${row.stockCode}:dark-pool`,
    calendarExternalId: options.calendarExternalId,
    externalUrl: options.sourceUrl,
    // 推导值在标题上就标出来，别让人照着一个猜的时间去挂单
    title: `暗盘 ${window.start}-${window.end} ${row.stockCode} ${row.stockName}${
      source === "derived" ? "（推导）" : ""
    }`,
    notes: `${row.stockName}（${row.stockCode}）暗盘交易，次一交易日 ${row.listedDate} 上市。暗盘是券商场外撮合，不是港交所盘内交易。`,
    allDay: false,
    startAt: timestamp(date, window.start, offset),
    endAt: timestamp(date, window.end, offset),
    location: "券商暗盘",
    busyStatus: "free",
    isOrganizer: false,
    remoteData: { ...row, darkPoolResolvedDate: date, darkPoolSource: source },
    details,
  };
}

/** 上市：只有日期，做成全天。 */
function listingEvent(row: IpoRow, options: MappingOptions): ExternalEvent {
  return {
    externalId: `${row.stockCode}:listing`,
    calendarExternalId: options.calendarExternalId,
    externalUrl: options.sourceUrl,
    title: `港新上市 ${row.stockCode} ${row.stockName}`,
    notes: `${row.stockName}（${row.stockCode}）今日于港交所上市。`,
    allDay: true,
    startDate: row.listedDate,
    endDate: exclusiveEnd(row.listedDate),
    busyStatus: "free",
    isOrganizer: false,
    remoteData: row,
    details: commonDetails(row),
  };
}

/** 把一批 IPO 行映射成事件。顺序按时间先后，方便日志里对照。 */
export function mapEvents(rows: IpoRow[], options: MappingOptions): ExternalEvent[] {
  const wanted = new Set(options.milestones);
  const events: ExternalEvent[] = [];

  for (const row of rows) {
    const candidates: Array<[Milestone, ExternalEvent | null]> = [
      ["applyEnd", wanted.has("applyEnd") ? applyEndEvent(row, options) : null],
      ["result", wanted.has("result") ? resultEvent(row, options) : null],
      ["darkPool", wanted.has("darkPool") ? darkPoolEvent(row, options) : null],
      ["listing", wanted.has("listing") ? listingEvent(row, options) : null],
    ];
    for (const [, event] of candidates) {
      if (event) events.push(event);
    }
  }

  return events;
}

/**
 * 是不是一个**真实存在**的 `YYYY-MM-DD`。
 *
 * 只用正则不够：`2026-13-99` 形状合法但月份和日都不存在。放进休市日集合虽然不会
 * 崩，但它永远匹配不到任何真实日期——用户会以为假期配置生效了，直到某次暗盘
 * 推错日子才发现。所以做一次 Date 往返比对。
 */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** 解析设置里逗号 / 空白分隔的日期列表。非法项静默丢弃，不让一个错字挡住同步。 */
export function parseHolidays(raw: unknown): Set<string> {
  if (typeof raw !== "string" || !raw.trim()) return new Set();
  const dates = raw
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter((item) => isCalendarDate(item));
  return new Set(dates);
}
