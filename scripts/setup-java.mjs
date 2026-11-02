import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import distribution from "./java-distribution.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parent = resolve(root, ".audit-harness/servers");
const destination = resolve(parent, `jdtls-${distribution.version}`);
mkdirSync(parent, { recursive: true });
if (existsSync(resolve(destination, "plugins"))) {
  console.log(`JDT LS ${distribution.version} 已安装：${destination}`);
} else {
  const staging = mkdtempSync(resolve(parent, "download-"));
  try {
    const archive = resolve(staging, "server.tar.gz");
    // An optional local archive still has to match the pinned upstream checksum.
    if (process.argv[2]) {
      const { copyFileSync } = await import("node:fs");
      copyFileSync(resolve(process.argv[2]), archive);
    } else {
      const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
      execFileSync(
        "curl",
        [
          "--fail",
          "--location",
          "--retry",
          "2",
          "--max-time",
          "240",
          ...(proxy ? ["--proxy", proxy] : []),
          distribution.url,
          "--output",
          archive,
        ],
        { stdio: "inherit" },
      );
    }
    const hash = createHash("sha256")
      .update(readFileSync(archive))
      .digest("hex");
    if (hash !== distribution.sha256) throw Error("JDT LS 下载校验失败");
    const extracted = resolve(staging, "extracted");
    mkdirSync(extracted);
    execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    if (!existsSync(resolve(extracted, "plugins")))
      throw Error("无效的 JDT LS 发行包");
    renameSync(extracted, destination);
    console.log(
      `JDT LS ${distribution.version} 安装完成，SHA-256 已验证：${destination}`,
    );
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
console.log(
  "运行服务器需要 JDK 21+；通过 JAVA_HOME 选择运行 JDK。目标项目可使用自己的构建/JDK 配置。",
);
