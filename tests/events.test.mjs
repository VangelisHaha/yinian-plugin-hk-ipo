import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ALL_MILESTONES,
  isCalendarDate,
  mapEvents,
  parseHolidays,
  parseWindow,
  previousTradingDay,
  shiftDate,
} from "../dist/ipo/events.mjs";
import { diffTracked, settingsFrom } from "../dist/handlers/sync.mjs";

const BASE_ROW = {
  stockCode: "02261",
  stockName: "拿森科技",
  phase: "subscribing",
  listedDate: "2026-08-20",
  applyEndAt: "2026-08-14 12:00",
  resultDate: "2026-08-18",
  darkPoolDate: null,
  darkPoolWindow: null,
  darkPoolRaw: null,
};

const OPTIONS = {
  milestones: ALL_MILESTONES,
  darkPoolWindow: "16:15-18:30",
  holidays: new Set(),
  calendarExternalId: "hk-ipo",
  sourceUrl: "https://example.com/ipo",
};

const byId = (events) => new Map(events.map((event) => [event.externalId, event]));

describe("事件映射", () => {
  it("一只票产四个事件，externalId 带稳定后缀", () => {
    const events = mapEvents([BASE_ROW], OPTIONS);
    assert.deepEqual(
      events.map((event) => event.externalId),
      ["02261:apply-end", "02261:result", "02261:dark-pool", "02261:listing"],
    );
  });

  it("全天事件的结束日右开", () => {
    const events = byId(mapEvents([BASE_ROW], OPTIONS));
    const listing = events.get("02261:listing");
    assert.equal(listing.allDay, true);
    assert.equal(listing.startDate, "2026-08-20");
    assert.equal(
      listing.endDate,
      "2026-08-21",
      "只占一天的全天事件，结束日要写次日，否则宿主判成空区间",
    );
    assert.equal(listing.startAt, undefined);
    assert.equal(listing.endAt, undefined);
  });

  it("定时事件只给时间戳且带港股时区", () => {
    const events = byId(mapEvents([BASE_ROW], OPTIONS));
    const applyEnd = events.get("02261:apply-end");
    assert.equal(applyEnd.allDay, false);
    assert.equal(applyEnd.startAt, "2026-08-14T12:00:00+08:00");
    assert.equal(applyEnd.endAt, "2026-08-14T12:30:00+08:00");
    assert.equal(applyEnd.startDate, undefined);
    assert.equal(applyEnd.endDate, undefined);
  });

  it("所有事件都是 free：信息提示不该把整天标成忙", () => {
    for (const event of mapEvents([BASE_ROW], OPTIONS)) {
      assert.equal(event.busyStatus, "free", event.externalId);
      assert.equal(event.isOrganizer, false, event.externalId);
    }
  });

  it("认购截止只给日期时补兜底时刻并说明", () => {
    const events = byId(
      mapEvents([{ ...BASE_ROW, applyEndAt: "2026-08-14" }], OPTIONS),
    );
    const applyEnd = events.get("02261:apply-end");
    assert.equal(applyEnd.startAt, "2026-08-14T12:00:00+08:00");
    assert.ok(
      applyEnd.details.some((field) => field.value.includes("请以券商公告为准")),
      "估算出来的时刻必须说清楚，否则用户会当成准确截单时间",
    );
  });

  it("认购截止落在深夜时结束时间不跨天", () => {
    const events = byId(
      mapEvents([{ ...BASE_ROW, applyEndAt: "2026-08-14 23:50" }], OPTIONS),
    );
    const applyEnd = events.get("02261:apply-end");
    assert.equal(applyEnd.startAt, "2026-08-14T23:50:00+08:00");
    assert.equal(
      applyEnd.endAt,
      "2026-08-14T23:59:00+08:00",
      "溢出到次日会让 endAt 的日期变掉，宿主那边就成了跨天事件",
    );
    assert.ok(applyEnd.endAt > applyEnd.startAt);
  });

  it("上游给了暗盘日期就用上游，并标明来源", () => {
    const events = byId(
      mapEvents(
        [{ ...BASE_ROW, darkPoolDate: "2026-08-19", darkPoolWindow: "16:00-18:00", darkPoolRaw: "2026-08-19 16:00-18:00" }],
        OPTIONS,
      ),
    );
    const dark = events.get("02261:dark-pool");
    assert.equal(dark.startAt, "2026-08-19T16:00:00+08:00");
    assert.equal(dark.endAt, "2026-08-19T18:00:00+08:00");
    assert.ok(!dark.title.includes("推导"));
    assert.ok(
      dark.details.some((field) => field.value.includes("来自页面")),
      "来源要写清楚",
    );
  });

  it("上游没给暗盘日期时推导，且标题上标出来", () => {
    // 2026-08-20 是周四，前一个非周末日是 08-19
    const events = byId(mapEvents([BASE_ROW], OPTIONS));
    const dark = events.get("02261:dark-pool");
    assert.equal(dark.startAt, "2026-08-19T16:15:00+08:00");
    assert.ok(
      dark.title.includes("（推导）"),
      "推导值必须在标题上就能看出来，别让人照着猜的时间挂单",
    );
    assert.equal(dark.remoteData.darkPoolSource, "derived");
  });

  it("时段写在股票名之前：格子窄时先截名字", () => {
    const events = byId(mapEvents([BASE_ROW], OPTIONS));
    const dark = events.get("02261:dark-pool");
    assert.ok(dark.title.startsWith("暗盘 16:15-18:30"));
  });

  it("只选部分时点时只产对应事件", () => {
    const events = mapEvents([BASE_ROW], { ...OPTIONS, milestones: ["listing"] });
    assert.deepEqual(
      events.map((event) => event.externalId),
      ["02261:listing"],
    );
  });

  it("缺少认购截止或公布结果时不硬造事件", () => {
    const events = mapEvents(
      [{ ...BASE_ROW, applyEndAt: null, resultDate: null }],
      OPTIONS,
    );
    assert.deepEqual(
      events.map((event) => event.externalId),
      ["02261:dark-pool", "02261:listing"],
    );
  });

  it("原始行全量进 remoteData", () => {
    const events = byId(mapEvents([BASE_ROW], OPTIONS));
    assert.equal(events.get("02261:listing").remoteData.stockCode, "02261");
  });
});

describe("暗盘日期推导", () => {
  it("跳过周末", () => {
    // 2026-08-24 是周一，前一个非周末日是 08-21（周五）
    assert.equal(previousTradingDay("2026-08-24", new Set()), "2026-08-21");
  });

  it("跳过用户配置的休市日", () => {
    assert.equal(
      previousTradingDay("2026-08-20", new Set(["2026-08-19", "2026-08-18"])),
      "2026-08-17",
    );
  });

  it("连续找不到时退回上市日前一天而不是当天", () => {
    const allBlocked = new Set(
      Array.from({ length: 20 }, (_, index) => shiftDate("2026-08-20", -(index + 1))),
    );
    const resolved = previousTradingDay("2026-08-20", allBlocked);
    assert.ok(resolved < "2026-08-20", "暗盘一定在上市之前");
  });
});

describe("配置归一化", () => {
  it("时段格式校验", () => {
    assert.deepEqual(parseWindow("16:15-18:30"), { start: "16:15", end: "18:30" });
    assert.deepEqual(parseWindow("9:30-11:00"), { start: "09:30", end: "11:00" });
    assert.equal(parseWindow("18:30-16:15"), null, "结束必须晚于开始");
    assert.equal(parseWindow("乱写"), null);
  });

  it("休市日列表容忍多种分隔符，非法项丢弃", () => {
    const parsed = parseHolidays("2026-10-01, 2026-12-25 2026-13-99，2027-01-01");
    assert.deepEqual(
      [...parsed].sort(),
      ["2026-10-01", "2026-12-25", "2027-01-01"],
      "2026-13-99 形状合法但不是真实日期，留着只会让人误以为假期配置生效了",
    );
  });

  it("形状对但日期不存在的值被判无效", () => {
    assert.equal(isCalendarDate("2026-02-30"), false, "2 月没有 30 号");
    assert.equal(isCalendarDate("2026-13-01"), false);
    assert.equal(isCalendarDate("2026-2-1"), false, "必须补零");
    assert.equal(isCalendarDate("2028-02-29"), true, "闰年的 2-29 是真实日期");
  });

  it("缺省配置有可用默认值", () => {
    const settings = settingsFrom(undefined);
    assert.ok(settings.sourceUrl.startsWith("https://"));
    assert.equal(settings.calendarName, "港股新股");
    assert.deepEqual(settings.milestones, ALL_MILESTONES);
    assert.equal(settings.timeoutMs, 20_000);
  });

  it("超时被夹在合理区间内", () => {
    assert.equal(settingsFrom({ httpTimeoutSeconds: 1 }).timeoutMs, 5_000);
    assert.equal(settingsFrom({ httpTimeoutSeconds: 999 }).timeoutMs, 60_000);
    assert.equal(settingsFrom({ httpTimeoutSeconds: "x" }).timeoutMs, 20_000);
  });

  it("多选项全非法时退回全选", () => {
    assert.deepEqual(settingsFrom({ milestones: ["nope"] }).milestones, ALL_MILESTONES);
    assert.deepEqual(settingsFrom({ milestones: [] }).milestones, ALL_MILESTONES);
  });
});

describe("撤回判定", () => {
  const rows = [BASE_ROW];

  it("上市日已过的票消失时不报删除", () => {
    const { deletedExternalIds } = diffTracked(
      { "02299": "2026-08-01" },
      rows,
      ALL_MILESTONES,
      "2026-08-15",
    );
    assert.deepEqual(
      deletedExternalIds,
      [],
      "上市完成后从页面滚出去是正常的，不是撤回",
    );
  });

  it("上市日未到的票消失时按撤回处理", () => {
    const { deletedExternalIds } = diffTracked(
      { "02299": "2026-08-25" },
      rows,
      ALL_MILESTONES,
      "2026-08-15",
    );
    assert.deepEqual(deletedExternalIds, [
      "02299:apply-end",
      "02299:result",
      "02299:dark-pool",
      "02299:listing",
    ]);
  });

  it("记账只保留本轮见到的票", () => {
    const { tracked } = diffTracked(
      { "02299": "2026-08-01" },
      rows,
      ALL_MILESTONES,
      "2026-08-15",
    );
    assert.deepEqual(tracked, { "02261": "2026-08-20" });
  });

  it("删除 id 的后缀与生成事件时一致", () => {
    const generated = mapEvents([BASE_ROW], OPTIONS).map((event) => event.externalId);
    const { deletedExternalIds } = diffTracked(
      { "02261": "2026-08-20" },
      [],
      ALL_MILESTONES,
      "2026-08-15",
    );
    assert.deepEqual(
      deletedExternalIds.sort(),
      generated.sort(),
      "后缀拼错的话宿主永远找不到要标记的事件",
    );
  });
});
