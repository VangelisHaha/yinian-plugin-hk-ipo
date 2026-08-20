/**
 * 港股新股插件入口。
 *
 * 只做方法名到 handler 的映射。业务在 `handlers/`，数据源细节在 `ipo/`。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { start } from "./sdk/index.mjs";
import * as config from "./handlers/config.mjs";
import * as sync from "./handlers/sync.mjs";

/** 版本只维护在 manifest 一处。 */
function readManifestVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = JSON.parse(
    readFileSync(join(here, "..", "yinian-plugin.json"), "utf8"),
  ) as { version?: string };
  return manifest.version ?? "0.0.0";
}

start({
  version: readManifestVersion(),
  handlers: {
    // event 是 pull-only，没有 sync.push（契约 §5.1.1）
    "sync.pull": sync.pull,
    "config.validate": config.validate,
    "hkIpo.testSource": config.testSource,
  },
});
