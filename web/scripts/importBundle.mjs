/**
 * Bundle a TS module with esbuild and import it, for the engine check harnesses.
 *
 * The bundle is written to a real file with an inline source map instead of
 * being imported from a `data:` URL: c8 (`pnpm --filter @warp/web coverage`)
 * only understands `file://` scripts, and the source map is what lets it
 * attribute V8 coverage back to the original `.ts` lines. Outside coverage
 * this costs one tiny write+delete per harness.
 *
 * The file goes to the OS temp dir, not `node_modules/.cache`: c8 drops any
 * script under node_modules before it ever applies the source map.
 *
 * The caller passes its own `esbuild` (so a harness can still SKIP cleanly
 * when esbuild is missing) and its usual build options; output settings are
 * forced here so the file location and the source map's relative paths agree.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const outdir = join(tmpdir(), "warp-checks");

export async function importBundle(esbuild, options) {
  const out = await esbuild.build({
    ...options,
    write: false,
    sourcemap: "inline",
    outdir,
    // Unique per process so two harnesses bundling the same entry never collide.
    entryNames: `[name]-${process.pid}`,
  });
  const file = out.outputFiles[0];
  await mkdir(dirname(file.path), { recursive: true });
  await writeFile(file.path, file.text);
  try {
    return await import(pathToFileURL(file.path).href);
  } finally {
    await rm(file.path, { force: true });
  }
}
