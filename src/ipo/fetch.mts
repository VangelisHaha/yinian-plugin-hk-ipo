/**
 * 抓华盛证券的港股新股公开页。
 *
 * 用 Node 20 内置的 `fetch`，不 spawn `curl`：manifest 里只声明 `net` 权限就够，
 * 声明 `spawn` 会让安装时的权限清单多一条「执行外部命令」，而用户没法判断那到底
 * 意味着什么。
 *
 * 页面是 Nuxt SSR，首屏 HTML 里就有完整表格，不需要浏览器执行 JS。
 */

/** 装成普通浏览器。默认 UA 会被一些 CDN 直接挡掉。 */
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const DEFAULT_SOURCE_URL =
  "https://www.aul711.com/ipo/hk/v2/ipo-hk-index";

export class FetchError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "http" | "shape",
  ) {
    super(message);
    this.name = "FetchError";
  }
}

export interface FetchOptions {
  url: string;
  timeoutMs: number;
  userAgent?: string;
}

/**
 * 取页面 HTML。
 *
 * 超时用 `AbortSignal.timeout`：没有超时的话一次卡住的请求会一直占着
 * `sync.pull` 的 120 秒预算，最后以 `PLUGIN_RPC_TIMEOUT` 结束并被杀进程——
 * 那比一条「网络超时」的错误难排查得多。
 */
export async function fetchIpoPage(options: FetchOptions): Promise<string> {
  let response: Response;
  try {
    response = await fetch(options.url, {
      headers: {
        "user-agent": options.userAgent?.trim() || DEFAULT_USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "zh-HK,zh;q=0.9,en;q=0.8",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FetchError(`访问 ${options.url} 失败：${reason}`, "network");
  }

  if (!response.ok) {
    throw new FetchError(
      `${options.url} 返回 HTTP ${response.status}`,
      "http",
    );
  }

  const html = await response.text();
  if (!html.trim()) {
    throw new FetchError(`${options.url} 返回了空页面`, "shape");
  }
  return html;
}
