import { expect, test } from "bun:test";

test("N5 shadow verification output has a portable default and accepts AS_SHADOW_OUT", async () => {
  const script = await Bun.file(new URL("./mobile-as-shadow.sh", import.meta.url)).text();
  expect(script).not.toContain(".fenjue");
  const assignment = script.split("\n").find(line => line.startsWith("OUT="))!;
  for (const override of ["", "/tmp/custom shadow evidence"]) {
    const result = Bun.spawnSync(["sh", "-c", assignment + '\nprintf "%s" "$OUT"'], {
      env: { ROOT: "/tmp/portable repo", AS_SHADOW_OUT: override },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe(override || "/tmp/portable repo/out/mobile-as-shadow");
  }
});
