/**
 * pi 扩展入口（CLI / `pi install` 用的薄包装）—— 单目录，取环境变量，缺省 `~/.pi/agent/memory`。
 *
 * 这是给"一人一机"的默认形态准备的。**多用户宿主不要用这个文件**：
 * 它在一个进程里只解析一次 dir，所有会话会共用同一个目录。
 * 宿主应按会话调用 `scopedMemory({ dir })`（见 README 用法 A）。
 */
import os from "node:os";
import path from "node:path";
import { scopedMemory } from "../src/index.ts";

/** 空串/纯空白都算未设置（否则 path.join("", …) 会把记忆写到相对路径上）。导出来是为了可测。 */
export function resolveDir(): string {
  const fromEnv = process.env.PI_SCOPED_MEMORY_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), ".pi", "agent", "memory");
}

export default scopedMemory({ dir: resolveDir() });
