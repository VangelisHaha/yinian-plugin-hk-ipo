/**
 * 配置校验与设置面板上的 action。
 *
 * 形状校验（必填、范围、枚举）宿主已经按 schema 做过了，这里只做它做不了的事：
 * 这个地址到底抓不抓得通、页面结构还认不认得、暗盘时段写没写对。
 *
 * 这个插件没有凭据——数据源是公开页。所以「测试连接」的价值不是验证鉴权，
 * 而是**让用户在启用前就看到会同步进来什么**：抓不到页面、页面改版、时段填错，
 * 这三件事都会在这里暴露，而不是等第一次定时同步失败。
 */

import { context } from "../sdk/index.mjs";
import type {
  ActionResult,
  ConfigValidateRequest,
  ConfigValidateResult,
  FieldError,
} from "../sdk/index.mjs";

import { isCalendarDate, parseWindow } from "../ipo/events.mjs";
import { loadRows, settingsFrom } from "./sync.mjs";

export async function validate(
  request: ConfigValidateRequest,
): Promise<ConfigValidateResult> {
  // 插件级只有超时与 UA，宿主的范围校验已经够了
  if (request.scope === "plugin") return { ok: true };

  const errors: FieldError[] = [];
  const settings = settingsFrom(request.config);

  if (!/^https?:\/\//i.test(settings.sourceUrl)) {
    errors.push({ field: "sourceUrl", message: "地址要以 http:// 或 https:// 开头" });
  }
  if (!parseWindow(settings.darkPoolWindow)) {
    errors.push({
      field: "darkPoolWindow",
      message: "暗盘时段要写成 16:15-18:30 这种形式，且结束晚于开始",
    });
  }
  // 休市日里有错字时明确说出来：静默丢弃会让人以为配置生效了
  const holidaysRaw = request.config.holidays;
  if (typeof holidaysRaw === "string" && holidaysRaw.trim()) {
    const items = holidaysRaw.split(/[,，\s]+/).filter(Boolean);
    const bad = items.filter((item) => !isCalendarDate(item));
    if (bad.length > 0) {
      errors.push({
        field: "holidays",
        message: `这些日期无效（要 YYYY-MM-DD 且真实存在）：${bad.join("、")}`,
      });
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  // 形状都对了再真抓一次：地址填错或页面改版必须在启用前暴露
  try {
    await loadRows(settings);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          field: "sourceUrl",
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

/** 「测试数据源」：把抓到的前几只票列出来，比一句「连接正常」有用。 */
export async function testSource(params: {
  config?: Record<string, unknown>;
}): Promise<ActionResult> {
  // 实例级 action 拿不到插件级配置（两级分开存），context().config 是合并后的那份
  const merged = { ...context().config, ...(params.config ?? {}) };
  const settings = settingsFrom(merged);

  if (!parseWindow(settings.darkPoolWindow)) {
    return { message: "先把暗盘时段写成 16:15-18:30 这种形式" };
  }

  try {
    const rows = await loadRows(settings);
    if (rows.length === 0) {
      return {
        message:
          "页面抓通了，但当前没有可认购或待上市的新股。这是正常的业务结果，" +
          "有新股时会自动出现。",
      };
    }
    const preview = rows
      .slice(0, 5)
      .map((row) => {
        const dark = row.darkPoolDate
          ? `暗盘 ${row.darkPoolDate}`
          : "暗盘待定（会按上市日前一个非周末日推导）";
        return `· ${row.stockCode} ${row.stockName}｜上市 ${row.listedDate}｜${dark}`;
      })
      .join("\n");
    const perStock = settings.milestones.length;
    return {
      message:
        `抓到 ${rows.length} 只新股，会生成约 ${rows.length * perStock} 个事件：\n` +
        `${preview}${rows.length > 5 ? `\n… 还有 ${rows.length - 5} 只` : ""}`,
    };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error) };
  }
}
