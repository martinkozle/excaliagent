import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktop } from "./desktop.ts";
import type { Exec } from "./exec.ts";
import { createProcessTable } from "./process-table.ts";

const quiet = () => {};

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

/** Fake /proc with only <pid>/stat; tree is pid → [comm, ppid]. */
function fakeProc(tree: Record<number, [string, number]>): string {
  const root = mkdtempSync(join(tmpdir(), "proc-"));
  roots.push(root);
  for (const [pid, [comm, ppid]] of Object.entries(tree)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, "stat"), `${pid} (${comm}) S ${ppid} ${pid} ${pid} 34816 ${pid} 4194560 1 2 3\n`);
  }
  return root;
}

// herdr client 8000 → zsh 7010 → kitty 7000 (a window) → compositor 2000 → init 1
const TREE: Record<number, [string, number]> = {
  8000: ["herdr", 7010],
  7010: ["zsh", 7000],
  7000: [".kitty-wrapped", 2000],
  2000: ["Hyprland", 1],
  1: ["systemd", 0],
  9000: ["herdr", 1], // a client with no window ancestor
};

interface Call {
  file: string;
  args: string[];
}

function fakeExec(responses: Record<string, string | Error>): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = async (file, args, opts) => {
    calls.push({ file, args });
    expect(opts.timeout).toBeGreaterThan(0);
    const r = responses[[file, ...args].join(" ")];
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error(`unexpected exec ${file} ${args.join(" ")}`);
    return { stdout: r };
  };
  return { exec, calls };
}

const HYPR_CLIENTS = JSON.stringify([
  { pid: 5555, address: "0xaaa", class: "firefox" },
  { pid: 7000, address: "0xbbb", class: "kitty" },
]);

describe("createDesktop on Hyprland", () => {
  const env = { HYPRLAND_INSTANCE_SIGNATURE: "abc" };

  it("focuses the window owned by the nearest ancestor of a client pid", async () => {
    const procRoot = fakeProc(TREE);
    const { exec, calls } = fakeExec({
      "hyprctl clients -j": HYPR_CLIENTS,
      "hyprctl dispatch focuswindow address:0xbbb": "ok\n",
    });
    expect(await createDesktop({ platform: "linux", env, exec, procRoot }).raise([9000, 8000])).toBe(true);
    expect(calls).toEqual([
      { file: "hyprctl", args: ["clients", "-j"] },
      { file: "hyprctl", args: ["dispatch", "focuswindow", "address:0xbbb"] },
    ]);
  });

  it("returns false without dispatching when no ancestor is a window", async () => {
    const procRoot = fakeProc(TREE);
    const { exec, calls } = fakeExec({ "hyprctl clients -j": HYPR_CLIENTS });
    expect(await createDesktop({ platform: "linux", env, exec, procRoot }).raise([9000])).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("returns false for no pids without running anything", async () => {
    const { exec, calls } = fakeExec({});
    expect(await createDesktop({ platform: "linux", env, exec, procRoot: fakeProc(TREE) }).raise([])).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fails soft when hyprctl fails or prints garbage", async () => {
    const procRoot = fakeProc(TREE);
    const failing = fakeExec({ "hyprctl clients -j": new Error("ENOENT") });
    expect(await createDesktop({ platform: "linux", env, exec: failing.exec, procRoot }).raise([8000])).toBe(false);
    const garbage = fakeExec({ "hyprctl clients -j": "not json" });
    expect(await createDesktop({ platform: "linux", env, exec: garbage.exec, procRoot }).raise([8000])).toBe(false);
    const dispatchFails = fakeExec({
      "hyprctl clients -j": HYPR_CLIENTS,
      "hyprctl dispatch focuswindow address:0xbbb": new Error("exit 1"),
    });
    expect(await createDesktop({ platform: "linux", env, exec: dispatchFails.exec, procRoot }).raise([8000])).toBe(false);
  });

  it("survives a ppid cycle in /proc", async () => {
    const procRoot = fakeProc({ 10: ["a", 11], 11: ["b", 10] });
    const { exec } = fakeExec({ "hyprctl clients -j": HYPR_CLIENTS });
    expect(await createDesktop({ platform: "linux", env, exec, procRoot }).raise([10])).toBe(false);
  });
});

describe("createDesktop on Sway", () => {
  const env = { SWAYSOCK: "/run/user/1000/sway-ipc.sock" };
  const tree = JSON.stringify({
    id: 1,
    nodes: [
      {
        id: 2,
        nodes: [{ id: 3, pid: 5555, nodes: [], floating_nodes: [] }],
        floating_nodes: [{ id: 4, pid: 7000, nodes: [], floating_nodes: [] }],
      },
    ],
    floating_nodes: [],
  });

  it("finds the window pid in the tree (incl. floating) and focuses it by pid", async () => {
    const procRoot = fakeProc(TREE);
    const { exec, calls } = fakeExec({ "swaymsg -t get_tree": tree, "swaymsg [pid=7000] focus": "[{\"success\":true}]" });
    expect(await createDesktop({ platform: "linux", env, exec, procRoot }).raise([8000])).toBe(true);
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual(["swaymsg -t get_tree", "swaymsg [pid=7000] focus"]);
  });
});

describe("createDesktop on macOS (unverified on real hardware)", () => {
  // herdr client 800 → -zsh 710 → login 705 → terminal app 700 → launchd 1
  const ps = (app: string) =>
    [
      "    1     0 /sbin/launchd",
      `  700     1 ${app}`,
      "  705   700 /usr/bin/login",
      "  710   705 -zsh",
      "  800   710 /opt/homebrew/bin/herdr",
      "  900     1 /opt/homebrew/bin/herdr",
    ].join("\n") + "\n";
  const LIST = "ps -axww -o pid=,ppid=,comm=";
  const mac = (exec: Exec) => createDesktop({ platform: "darwin", env: {}, exec, log: quiet, table: createProcessTable({ platform: "darwin", exec, log: quiet }) });

  it("activates the .app bundle of the nearest ancestor with open -a", async () => {
    const { exec, calls } = fakeExec({
      [LIST]: ps("/Applications/kitty.app/Contents/MacOS/kitty"),
      "open -a /Applications/kitty.app": "",
    });
    expect(await mac(exec).raise([900, 800])).toBe(true);
    expect(calls.map((c) => [c.file, ...c.args])).toContainEqual(["open", "-a", "/Applications/kitty.app"]);
  });

  it("keeps spaces in the bundle path and takes the outermost .app", async () => {
    const { exec, calls } = fakeExec({
      [LIST]: ps("/Applications/My Term.app/Contents/Frameworks/Helper.app/Contents/MacOS/My Term"),
      "open -a /Applications/My Term.app": "",
    });
    expect(await mac(exec).raise([800])).toBe(true);
    expect(calls.at(-1)).toEqual({ file: "open", args: ["-a", "/Applications/My Term.app"] });
  });

  it("is a no-op when no ancestor runs from an .app bundle", async () => {
    const { exec, calls } = fakeExec({ [LIST]: ps("/usr/local/bin/alacritty") });
    expect(await mac(exec).raise([800])).toBe(false);
    expect(calls.some((c) => c.file === "open")).toBe(false);
  });

  it("fails soft when open fails, and ignores Hyprland/Sway env on darwin", async () => {
    const { exec } = fakeExec({
      [LIST]: ps("/Applications/kitty.app/Contents/MacOS/kitty"),
      "open -a /Applications/kitty.app": new Error("exit 1"),
    });
    const d = createDesktop({ platform: "darwin", env: { HYPRLAND_INSTANCE_SIGNATURE: "x" }, exec, log: quiet, table: createProcessTable({ platform: "darwin", exec, log: quiet }) });
    expect(await d.raise([800])).toBe(false);
  });
});

describe("createDesktop on macOS logs failures once, for debugging from the terminal", () => {
  const LIST = "ps -axww -o pid=,ppid=,comm=";
  const PS = ["    1     0 /sbin/launchd", "  700     1 /usr/local/bin/alacritty", "  710   700 -zsh", "  800   710 /opt/homebrew/bin/herdr"].join("\n");

  function setup(responses: Record<string, string | Error>) {
    const { exec, calls } = fakeExec(responses);
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    const d = createDesktop({ platform: "darwin", env: {}, exec, log, table: createProcessTable({ platform: "darwin", exec, log }) });
    return { d, logs, calls };
  }

  it("no .app ancestor: logs the chain of executables once", async () => {
    const { d, logs } = setup({ [LIST]: PS });
    expect(await d.raise([800])).toBe(false);
    expect(await d.raise([800])).toBe(false);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/no \.app/);
    expect(logs[0]).toContain("/usr/local/bin/alacritty");
    expect(logs[0]).toContain("800");
  });

  it("open -a failure: logs the command and its stderr once", async () => {
    const err = Object.assign(new Error("Command failed: open -a /Applications/kitty.app"), {
      stderr: "LSOpenURLsWithRole() failed with error -600\n",
    });
    const { d, logs } = setup({
      [LIST]: PS.replace("/usr/local/bin/alacritty", "/Applications/kitty.app/Contents/MacOS/kitty"),
      "open -a /Applications/kitty.app": err,
    });
    expect(await d.raise([800])).toBe(false);
    expect(await d.raise([800])).toBe(false);
    expect(logs).toEqual([expect.stringContaining("open -a /Applications/kitty.app")]);
    expect(logs[0]).toContain("LSOpenURLsWithRole() failed with error -600");
  });

  it("ps failure and no herdr client are logged once each", async () => {
    const { d, logs } = setup({ [LIST]: Object.assign(new Error("spawn ps ENOENT"), { stderr: "" }) });
    expect(await d.raise([800])).toBe(false);
    expect(await d.raise([])).toBe(false);
    expect(await d.raise([])).toBe(false);
    expect(logs.some((l) => l.includes("ps -axww -o pid=,ppid=,comm=") && l.includes("ENOENT"))).toBe(true);
    expect(logs.filter((l) => /no herdr client/.test(l))).toHaveLength(1);
  });
});

describe("createDesktop kind", () => {
  it("reports which raise strategy is active", () => {
    const k = (platform: NodeJS.Platform, env: Record<string, string>) => createDesktop({ platform, env, log: quiet }).kind;
    expect(k("linux", { HYPRLAND_INSTANCE_SIGNATURE: "x", SWAYSOCK: "y" })).toBe("hyprland");
    expect(k("linux", { SWAYSOCK: "y" })).toBe("sway");
    expect(k("linux", {})).toBe("none");
    expect(k("darwin", { SWAYSOCK: "y" })).toBe("macos");
    expect(k("win32", {})).toBe("none");
  });
});

describe("createDesktop elsewhere", () => {
  it("is a no-op returning false on Linux without Hyprland/Sway and on other platforms", async () => {
    const { exec, calls } = fakeExec({});
    expect(await createDesktop({ platform: "linux", env: {}, exec, procRoot: fakeProc(TREE) }).raise([8000])).toBe(false);
    expect(await createDesktop({ platform: "win32", env: { SWAYSOCK: "x" }, exec }).raise([8000])).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
