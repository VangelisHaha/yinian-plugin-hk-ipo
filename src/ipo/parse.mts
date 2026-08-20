/**
 * 港股新股列表解析（华盛证券公开页，Nuxt SSR）。
 *
 * 页面按 `<h3>` 分成三段：可認購 / 待上市 / 已遞表。前两段的表结构相同，
 * **但第 8 列语义不同**：
 *
 * | 段 | 第 8 列 |
 * |---|---|
 * | 可認購 | 認購截止時間 |
 * | 待上市 | **暗盤時間** |
 *
 * 所以必须「按段取表 + 按表头定位列」，两条都不能省：
 *
 * 1. 每个 `<h3>` 只认它后面、下一个 `<h3>` 之前的**第一张** `<table>`。
 *    「可認購」为空时页面渲染成 `<!---->`（连 `tbody` 都没有），
 *    用「`可認購` 之后第一个 `tbody`」的正则会串到「待上市」表，
 *    把暗盘时间当成认购截止时间——这是 `nikou-screen` 修过的历史 bug，别退回去。
 * 2. 列位置读 `<thead>` 的表头文字，页面加列/换列不会再错位。
 *
 * 「已遞表」段列结构不同（没有上市日期），不采。
 *
 * 零依赖：不用浏览器、不用 HTML 解析库，正则够用且这个页面结构稳定。
 */

/** 一段列表对应的阶段。 */
export type IpoPhase = "subscribing" | "pending-listed";

/** 页面段标题 → 阶段。简繁都收。 */
const SECTION_PHASE: Array<{ phase: IpoPhase; titles: string[] }> = [
  { phase: "subscribing", titles: ["可認購", "可认购"] },
  { phase: "pending-listed", titles: ["待上市"] },
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** 解析出来的一只新股。日期都是页面原样的字符串，不在这里换算时区。 */
export interface IpoRow {
  stockCode: string;
  stockName: string;
  phase: IpoPhase;
  /** 上市日 `YYYY-MM-DD`。**必有**，没有的行会被丢掉。 */
  listedDate: string;
  /** 認購截止，`YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`。 */
  applyEndAt: string | null;
  /** 公布結果日 `YYYY-MM-DD`。 */
  resultDate: string | null;
  /** 暗盤日 `YYYY-MM-DD`，页面没给时为 null（大多数时候如此）。 */
  darkPoolDate: string | null;
  /** 暗盤时段 `HH:mm-HH:mm`，页面只给一个时刻时就是那一个。 */
  darkPoolWindow: string | null;
  /** 暗盤单元格原文，进日志与诊断用。 */
  darkPoolRaw: string | null;
}

/** 去标签取文本。`<br>` 当空格，不然两行会粘成一个词。 */
function textOf(html: string): string {
  return String(html || "")
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** 取「日期」或「日期 时刻」，其余文字丢掉。 */
function dateTimeOf(value: string | undefined): string | null {
  return String(value || "").match(/\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?/)?.[0] ?? null;
}

interface Section {
  title: string;
  table: string;
}

/** 把 `<h3>` 切成段，每段只带紧随其后的第一张 table。 */
function sectionsOf(html: string): Section[] {
  const source = String(html || "");
  const heads = Array.from(source.matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>/gi));
  return heads.map((head, index) => {
    const start = (head.index ?? 0) + head[0].length;
    const next = heads[index + 1];
    const end = next ? (next.index ?? source.length) : source.length;
    const body = source.slice(start, end);
    return {
      title: textOf(head[1] ?? ""),
      table: body.match(/<table[\s\S]*?<\/table>/i)?.[0] ?? "",
    };
  });
}

interface ColumnIndex {
  stockCode: number;
  stockName: number;
  applyEndAt: number;
  darkPool: number;
  resultDate: number;
  listedDate: number;
}

/** 表头文字 → 列下标。同一语义列的多种写法（简繁、带单位）都收进来。 */
function columnIndexOf(table: string): ColumnIndex {
  const head = table.match(/<thead[\s\S]*?<\/thead>/i)?.[0] ?? table;
  const heads = Array.from(
    head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi),
    (cell) => textOf(cell[1] ?? ""),
  );
  const find = (...keywords: string[]) =>
    heads.findIndex((text) => keywords.some((keyword) => text.includes(keyword)));
  return {
    stockCode: find("股票代碼", "股票代码", "代碼", "代码"),
    stockName: find("股票名稱", "股票名称", "名稱", "名称"),
    applyEndAt: find("認購截止", "认购截止"),
    darkPool: find("暗盤", "暗盘"),
    resultDate: find("公布結果", "公布结果"),
    // 「上市」要用前缀匹配：「上市日期」「上市」都算，但别撞上「上市地點」之类
    listedDate: heads.findIndex((text) => text === "上市" || text.startsWith("上市")),
  };
}

/**
 * 解析暗盘单元格。
 *
 * 页面在券商开放暗盘前常常只给 `--`，所以这里只负责「有值时读准」；
 * 缺失值的推导是 `events.mts` 的事（要判交易日，属于业务规则）。
 *
 * @param raw 单元格文本，例如 `2026-08-06 16:15-18:30` / `08-06 16:15` / `--`
 * @param listedDate 上市日 `YYYY-MM-DD`，用来给只有月日的值补年份
 */
export function parseDarkPoolCell(
  raw: string | undefined,
  listedDate: string | null,
): { date: string | null; window: string | null; raw: string | null } {
  const text = String(raw || "").trim();
  if (!text || !/\d/.test(text)) return { date: null, window: null, raw: null };

  let date = text.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
  const monthDay = date ? null : text.match(/(?<!\d)(\d{1,2})[-/月](\d{1,2})(?!\d*:)/);
  if (monthDay && listedDate && DATE_PATTERN.test(listedDate)) {
    const year = Number(listedDate.slice(0, 4));
    const month = String(Number(monthDay[1])).padStart(2, "0");
    const day = String(Number(monthDay[2])).padStart(2, "0");
    const guess = `${year}-${month}-${day}`;
    // 暗盘永远在上市日之前；跨年时（12 月暗盘 / 1 月上市）年份要回退一年
    date = guess <= listedDate ? guess : `${year - 1}${guess.slice(4)}`;
  }

  const range = text.match(/(\d{1,2}:\d{2})\s*[-–—~至]\s*(\d{1,2}:\d{2})/);
  const single = range ? null : text.match(/(\d{1,2}:\d{2})/);
  const window = range
    ? `${range[1]}-${range[2]}`
    : single
      ? (single[1] ?? null)
      : null;
  return { date, window, raw: text };
}

/** 名字里夹带的营销文案，展示前去掉。 */
function cleanStockName(value: string): string {
  return value.replace(/最大\d+倍槓杆融資/g, "").replace(/最大\d+倍杠杆融资/g, "").trim();
}

/**
 * 从服务端 HTML 提取「可認購」+「待上市」两段新股。
 *
 * 同一只票同时出现在两段时**以先出现的段为准**（页面上「可認購」在前，
 * 那是更贴近当下的状态）。
 */
export function parseIpoRows(html: string): IpoRow[] {
  const rows: IpoRow[] = [];
  const seen = new Set<string>();

  for (const section of sectionsOf(html)) {
    const matched = SECTION_PHASE.find((item) =>
      item.titles.some((title) => section.title.includes(title)),
    );
    if (!matched || !section.table) continue;

    const column = columnIndexOf(section.table);
    // 代码和上市日是主键与最关键的日期，缺了这一段整个不可用
    if (column.stockCode < 0 || column.listedDate < 0) continue;

    const tbody = section.table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
    for (const tr of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = Array.from(
        (tr[1] ?? "").matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi),
        (cell) => textOf(cell[1] ?? ""),
      );
      const at = (index: number) => (index >= 0 ? cells[index] : undefined);

      const stockCode = at(column.stockCode);
      const stockName = at(column.stockName);
      const listedDate = at(column.listedDate);
      if (!stockCode || !stockName) continue;
      if (!listedDate || !DATE_PATTERN.test(listedDate)) continue;
      if (seen.has(stockCode)) continue;
      seen.add(stockCode);

      const resultDate = at(column.resultDate);
      const darkPool = parseDarkPoolCell(at(column.darkPool), listedDate);
      rows.push({
        stockCode,
        stockName: cleanStockName(stockName),
        phase: matched.phase,
        listedDate,
        applyEndAt: dateTimeOf(at(column.applyEndAt)),
        resultDate: resultDate && DATE_PATTERN.test(resultDate) ? resultDate : null,
        darkPoolDate: darkPool.date,
        darkPoolWindow: darkPool.window,
        darkPoolRaw: darkPool.raw,
      });
    }
  }

  return rows;
}

/** 页面上是否真的有「可認購」这一段。抓到登录页或错误页时用它兜住。 */
export function looksLikeIpoPage(html: string): boolean {
  return /可認購|可认购/.test(html);
}
