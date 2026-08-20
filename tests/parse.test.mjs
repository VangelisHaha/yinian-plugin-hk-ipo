import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  looksLikeIpoPage,
  parseDarkPoolCell,
  parseIpoRows,
} from "../dist/ipo/parse.mjs";

/**
 * 造一段和真实页面同构的 HTML。
 *
 * 关键点：两段的表头**第 8 列语义不同**（可認購是認購截止，待上市是暗盤），
 * 解析器必须按表头定位而不是按下标猜。
 */
function page({ subscribing = "", pendingListed = "" } = {}) {
  const subscribingHead = `
    <thead><tr>
      <th>股票代碼</th><th>股票名稱</th><th>招股價</th><th>入場費</th>
      <th>每手股數</th><th>保薦人</th><th>公布結果</th><th>認購截止時間</th>
      <th>上市日期</th>
    </tr></thead>`;
  const pendingHead = `
    <thead><tr>
      <th>股票代碼</th><th>股票名稱</th><th>招股價</th><th>入場費</th>
      <th>每手股數</th><th>保薦人</th><th>公布結果</th><th>暗盤時間</th>
      <th>上市日期</th>
    </tr></thead>`;

  return `
    <div>
      <h3>可認購</h3>
      ${subscribing ? `<table>${subscribingHead}<tbody>${subscribing}</tbody></table>` : "<!---->"}
      <h3>待上市</h3>
      ${pendingListed ? `<table>${pendingHead}<tbody>${pendingListed}</tbody></table>` : "<!---->"}
      <h3>已遞表</h3>
      <table><thead><tr><th>股票名稱</th><th>遞表日期</th></tr></thead>
        <tbody><tr><td>某某公司</td><td>2026-07-01</td></tr></tbody></table>
    </div>`;
}

const row = (cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;

describe("港股新股页面解析", () => {
  it("按表头定位列，两段的第 8 列语义不会串", () => {
    const html = page({
      subscribing: row([
        "02261",
        "拿森科技",
        "10.00",
        "5050.4",
        "500",
        "某某證券",
        "2026-08-18",
        "2026-08-14 12:00",
        "2026-08-20",
      ]),
      pendingListed: row([
        "02262",
        "另一家",
        "8.00",
        "4040.4",
        "500",
        "某某證券",
        "2026-08-19",
        "2026-08-21 16:15-18:30",
        "2026-08-22",
      ]),
    });

    const rows = parseIpoRows(html);
    assert.equal(rows.length, 2);

    const [first, second] = rows;
    assert.equal(first.phase, "subscribing");
    assert.equal(first.applyEndAt, "2026-08-14 12:00");
    assert.equal(first.darkPoolDate, null, "可認購段第 8 列是认购截止，不该被当成暗盘");

    assert.equal(second.phase, "pending-listed");
    assert.equal(second.applyEndAt, null, "待上市段没有认购截止列");
    assert.equal(second.darkPoolDate, "2026-08-21");
    assert.equal(second.darkPoolWindow, "16:15-18:30");
  });

  it("可認購为空时不会串到待上市那张表", () => {
    const html = page({
      pendingListed: row([
        "02262",
        "另一家",
        "8.00",
        "4040.4",
        "500",
        "某某證券",
        "2026-08-19",
        "2026-08-21 16:15-18:30",
        "2026-08-22",
      ]),
    });

    const rows = parseIpoRows(html);
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].applyEndAt,
      null,
      "这是 nikou-screen 修过的历史 bug：暗盘时间被当成认购截止写库",
    );
    assert.equal(rows[0].darkPoolDate, "2026-08-21");
  });

  it("已遞表段不采（没有上市日期）", () => {
    const rows = parseIpoRows(page());
    assert.equal(rows.length, 0);
  });

  it("同一只票出现在两段时以先出现的段为准", () => {
    const cells = (phase) => [
      "02261",
      `拿森科技-${phase}`,
      "10.00",
      "5050.4",
      "500",
      "某某證券",
      "2026-08-18",
      "2026-08-14 12:00",
      "2026-08-20",
    ];
    const rows = parseIpoRows(
      page({ subscribing: row(cells("a")), pendingListed: row(cells("b")) }),
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].phase, "subscribing");
  });

  it("缺上市日期或缺代码的行被丢掉", () => {
    const html = page({
      subscribing: [
        row(["", "无代码", "1", "1", "1", "x", "2026-08-18", "2026-08-14", "2026-08-20"]),
        row(["02263", "无上市日", "1", "1", "1", "x", "2026-08-18", "2026-08-14", "--"]),
        row(["02264", "正常", "1", "1", "1", "x", "2026-08-18", "2026-08-14", "2026-08-20"]),
      ].join(""),
    });
    const rows = parseIpoRows(html);
    assert.deepEqual(
      rows.map((item) => item.stockCode),
      ["02264"],
    );
  });

  it("股票名里的营销文案被去掉", () => {
    const rows = parseIpoRows(
      page({
        subscribing: row([
          "02261",
          "拿森科技最大20倍槓杆融資",
          "1",
          "1",
          "1",
          "x",
          "2026-08-18",
          "2026-08-14",
          "2026-08-20",
        ]),
      }),
    );
    assert.equal(rows[0].stockName, "拿森科技");
  });

  it("识别得出这不是新股页面", () => {
    assert.equal(looksLikeIpoPage("<html>请先登录</html>"), false);
    assert.equal(looksLikeIpoPage(page()), true);
  });
});

describe("暗盘单元格", () => {
  it("完整日期加时段", () => {
    const parsed = parseDarkPoolCell("2026-08-06 16:15-18:30", "2026-08-07");
    assert.deepEqual(parsed, {
      date: "2026-08-06",
      window: "16:15-18:30",
      raw: "2026-08-06 16:15-18:30",
    });
  });

  it("只有月日时按上市日补年份", () => {
    const parsed = parseDarkPoolCell("08-06 16:15", "2026-08-07");
    assert.equal(parsed.date, "2026-08-06");
    assert.equal(parsed.window, "16:15");
  });

  it("跨年时年份回退一年", () => {
    const parsed = parseDarkPoolCell("12-31 16:15-18:30", "2027-01-04");
    assert.equal(
      parsed.date,
      "2026-12-31",
      "暗盘永远在上市日之前，12 月暗盘配 1 月上市要回退一年",
    );
  });

  it("空值与占位符不产生日期", () => {
    for (const raw of ["", "--", "—", undefined]) {
      assert.deepEqual(parseDarkPoolCell(raw, "2026-08-20"), {
        date: null,
        window: null,
        raw: null,
      });
    }
  });
});
