import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDesktop, parentPid, type Exec } from "./desktop.ts";

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

describe("parentPid", () => {
  it("reads ppid even when comm has spaces and parentheses", async () => {
    const procRoot = fakeProc({ 42: ["weird ) (name", 41] });
    expect(await parentPid(procRoot, 42)).toBe(41);
    expect(await parentPid(procRoot, 43)).toBeUndefined();
  });
});

describe("createDesktop on Hyprland", () => {
  const env = { HYPRLAND_INSTANCE_SIGNATURE: "abc" };

  it("focuses the window owned by the nearest ancestor of a client pid", async () => {
    const procRoot = fakeProc(TREE);
    const { exec, calls } = fakeExec({
      "hyprctl clients -j": HYPR_CLIENTS,
      "hyprctl dispatch focuswindow address:0xbbb": "ok\n",
    });
    expect(await createDesktop({ env, exec, procRoot }).raise([9000, 8000])).toBe(true);
    expect(calls).toEqual([
      { file: "hyprctl", args: ["clients", "-j"] },
      { file: "hyprctl", args: ["dispatch", "focuswindow", "address:0xbbb"] },
    ]);
  });

  it("returns false without dispatching when no ancestor is a window", async () => {
    const procRoot = fakeProc(TREE);
    const { exec, calls } = fakeExec({ "hyprctl clients -j": HYPR_CLIENTS });
    expect(await createDesktop({ env, exec, procRoot }).raise([9000])).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("returns false for no pids without running anything", async () => {
    const { exec, calls } = fakeExec({});
    expect(await createDesktop({ env, exec, procRoot: fakeProc(TREE) }).raise([])).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fails soft when hyprctl fails or prints garbage", async () => {
    const procRoot = fakeProc(TREE);
    const failing = fakeExec({ "hyprctl clients -j": new Error("ENOENT") });
    expect(await createDesktop({ env, exec: failing.exec, procRoot }).raise([8000])).toBe(false);
    const garbage = fakeExec({ "hyprctl clients -j": "not json" });
    expect(await createDesktop({ env, exec: garbage.exec, procRoot }).raise([8000])).toBe(false);
    const dispatchFails = fakeExec({
      "hyprctl clients -j": HYPR_CLIENTS,
      "hyprctl dispatch focuswindow address:0xbbb": new Error("exit 1"),
    });
    expect(await createDesktop({ env, exec: dispatchFails.exec, procRoot }).raise([8000])).toBe(false);
  });

  it("survives a ppid cycle in /proc", async () => {
    const procRoot = fakeProc({ 10: ["a", 11], 11: ["b", 10] });
    const { exec } = fakeExec({ "hyprctl clients -j": HYPR_CLIENTS });
    expect(await createDesktop({ env, exec, procRoot }).raise([10])).toBe(false);
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
    expect(await createDesktop({ env, exec, procRoot }).raise([8000])).toBe(true);
    expect(calls.map((c) => [c.file, ...c.args].join(" "))).toEqual(["swaymsg -t get_tree", "swaymsg [pid=7000] focus"]);
  });
});

describe("createDesktop elsewhere", () => {
  it("is a no-op returning false", async () => {
    const { exec, calls } = fakeExec({});
    expect(await createDesktop({ env: {}, exec, procRoot: fakeProc(TREE) }).raise([8000])).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
